import { z } from "zod";

import type { CredentialStore } from "../application/credential-store.js";
import {
  createEventService,
  type EventService,
  type EventServiceDependencies,
  type EventSubscriptionStore,
} from "../application/events.js";
import type { InternalStore } from "../application/financial-store.js";
import {
  type Application,
  createApplication,
} from "../application/operations.js";
import type { RefreshStartResult } from "../application/refreshes.js";
import type {
  MissedOccurrences,
  ScheduledOccurrence,
} from "../application/scheduled-collections.js";
import { safeLog } from "../application/sync-diagnostics.js";
import type { ProviderCredentials } from "../domain/credentials.js";
import { LOCAL_IDENTITY } from "../transport/http.js";
import type {
  CollectionDiscovery,
  CollectionTarget,
} from "./collection-routes.js";
import {
  COLLECTION_TIME_SETTING,
  type CollectionSchedule,
  createEmbeddedScheduler,
  type EmbeddedScheduler,
  type EmbeddedSchedulerOptions,
  generateCollectionTime,
  parseCollectionSchedule,
} from "./collection-schedule.js";
import {
  createCredentialVault,
  type CredentialsKey,
} from "./credential-vault.js";
import { runtimeProvider } from "./providers.js";
import {
  createRefreshService,
  ownerRefreshes,
  type RefreshDatabase,
  type RefreshService,
} from "./refresh-service.js";
import { sendSignedWebhook, verifyWebhookCallback } from "./webhook.js";

/** Receives operational metadata; never financial values or secrets. */
export type OperationsLog = (entry: object) => void;

/** The hosted default: one JSON line per event on stdout. */
export const stdoutLog: OperationsLog = (entry) =>
  console.info(JSON.stringify(entry));

/** For processes whose stdout is a protocol or a command's result. */
export const stderrLog: OperationsLog = (entry) =>
  process.stderr.write(`${JSON.stringify(entry)}\n`);

