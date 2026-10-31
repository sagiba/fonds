import { randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { RefreshStartResult } from "../application/refreshes.js";
import { presentRefreshStart } from "../application/wire-output.js";
import type {
  ProviderCollector,
  ProviderDefinition,
  SourceAdapter,
} from "../domain/source-adapter.js";
import { hostedOrigin } from "../transport/auth.js";
import type { RefreshService } from "./refresh-service.js";

/**
 * A scheduled occurrence: its stable identity and, when the scheduler states
 * it, its time. Otherwise a fixed denial reason that is safe to log.
 */
export type ScheduledRequestAuthentication =
  { invocationId: string; scheduledAt?: number } | { denied: string };

/**
 * Vouches for the scheduler behind a scheduled-path request, including its URL
 * and Host: native schedulers may call an internal address. Check caller
 * identity before calling `readBody`, which reads the bounded JSON body once.
 * A retried occurrence must keep its invocation ID.
 */
export type ScheduledRequestAuthenticator = (
  request: Request,
  readBody: () => Promise<unknown>,
) => Promise<ScheduledRequestAuthentication>;

/** A rejected body; the poller answers with its status. */
class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super("Invalid collection request body");
  }
}

/** JSON bodies are at most 8 KiB, read incrementally so larger ones stop early. */
async function readBoundedJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw new RequestBodyError(400);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const reader = request.body?.getReader();
    if (reader) {
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        length += part.value.byteLength;
        if (length > 8192) {
          await reader.cancel();
          throw new RequestBodyError(413);
        }
        chunks.push(part.value);
      }
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (error) {
    throw error instanceof RequestBodyError ? error : new RequestBodyError(400);
  }
}

/** One connection the poller can collect. */
export interface CollectionTarget {
  connectionId: string;
  adapter: SourceAdapter;
  /** The provider's request estimate, when it offers one. */
  estimateRequests?: ProviderDefinition["estimateRequests"];
  /** Built for each run, so stored credentials are read only when needed. */
  collector(): Promise<ProviderCollector>;
}

/** Collectable connections, and how many could not be discovered at all. */
export interface CollectionDiscovery {
  targets: CollectionTarget[];
  failures: number;
}

/** Constant-time comparison of a request's bearer token with a secret. */
function bearerMatches(request: Request, secret: Buffer) {
  const header = request.headers.get("authorization") ?? "";
  const supplied = Buffer.from(
    header.startsWith("Bearer ") ? header.slice(7) : "",
  );
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

/** The request reached the public origin with matching Origin and Host headers. */
function fromPublicOrigin(request: Request, origin: URL) {
  const url = new URL(request.url);
  return (
    url.origin === origin.origin &&
    (request.headers.get("origin") === null ||
      request.headers.get("origin") === origin.origin) &&
    (request.headers.get("host") === null ||
      request.headers.get("host") === url.host)
  );
}

/**
 * The default for any external scheduler (cron, Cloud Scheduler, EventBridge):
 * a bearer secret on the public origin. Retries that resend the same
 * `Idempotency-Key` reuse one occurrence; without it each call is new.
 */
export function bearerScheduleAuthenticator(
  publicOrigin: string,
  secret: string,
): ScheduledRequestAuthenticator {
  const origin = new URL(hostedOrigin(publicOrigin));
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error("Invalid schedule secret configuration");
  }
  const expected = Buffer.from(secret);
  return async (request, readBody) => {
    if (!fromPublicOrigin(request, origin)) {
      return { denied: "untrusted_origin_or_host" };
    }
    if (!bearerMatches(request, expected)) {
      return { denied: "invalid_schedule_secret" };
    }
    const key = request.headers.get("idempotency-key");
    if (key !== null && !/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) {
      return { denied: "invalid_idempotency_key" };
    }
    if (
      !z
        .object({})
        .strict()
        .safeParse(await readBody()).success
    ) {
      return { denied: "invalid_schedule_body" };
    }
    return { invocationId: key ?? randomUUID() };
  };
}

export const COLLECTION_TRIGGER_PATH = "/internal/triggers/recent";
export const COLLECTION_OPERATOR_PATH = "/internal/refresh/recent";

export const COLLECTION_CONTINUE_PATH = "/internal/refreshes/continue";

/**
 * The internal HTTP routes. Hosted on a public origin; a loopback server
 * serves none of them.
 */
