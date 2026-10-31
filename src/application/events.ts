import { z } from "zod";

import type { FinancialStore } from "./financial-store.js";
import { encodeCursor, listCursorSchema } from "./query-inputs.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROTATION_MS = 5 * MINUTE;
const MIN_TTL_MS = MINUTE;
const MAX_TTL_MS = 7 * DAY;
/** Subscriptions examined per delivery pass. */
const MAX_DUE_PER_PASS = 25;
// Retry backoff caps at an hour, so where delivery passes run at least hourly
// (the Node host runs one every minute) this tolerates about a day of receiver
// downtime. Without a regular pass, a host retries only when a run or an owner
// write delivers.
const MAX_ATTEMPTS = 24;
const identifier = z.string().min(1).max(512);
const argumentsSchema = z.object({ connectionId: identifier }).strict();

/** Shared by subscription validation and the runtime sender. */
export const MAX_CALLBACK_URL_LENGTH = 2048;

export function isValidCallbackUrl(value: string): boolean {
  if (value.length > MAX_CALLBACK_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.href.length <= MAX_CALLBACK_URL_LENGTH &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const callbackUrlSchema = z
  .string()
  .max(MAX_CALLBACK_URL_LENGTH)
  .url()
  .refine(isValidCallbackUrl);
const secretSchema = z
  .string()
  .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/)
  .refine((value) => {
    try {
      const decoded = atob(value.slice(6));
      return decoded.length >= 24 && decoded.length <= 64;
    } catch {
      return false;
    }
  });
const subscriptionIdentitySchema = z
  .object({
    name: z.literal("changes.available"),
    arguments: argumentsSchema,
    delivery: z
      .object({ mode: z.literal("webhook"), url: callbackUrlSchema })
      .strict(),
  })
  .strict();

export const eventListSchema = z
  .object({ cursor: z.null().optional() })
  .strict();
export const eventSubscribeSchema = subscriptionIdentitySchema
  .extend({
    delivery: subscriptionIdentitySchema.shape.delivery.extend({
      secret: secretSchema,
    }),
    cursor: z.null().optional(),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
  })
  .strict();
export const eventUnsubscribeSchema = subscriptionIdentitySchema;

export interface EventPrincipal {
  ownerId: string;
  clientId: string;
  scopes: readonly string[];
}

export class EventError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class CallbackEndpointError extends EventError {
  constructor(
    readonly reason:
      "timeout" | "challenge_failed" | "invalid_url" | "unreachable",
  ) {
    super(-32015, "Callback endpoint verification failed.");
  }
}

/** A concurrent writer won the subscription generation; its state is authoritative. */
export class SubscriptionConflictError extends EventError {
  constructor() {
    super(-32000, "Subscription changed. Retry the request.");
  }
}

export const eventSubscriptionSchema = z
  .object({
    id: identifier,
    ownerId: identifier,
    clientId: identifier,
    connectionId: identifier,
    url: callbackUrlSchema,
    secret: secretSchema,
    previousSecret: secretSchema.nullable(),
    rotationUntil: z.number().int().nonnegative().nullable(),
    verifiedUntil: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    status: z.enum(["active", "inactive", "failed", "revoked"]),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    pendingBatch: z
      .object({
        through: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        timestamp: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    attempts: z.number().int().min(0).max(MAX_ATTEMPTS),
    nextAttemptAt: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().max(100).nullable(),
  })
  .strict();

export type EventSubscription = z.infer<typeof eventSubscriptionSchema>;

export interface EventSubscriptionStore {
  get(id: string): Promise<EventSubscription | undefined>;
  save(
    value: EventSubscription,
    expectedGeneration: number,
  ): Promise<EventSubscription | undefined>;
  listDue(now: number, limit: number): Promise<EventSubscription[]>;
  latestEventId(connectionId: string): Promise<number>;
}

export interface SignedWebhookInput {
  url: string;
  secret: string;
  previousSecret?: string;
  subscriptionId: string;
  eventId: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface EventServiceDependencies {
  store: EventSubscriptionStore;
  source: Pick<FinancialStore, "getConnection">;
  sendSignedWebhook(input: SignedWebhookInput): Promise<Response>;
  verifyWebhookCallback(input: {
    url: string;
    secret: string;
    subscriptionId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  grantCheck(
    principal: Pick<EventPrincipal, "ownerId" | "clientId">,
  ): Promise<boolean>;
  now?: () => number;
}

const definition = {
  name: "changes.available",
  description:
    "Committed financial, annotation or refresh health changes are available, including imports and posting matches. Pass after to list_events as its cursor to read the new events (highWaterMark is the cursor after the last one); this wake-up is not itself a purchase alert.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(argumentsSchema),
  payloadSchema: z.toJSONSchema(
    z
      .object({
        connectionId: identifier,
        after: listCursorSchema,
        highWaterMark: listCursorSchema,
      })
      .strict(),
  ),
};

function permissionDenied() {
  return new EventError(-32001, "Permission denied.");
}

function requireRead(principal: EventPrincipal) {
  if (
    !principal ||
    !principal.ownerId ||
    !principal.clientId ||
    !principal.scopes.includes("financial:read")
  ) {
    throw permissionDenied();
  }
}

function isSuccessStatus(status: number) {
  return status >= 200 && status < 300;
}

/** Redirects and client errors, except timeouts and rate limits, end delivery. */
function isTerminalStatus(status: number) {
  return status >= 300 && status < 500 && status !== 408 && status !== 429;
}

function retryDelayMs(attempts: number) {
  return Math.min(HOUR, MINUTE * 2 ** (attempts - 1));
}

async function identityId(
  principal: EventPrincipal,
  input: z.infer<typeof subscriptionIdentitySchema>,
) {
  const identity = JSON.stringify([
    principal.ownerId,
    principal.clientId,
    new URL(input.delivery.url).href,
    input.name,
    { connectionId: input.arguments.connectionId },
  ]);
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  return `sub_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Finite webhook operations over the existing financial event feed. */
export function createEventService(dependencies: EventServiceDependencies) {
  const {
    store,
    source,
    grantCheck,
    sendSignedWebhook,
    verifyWebhookCallback,
  } = dependencies;
  const now = dependencies.now ?? Date.now;

  async function save(value: EventSubscription) {
    const result = await store.save(value, value.generation);
    if (!result) {
      throw new SubscriptionConflictError();
    }
    return result;
  }

  async function requireConnection(connectionId: string) {
    if (!(await source.getConnection(connectionId))) {
      throw new EventError(-32602, "Unknown connection.");
    }
  }

  async function list(principal: EventPrincipal, input: unknown = {}) {
    requireRead(principal);
    eventListSchema.parse(input);
    return { events: [definition] };
  }

  async function subscribe(principal: EventPrincipal, input: unknown) {
    requireRead(principal);
    const params = eventSubscribeSchema.parse(input);
    const callbackUrl = new URL(params.delivery.url).href;
    if (!(await grantCheck(principal))) {
      throw permissionDenied();
    }
    await requireConnection(params.arguments.connectionId);
    const id = await identityId(principal, params);
    const existing = await store.get(id);
    const needsVerification =
      !existing ||
      existing.secret !== params.delivery.secret ||
      existing.verifiedUntil <= now();
    if (needsVerification) {
      try {
        await verifyWebhookCallback({
          url: callbackUrl,
          secret: params.delivery.secret,
          subscriptionId: id,
        });
      } catch (error) {
        if (error instanceof CallbackEndpointError) {
          throw error;
        }
        throw new CallbackEndpointError("challenge_failed");
      }
    }
    // Verification can take seconds while delivery advances the same row; renew
    // from its current generation and pending cursor rather than the stale read.
    // Any other concurrent change (creation, unsubscribe or a new secret) wins.
    if (!(await grantCheck(principal))) {
      throw permissionDenied();
    }
    const previous = needsVerification ? await store.get(id) : existing;
    if (
      previous?.secret !== existing?.secret ||
      (previous?.status === "inactive") !== (existing?.status === "inactive")
    ) {
      throw new SubscriptionConflictError();
    }
    const time = now();
    // An unexpired failed delivery still owns its pending sequence. A refresh
    // resumes that sequence; only expired or explicitly stopped subscriptions
    // start from the current high-water mark in this non-replay event contract.
    const continuing =
      previous !== undefined &&
      previous.expiresAt > time &&
      (previous.status === "active" ||
        previous.status === "failed" ||
        previous.status === "revoked");
    const rotated = continuing && previous.secret !== params.delivery.secret;
    const expiresAt =
      time + Math.max(MIN_TTL_MS, Math.min(params.ttlMs ?? DAY, MAX_TTL_MS));
    await save({
      id,
      ownerId: principal.ownerId,
      clientId: principal.clientId,
      connectionId: params.arguments.connectionId,
      url: callbackUrl,
      secret: params.delivery.secret,
      previousSecret: rotated
        ? previous.secret
        : continuing
          ? previous.previousSecret
          : null,
      rotationUntil: rotated
        ? time + ROTATION_MS
        : continuing
          ? previous.rotationUntil
          : null,
      verifiedUntil:
        previous?.secret === params.delivery.secret &&
        previous.verifiedUntil > time
          ? previous.verifiedUntil
          : time + ROTATION_MS,
      expiresAt,
      status: "active",
      cursor: continuing
        ? previous.cursor
        : await store.latestEventId(params.arguments.connectionId),
      pendingBatch: continuing ? previous.pendingBatch : null,
      attempts: 0,
      nextAttemptAt: time,
      generation: previous?.generation ?? 0,
      reason: null,
    });
    return {
      id,
      refreshBefore: new Date(expiresAt).toISOString(),
      cursor: null,
      truncated: false,
    };
  }

  async function unsubscribe(principal: EventPrincipal, input: unknown) {
    requireRead(principal);
    const params = eventUnsubscribeSchema.parse(input);
    const existing = await store.get(await identityId(principal, params));
    if (existing && existing.status !== "inactive") {
      await save({
        ...existing,
        status: "inactive",
        previousSecret: null,
        rotationUntil: null,
        pendingBatch: null,
        reason: "unsubscribed",
      });
    }
    return {};
  }

  function isDue(
    subscription: EventSubscription | undefined,
  ): subscription is EventSubscription {
    return (
      subscription !== undefined &&
      subscription.status === "active" &&
      subscription.expiresAt > now() &&
      subscription.nextAttemptAt <= now()
    );
  }

  /** Sends one pending batch and returns its HTTP status, or 0 when sending failed. */
  async function sendBatch(
    subscription: EventSubscription,
    batch: NonNullable<EventSubscription["pendingBatch"]>,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const eventId = `${subscription.id}_${subscription.cursor}_${batch.through}`;
    let status = 0;
    try {
      const response = await sendSignedWebhook({
        url: subscription.url,
        secret: subscription.secret,
        subscriptionId: subscription.id,
        eventId,
        ...(subscription.previousSecret &&
        (subscription.rotationUntil ?? 0) > now()
          ? { previousSecret: subscription.previousSecret }
          : {}),
        ...(signal ? { signal } : {}),
        body: {
          eventId,
          name: "changes.available",
          timestamp: batch.timestamp,
          data: {
            connectionId: subscription.connectionId,
            after: encodeCursor("event", subscription.cursor),
            highWaterMark: encodeCursor("event", batch.through),
          },
          cursor: null,
        },
      });
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch {
      status = 0;
    }
    return status;
  }

  async function deliver(input: { limit?: number; signal?: AbortSignal } = {}) {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(input.limit ?? 100);
    const result = { sent: 0, acknowledged: 0, failed: 0 };
    const batchSize = Math.min(limit, MAX_DUE_PER_PASS);
    const due = await store.listDue(now(), batchSize);
    const crowded = due.length === batchSize;
    for (const initial of due) {
      if (input.signal?.aborted) {
        break;
      }
      try {
        let subscription = await store.get(initial.id);
        if (!isDue(subscription)) {
          continue;
        }
        const through =
          subscription.pendingBatch?.through ??
          (await store.latestEventId(subscription.connectionId));
        if (through <= subscription.cursor) {
          if (crowded) {
            await save({ ...subscription, nextAttemptAt: now() + MINUTE });
          }
          continue;
        }
        // Persist the boundary before sending: retries retain the same ID/body,
        // even when a new batch commits or the process restarts between attempts.
        if (subscription.pendingBatch === null) {
          subscription = await save({
            ...subscription,
            pendingBatch: { through, timestamp: new Date(now()).toISOString() },
          });
        }
        if (input.signal?.aborted || subscription.expiresAt <= now()) {
          continue;
        }
        // One authorization check, after pending-state persistence and directly
        // before delivery, covers both newly captured batches and retries.
        if (
          !(await grantCheck({
            ownerId: subscription.ownerId,
            clientId: subscription.clientId,
          }))
        ) {
          await save({
            ...subscription,
            status: "revoked",
            reason: "access_revoked",
          });
          continue;
        }
        const batch = subscription.pendingBatch!;
        const status = await sendBatch(subscription, batch, input.signal);
        if (isSuccessStatus(status)) {
          subscription = await save({
            ...subscription,
            cursor: batch.through,
            pendingBatch: null,
            attempts: 0,
            nextAttemptAt: now(),
            reason: null,
          });
          result.sent++;
          result.acknowledged++;
        } else if (!input.signal?.aborted) {
          const attempts = subscription.attempts + 1;
          const terminal = isTerminalStatus(status);
          const exhausted = attempts >= MAX_ATTEMPTS;
          subscription = await save({
            ...subscription,
            attempts,
            status: terminal || exhausted ? "failed" : "active",
            nextAttemptAt: now() + retryDelayMs(attempts),
            reason: terminal
              ? `http_${status}`
              : exhausted
                ? "attempts_exhausted"
                : "retry_pending",
          });
          result.failed++;
        }
        // Quiet subscriptions must move behind other due work too. Otherwise the
        // same first rows can starve later subscriptions on every pass.
        if (
          crowded &&
          subscription.status === "active" &&
          subscription.nextAttemptAt <= now()
        ) {
          await save({ ...subscription, nextAttemptAt: now() + MINUTE });
        }
      } catch (error) {
        // Refresh, unsubscribe and another dispatcher may win this generation.
        // Its durable state remains authoritative; other subscriptions can run.
        if (!(error instanceof SubscriptionConflictError)) {
          throw error;
        }
      }
    }
    return result;
  }

  return { list, subscribe, unsubscribe, deliver };
}

export type EventService = ReturnType<typeof createEventService>;