const transportDiagnosticSchema = z.object({
  endpoint: z.enum(["login", "init", "recent", "monthly", "search", "unknown"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  contentType: z.enum(["json", "html", "other"]),
  outcome: z.enum([
    "network_error",
    "authentication_failed",
    "authentication_challenge",
    "rate_limited",
    "invalid_response",
    "success",
  ]),
  stage: z.enum([
    "request",
    "redirect",
    "http_status",
    "response_size",
    "response_body",
    "utf8_decode",
    "json_keys",
    "json_parse",
    "json_shape",
    "authentication",
    "complete",
    "endpoint_policy",
    "timeout",
    "cancelled",
  ]),
});

export interface CollectionTargetSources {
  store: Pick<InternalStore, "listConnections">;
  /** Credentials stored encrypted by `connect`. */
  credentials: CredentialStore;
  /** Read at each run, so a key that `connect` creates needs no restart. */
  credentialsKey(): CredentialsKey | undefined;
  /** One connection whose credentials come from the environment. */
  configured?: {
    connectionId: string;
    provider: string;
    credentials: ProviderCredentials;
  };
  providerFor?: typeof runtimeProvider;
  log?: OperationsLog;
}

/**
 * Every connection with credentials: the env-configured one, then any stored
 * encrypted by `connect`. Resolved per run, so `connect` needs no restart.
 */
export function collectionTargets(sources: CollectionTargetSources) {
  const { configured, credentials: credentialStore } = sources;
  const providerFor = sources.providerFor ?? runtimeProvider;
  const log = safeLog(sources.log ?? stdoutLog);
  const target = (
    connectionId: string,
    providerName: string,
    credentials: () => Promise<ProviderCredentials | undefined>,
  ): CollectionTarget => {
    const provider = providerFor(providerName);
    return {
      connectionId,
      adapter: provider.adapter,
      ...(provider.estimateRequests && {
        estimateRequests: provider.estimateRequests,
      }),
      async collector() {
        const loaded = await credentials();
        if (!loaded) {
          throw new Error("Stored credentials disappeared");
        }
        return provider.createCollector(loaded, {
          onDiagnostic: safeLog((diagnostic: object) => {
            const parsed = transportDiagnosticSchema.safeParse(diagnostic);
            if (parsed.success) {
              log({ event: "fonds_provider_transport", ...parsed.data });
            }
          }),
        });
      },
    };
  };
  return async (): Promise<CollectionDiscovery> => {
    const targets: CollectionTarget[] = [];
    let failures = 0;
    if (configured) {
      targets.push(
        target(
          configured.connectionId,
          configured.provider,
          async () => configured.credentials,
        ),
      );
    }
    let key: CredentialsKey | undefined;
    try {
      key = sources.credentialsKey();
    } catch {
      log({ event: "fonds_refresh_discovery_failed", stage: "key" });
      return { targets, failures: failures + 1 };
    }
    if (!key) {
      return { targets, failures };
    }
    const vault = createCredentialVault(credentialStore, key);
    // A failing read never hides a connection: it fails the run, and the env
    // target and every readable connection still collect.
    let connections: Awaited<ReturnType<InternalStore["listConnections"]>>;
    try {
      connections = await sources.store.listConnections();
    } catch {
      log({ event: "fonds_refresh_discovery_failed", stage: "connections" });
      return { targets, failures: failures + 1 };
    }
    for (const connection of connections) {
      if (connection.id === configured?.connectionId) {
        continue;
      }
      let stored: boolean;
      try {
        stored =
          (await credentialStore.getCredentials(connection.id)) !== undefined;
      } catch {
        // Fails again inside the connection's locked job, recording its status.
        stored = true;
      }
      if (!stored) {
        continue;
      }
      try {
        targets.push(
          target(connection.id, connection.provider, () =>
            vault.load(connection),
          ),
        );
      } catch {
        // An unsupported provider has no adapter to record a job with.
        log({
          event: "fonds_refresh_target_skipped",
          provider: connection.provider,
        });
        failures += 1;
      }
    }
    return { targets, failures };
  };
}

export interface CollectionServiceOptions extends Omit<
  CollectionTargetSources,
  "store"
> {
  store: RefreshDatabase;
  /** Delivers due Events after every refresh. */
  events?: EventService;
  /** Interrupts executions when the service shuts down; they resume later. */
  signal: AbortSignal;
}

/** Refreshes over every collectable connection, with Events delivery, on any backend. */
export function createCollectionService(options: CollectionServiceOptions) {
  const log = safeLog(options.log ?? stdoutLog);
  const { events } = options;
  return createRefreshService({
    store: options.store,
    targets: collectionTargets({ ...options, log }),
    signal: options.signal,
    log,
    // Each refresh also delivers changes made through the API since the last one.
    ...(events && {
      afterRefresh: async (signal: AbortSignal) => {
        await deliveryPass(events, log)(signal);
      },
    }),
  });
}

/** How long one Events delivery pass may run, after a refresh or an owner write. */
export const DELIVERY_PASS_MS = 30_000;

/** One bounded delivery pass; a quiet one logs only when it sent or failed. */
export function deliveryPass(
  events: Pick<EventService, "deliver">,
  log: OperationsLog,
  boundMs = DELIVERY_PASS_MS,
) {
  return async (signal: AbortSignal, quiet = false) => {
    const outcome = await events.deliver({
      limit: 100,
      signal: AbortSignal.any([signal, AbortSignal.timeout(boundMs)]),
    });
    if (!quiet || outcome.sent || outcome.failed) {
      log({ event: "fonds_event_delivery", ...outcome });
    }
    return outcome;
  };
}

export interface WriteDeliveryOptions {
  /** Ends a pass at shutdown; none starts after it. */
  signal: AbortSignal;
  /** Keeps a host whose invocations end alive until a write's pass settles (Neon's waitUntil). */
  background?: ((work: Promise<unknown>) => void) | undefined;
  log: OperationsLog;
}

/**
 * Delivery for owner writes, which no refresh follows. A write's pass starts
 * after it has committed, outside its transaction, and never holds its
 * response. One pass runs at a time; writes during it share the next one.
 */
export function writeDelivery(
  pass: (signal: AbortSignal) => Promise<{ sent: number }>,
  options: WriteDeliveryOptions,
) {
  const log = safeLog(options.log);
  let waiting: (() => void)[] = [];
  let running: Promise<void> | undefined;

  async function cover() {
    try {
      // A subscription sends one batch per pass, which may be an older retried
      // one; one more pass then sends what the write committed.
      if ((await pass(options.signal)).sent > 0 && !options.signal.aborted) {
        await pass(options.signal);
      }
    } catch {
      log({ event: "fonds_write_delivery", status: "failed" });
    }
  }

  async function drain() {
    // Yields first, so `running` is set before this can finish.
    await null;
    while (waiting.length > 0) {
      const covered = waiting;
      waiting = [];
      if (!options.signal.aborted) {
        await cover();
      }
      for (const settle of covered) {
        settle();
      }
    }
    running = undefined;
  }

  return {
    /** The application's `afterWrite`. */
    afterWrite() {
      if (options.signal.aborted) {
        return;
      }
      const covered = new Promise<void>((resolve) => waiting.push(resolve));
      running ??= drain();
      // The write's invocation lives until the pass that covers it settles.
      options.background?.(covered);
    },
    /** Waits until no pass runs or is requested. */
    async settled() {
      while (running) {
        await running;
      }
    },
  };
}

/** The embedded scheduler's paths over a refresh service. */
export function scheduledRefreshes(refreshes: RefreshService) {
  return {
    collect: (occurrence: ScheduledOccurrence) =>
      refreshes.startAll({ trigger: "scheduled", occurrence }),
    // The occurrence's claim is held until its refreshes finish.
    settle: (results: RefreshStartResult[]) => refreshes.wait(results),
    missed: (gap: MissedOccurrences) => refreshes.recordMissed(gap),
  };
}

/** What a static-token server needs from its backend to collect and deliver. */
export interface LocalCollectionBackend {
  store: RefreshDatabase;
  credentials: CredentialStore;
  eventSubscriptions: EventSubscriptionStore;
  credentialsKey(): CredentialsKey | undefined;
}

export interface LocalServiceOptions {
  log: OperationsLog;
  /** Scheduled collection; without one the scheduler only delivers Events. */
  schedule?: CollectionSchedule | undefined;
  /** Test seams for the embedded scheduler's clock and ticks. */
  scheduler?: Pick<
    EmbeddedSchedulerOptions,
    "now" | "random" | "tickMs" | "maxJitterMs"
  >;
  /** Ends collections in progress, as the service shuts down. */
  signal: AbortSignal;
  providerFor?: typeof runtimeProvider;
  /** Outbound webhook I/O; tests replace it. */
  webhooks?: Pick<
    EventServiceDependencies,
    "sendSignedWebhook" | "verifyWebhookCallback"
  >;
}

/**
 * The application, refresh, Events and embedded scheduler of a server
 * authenticated by its static bearer token, on any backend. That token is its
 * only client, so an Events subscription stays authorized while it is
 * unexpired and not unsubscribed. The caller starts the scheduler once it
 * serves, and stops it and awaits `settled()` before closing the store.
 */
export function createLocalService(
  backend: LocalCollectionBackend,
  options: LocalServiceOptions,
): {
  application: Application;
  events: EventService;
  refreshes: RefreshService;
  scheduler: EmbeddedScheduler;
} {
  const log = safeLog(options.log);
  const events = createEventService({
    store: backend.eventSubscriptions,
    source: backend.store,
    // Request logs follow the service's log, so stdio's stdout stays protocol-only.
    sendSignedWebhook: (input) => sendSignedWebhook(input, log),
    verifyWebhookCallback: (input) => verifyWebhookCallback(input, log),
    ...options.webhooks,
    grantCheck: async (principal) =>
      principal.ownerId === LOCAL_IDENTITY.ownerId &&
      principal.clientId === LOCAL_IDENTITY.clientId,
  });
  const refreshes = createCollectionService({
    store: backend.store,
    credentials: backend.credentials,
    credentialsKey: backend.credentialsKey,
    events,
    signal: options.signal,
    log: log,
    ...(options.providerFor && { providerFor: options.providerFor }),
  });
  const deliver = deliveryPass(events, log);
  const writes = writeDelivery((signal) => deliver(signal, true), {
    signal: options.signal,
    log,
  });
  const scheduler = createEmbeddedScheduler({
    ...options.scheduler,
    schedule: options.schedule,
    claims: backend.store,
    ...(options.schedule && scheduledRefreshes(refreshes)),
    // Ticks resume refreshes a stopped process left, then deliver quietly.
    deliver: async (signal) => {
      await refreshes.resumeStalled();
      const outcome = await events.deliver({ limit: 100, signal });
      if (outcome.sent || outcome.failed) {
        log({ event: "fonds_event_delivery", ...outcome });
      }
    },
    log: (event, fields) => log({ event, ...fields }),
  });
  return {
    application: createApplication(backend.store, {
      refreshes: ownerRefreshes(refreshes),
      afterWrite: writes.afterWrite,
    }),
    events,
    refreshes,
    // Shutdown keeps the store open until refreshes and deliveries record their state.
    scheduler: {
      ...scheduler,
      settled: async () => {
        await scheduler.settled();
        await refreshes.settled();
        await writes.settled();
      },
    },
  };
}

/**
 * A static-token server's schedule from FONDS_REFRESH_SCHEDULE,
 * FONDS_REFRESH_TIME and FONDS_REFRESH_TIMEZONE. Without a time, the
 * installation's random one, which the database keeps so every process on it
 * shares it. Undefined when scheduled collection is off.
 */
export async function localSchedule(
  store: Pick<InternalStore, "ensureSetting">,
  env: NodeJS.ProcessEnv,
) {
  // Generated whether or not a schedule is on, so turning one on keeps it.
  const storedTime = await store.ensureSetting(
    COLLECTION_TIME_SETTING,
    generateCollectionTime,
  );
  return parseCollectionSchedule(
    {
      FONDS_REFRESH_SCHEDULE: env.FONDS_REFRESH_SCHEDULE,
      FONDS_REFRESH_TIME: env.FONDS_REFRESH_TIME || storedTime,
      FONDS_REFRESH_TIMEZONE: env.FONDS_REFRESH_TIMEZONE,
    },
    "FONDS_REFRESH_SCHEDULE needs FONDS_REFRESH_TIME",
  );
}