export interface CollectionRoutesOptions {
  publicOrigin: string;
  manualSecret: string;
  /** Without one, the scheduled path denies every request. */
  authenticateScheduledRequest?: ScheduledRequestAuthenticator;
  /** Count-only events; stdout by default, as hosted logs expect. */
  log?: (entry: object) => void;
}

/**
 * Asks this service's public origin to resume active refreshes in a new
 * invocation, authenticated by the operator secret.
 */
export function continuationRequest(publicOrigin: string, secret: string) {
  const url = new URL(COLLECTION_CONTINUE_PATH, hostedOrigin(publicOrigin));
  return async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (response.status !== 202) {
      throw new Error("Refresh continuation was not accepted");
    }
  };
}

/**
 * The hosted internal routes: the scheduled trigger, the operator retry and
 * the refresh continuation. Each answers with the refreshes it started, or
 * met, after a bounded wait; the refreshes then finish on their own.
 */
export function createCollectionRoutes(
  refreshes: RefreshService,
  routes: CollectionRoutesOptions,
  /** A host that defines occurrences itself (an embedded schedule) runs its current one. */
  scheduledRun?: () => Promise<RefreshStartResult[] | undefined>,
) {
  const origin = new URL(hostedOrigin(routes.publicOrigin));
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(routes.manualSecret)) {
    throw new Error("Invalid refresh route configuration");
  }
  const secret = Buffer.from(routes.manualSecret);
  const log =
    routes.log ?? ((entry: object) => console.info(JSON.stringify(entry)));
  const paths = [
    COLLECTION_TRIGGER_PATH,
    COLLECTION_OPERATOR_PATH,
    COLLECTION_CONTINUE_PATH,
  ];

  const respond = (value: unknown, status: number) =>
    Response.json(value, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  const started = async (results: RefreshStartResult[]) => {
    const current = await refreshes.wait(results, 10_000);
    const continuing = current.some(
      (result) =>
        result.refresh?.status === "pending" ||
        result.refresh?.status === "running",
    );
    return respond(
      { refreshes: current.map(presentRefreshStart) },
      continuing ? 202 : 200,
    );
  };

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const scheduled = path === COLLECTION_TRIGGER_PATH;
    const deny = (reason: string) => {
      if (scheduled) {
        log({ event: "fonds_native_trigger_denied", reason });
      }
      return respond({ error: "forbidden" }, 403);
    };
    // Scheduled requests are vouched for by the injected authenticator, which
    // owns their URL/Host policy. The operator-secret routes keep the public
    // origin/Host checks here.
    if (!scheduled && !fromPublicOrigin(request, origin)) {
      return deny("untrusted_origin_or_host");
    }
    if (request.method !== "POST") {
      return respond({ error: "method_not_allowed" }, 405);
    }
    try {
      if (!scheduled) {
        if (!bearerMatches(request, secret)) {
          return respond({ error: "unauthorized" }, 401);
        }
        if (
          !z
            .object({})
            .strict()
            .safeParse(await readBoundedJson(request)).success
        ) {
          return respond({ error: "invalid_request" }, 400);
        }
        if (path === COLLECTION_CONTINUE_PATH) {
          await refreshes.resumeStalled();
          return respond({}, 202);
        }
        // The operator may retry after a provider authentication block.
        return started(
          await refreshes.startAll({ trigger: "manual", operator: true }),
        );
      }
      if (!routes.authenticateScheduledRequest) {
        return deny("scheduler_not_configured");
      }
      const authentication = await routes.authenticateScheduledRequest(
        request,
        () => readBoundedJson(request),
      );
      if ("denied" in authentication) {
        return deny(authentication.denied);
      }
      if (
        !authentication.invocationId ||
        authentication.invocationId.length > 512
      ) {
        return deny("invalid_invocation_id");
      }
      // Each trigger also resumes refreshes whose invocation ended early.
      await refreshes.resumeStalled();
      if (scheduledRun) {
        return started((await scheduledRun()) ?? []);
      }
      return started(
        await refreshes.startAll({
          trigger: "scheduled",
          occurrence: {
            key: authentication.invocationId,
            at: authentication.scheduledAt ?? Date.now(),
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof RequestBodyError)) {
        throw error;
      }
      return respond(
        { error: error.status === 413 ? "too_large" : "invalid_request" },
        error.status,
      );
    }
  }

  return {
    /** Serves the internal routes; null for any other path. */
    handleRequest: async (request: Request) =>
      paths.includes(new URL(request.url).pathname) ? handle(request) : null,
  };
}
