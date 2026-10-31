import { isIP } from "node:net";

import { Pool } from "pg";
import { z } from "zod";

import { createEventService } from "../application/events.js";
import { createApplication } from "../application/operations.js";
import { parseCredentials } from "../domain/credentials.js";
import { createPostgresCredentialStore } from "../storage/postgres/credentials.js";
import { createPostgresEventStore } from "../storage/postgres/events.js";
import {
  FINANCIAL_SESSION_OPTIONS,
  openPostgresDatabase,
} from "../storage/postgres/store.js";
import { hostedOrigin } from "../transport/auth.js";
import { createHttpService } from "../transport/http.js";
import {
  CLIENT_ADDRESS_HEADER,
  createBetterAuth,
  type GoogleLogin,
} from "./auth/better-auth.js";
import {
  COLLECTION_TRIGGER_PATH,
  continuationRequest,
  createCollectionRoutes,
  type ScheduledRequestAuthenticator,
} from "./collection-routes.js";
import {
  type CollectionSchedule,
  createEmbeddedScheduler,
  type EmbeddedSchedulerOptions,
} from "./collection-schedule.js";
import {
  collectionTargets,
  deliveryPass,
  scheduledRefreshes,
  stdoutLog,
  writeDelivery,
} from "./collection-service.js";
import {
  type CredentialsKey,
  parseCredentialsKey,
} from "./credential-vault.js";
import { runtimeProvider } from "./providers.js";
import {
  createRefreshService,
  ownerRefreshes,
  type RefreshServiceOptions,
} from "./refresh-service.js";
import { sendSignedWebhook, verifyWebhookCallback } from "./webhook.js";

/** Administrative Better Auth account name; never a real mailbox. */
const OWNER_ACCOUNT_EMAIL = "owner@fonds.invalid";

/** Variables every host supplies; host targets extend this with their own. */
export const hostedEnvironmentSchema = z.object({
  FONDS_PUBLIC_ORIGIN: z.string().transform((value, context) => {
    try {
      return hostedOrigin(value);
    } catch {
      context.addIssue({ code: "custom", message: "invalid origin" });
      return z.NEVER;
    }
  }),
  FONDS_AUTH_SECRET: z.string().min(32),
  FONDS_OWNER_ID: z.string().trim().min(1).max(256),
  FONDS_REFRESH_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/)
    .optional(),
  FONDS_CONNECTION_ID: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value === value.trim())
    .optional(),
  FONDS_CONNECTION_PROVIDER: z.string().min(1).optional(),
  FONDS_CONNECTION_CREDENTIALS: z.string().min(1).max(16_384).optional(),
  // Optional owner-linked sign-in providers, each a complete OAuth client pair.
  FONDS_GOOGLE_CLIENT_ID: z.string().min(1).max(512).optional(),
  FONDS_GOOGLE_CLIENT_SECRET: z.string().min(1).max(512).optional(),
  FONDS_GITHUB_CLIENT_ID: z.string().min(1).max(512).optional(),
  FONDS_GITHUB_CLIENT_SECRET: z.string().min(1).max(512).optional(),
  // Decrypts per-connection credentials stored by `connect`.
  FONDS_CREDENTIALS_KEY: z.string().optional(),
  // 1 serves /v1/openapi.json without authentication; 0 or unset does not.
  FONDS_PUBLIC_API_DESCRIPTION: z.enum(["0", "1"]).optional(),
});

/** Names variables only; never includes received values. */
export class HostedConfigurationError extends Error {}

/** Parse a host environment once; inner modules receive typed values. */
export function parseHostedEnvironment<Schema extends z.ZodType>(
  schema: Schema,
  env: NodeJS.ProcessEnv,
  host: string,
): z.infer<Schema> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new HostedConfigurationError(
      `Invalid ${host} configuration: ${names.join(", ")}`,
    );
  }
  return parsed.data;
}

/** The host-neutral part of a parsed environment. */
export function hostedConfiguration(
  values: z.infer<typeof hostedEnvironmentSchema>,
) {
  const {
    FONDS_REFRESH_SECRET: manualSecret,
    FONDS_CONNECTION_ID: connectionId,
    FONDS_CONNECTION_PROVIDER: provider,
    FONDS_CONNECTION_CREDENTIALS: credentials,
  } = values;
  // One env-configured connection is all-or-nothing; stored ones need no env.
  const configured = [connectionId, provider, credentials].filter(Boolean);
  const fullyConfigured = configured.length === 3;
  if (
    (configured.length !== 0 && !fullyConfigured) ||
    (fullyConfigured && manualSecret === undefined)
  ) {
    throw new HostedConfigurationError("Incomplete connection configuration");
  }
  const socialLogin = Object.fromEntries(
    (
      [
        [
          "google",
          values.FONDS_GOOGLE_CLIENT_ID,
          values.FONDS_GOOGLE_CLIENT_SECRET,
        ],
        [
          "github",
          values.FONDS_GITHUB_CLIENT_ID,
          values.FONDS_GITHUB_CLIENT_SECRET,
        ],
      ] as const
    ).flatMap(([name, clientId, clientSecret]) => {
      if ((clientId === undefined) !== (clientSecret === undefined)) {
        throw new HostedConfigurationError(
          "Incomplete sign-in provider configuration",
        );
      }
      return clientId && clientSecret
        ? [[name, { clientId, clientSecret }]]
        : [];
    }),
  );
  let credentialsKey: CredentialsKey | undefined;
  try {
    credentialsKey =
      values.FONDS_CREDENTIALS_KEY === undefined
        ? undefined
        : parseCredentialsKey(values.FONDS_CREDENTIALS_KEY);
  } catch {
    throw new HostedConfigurationError("Invalid FONDS_CREDENTIALS_KEY");
  }
  return {
    publicOrigin: values.FONDS_PUBLIC_ORIGIN,
    secret: values.FONDS_AUTH_SECRET,
    ownerId: values.FONDS_OWNER_ID,
    ownerEmail: OWNER_ACCOUNT_EMAIL,
    ...(Object.keys(socialLogin).length && { socialLogin }),
    ...(credentialsKey && { credentialsKey }),
    ...(values.FONDS_PUBLIC_API_DESCRIPTION === "1" && {
      publicApiDescription: true,
    }),
    ...(manualSecret && {
      collection: {
        manualSecret,
        ...(fullyConfigured && {
          configured: {
            connectionId: connectionId!,
            provider: provider!,
            credentials: collectionCredentials(provider!, credentials!),
          },
        }),
      },
    }),
  };
}

function collectionCredentials(provider: string, text: string) {
  try {
    return parseCredentials(
      JSON.parse(text),
      runtimeProvider(provider).credentials,
    );
  } catch {
    throw new HostedConfigurationError(
      "Invalid connection provider or credentials configuration",
    );
  }
}

export type HostedConfiguration = ReturnType<typeof hostedConfiguration>;

export interface HostedServiceOptions {
  connectionString: string;
  /**
   * For hosts whose invocations end (Neon): keeps an invocation alive while a
   * refresh or an owner write's delivery runs, and bounds how long a refresh
   * may; a longer one continues in a new invocation through the internal
   * continuation route.
   */
  refreshExecution?: Pick<RefreshServiceOptions, "background" | "budgetMs">;
  /** Lets a host track pool lifetime, for example across suspended instances. */
  attachPool?: (pool: Pool) => void;
  googleLogin?: GoogleLogin;
  scheduler?: {
    authenticate: ScheduledRequestAuthenticator;
    /**
     * The host's scheduler calls an internal URL/Host. Only the scheduled path
     * then skips the public host guard; the authenticator still vouches for it.
     * Never set this for a host whose ingress does not enforce that boundary.
     */
    internalIngress?: boolean;
  };
  /**
   * An in-process scheduler for hosts with a long-lived process: Events
   * delivery every tick and, with a schedule, scheduled collection. The
   * scheduled HTTP path then runs the schedule's current occurrence.
   */
  embeddedScheduler?: Pick<
    EmbeddedSchedulerOptions,
    "now" | "random" | "tickMs" | "maxJitterMs"
  > & { schedule?: CollectionSchedule | undefined };
}

export function logEvent(event: string, fields: object) {
  console.info(JSON.stringify({ event, ...fields }));
}

/** The hosted service's collection targets; see `collectionTargets`. */
export function hostedCollectionTargets(
  config: HostedConfiguration,
  store: ReturnType<typeof openPostgresDatabase>,
  financialPool: Pool,
  providerFor: typeof runtimeProvider = runtimeProvider,
) {
  return collectionTargets({
    store,
    credentials: createPostgresCredentialStore(financialPool),
    credentialsKey: () => config.credentialsKey,
    ...(config.collection?.configured && {
      configured: config.collection.configured,
    }),
    providerFor,
  });
}

function collectionServices(
  config: HostedConfiguration,
  scheduler: HostedServiceOptions["scheduler"],
  store: ReturnType<typeof openPostgresDatabase>,
  financialPool: Pool,
  issuer: ReturnType<typeof createBetterAuth>,
  shutdown: AbortSignal,
  embedded: HostedServiceOptions["embeddedScheduler"],
  execution: HostedServiceOptions["refreshExecution"],
) {
  // Event state is operational metadata; the existing financial event feed stays
  // authoritative. Callback I/O occurs after each financial transaction commits.
  const events = createEventService({
    store: createPostgresEventStore(financialPool, store),
    source: store,
    sendSignedWebhook,
    verifyWebhookCallback,
    grantCheck: issuer.hasActiveEventReadGrant,
  });
  const deliver = deliveryPass(events, stdoutLog);
  // Owner writes deliver too: a serverless host has no tick to deliver them.
  const writes = writeDelivery((signal) => deliver(signal, true), {
    signal: shutdown,
    background: execution?.background,
    log: stdoutLog,
  });
  if (embedded?.schedule && !config.collection) {
    throw new HostedConfigurationError(
      "FONDS_REFRESH_SCHEDULE needs FONDS_REFRESH_SECRET",
    );
  }
  const refreshes =
    config.collection &&
    createRefreshService({
      store,
      targets: hostedCollectionTargets(config, store, financialPool),
      signal: shutdown,
      log: (entry) => console.info(JSON.stringify(entry)),
      // Each refresh also delivers changes made through the API since the last one.
      afterRefresh: async (signal) => {
        await deliver(signal);
      },
      ...execution,
      ...(execution?.budgetMs !== undefined && {
        continueLater: continuationRequest(
          config.publicOrigin,
          config.collection.manualSecret,
        ),
      }),
    });
  const embeddedScheduler =
    embedded &&
    createEmbeddedScheduler({
      ...embedded,
      claims: store,
      ...(embedded.schedule && refreshes && scheduledRefreshes(refreshes)),
      // Ticks resume refreshes a stopped process left, then deliver quietly.
      deliver: async (signal) => {
        await refreshes?.resumeStalled();
        await deliver(signal, true);
      },
      log: logEvent,
    });
  if (!config.collection || !refreshes) {
    return { events, writes, scheduler: embeddedScheduler };
  }
  const routes = createCollectionRoutes(
    refreshes,
    {
      publicOrigin: config.publicOrigin,
      manualSecret: config.collection.manualSecret,
      ...(scheduler && {
        authenticateScheduledRequest: scheduler.authenticate,
      }),
    },
    embedded?.schedule && (() => embeddedScheduler!.runCurrent()),
  );
  return { events, writes, refreshes, routes, scheduler: embeddedScheduler };
}

/**
 * The X-Forwarded-For entry `proxies` places from the right: the address the
 * outermost of that many appending proxies saw. Entries further left came from
 * the client. Undefined unless that entry is a bare IP address.
 */
export function forwardedAddress(request: Request, proxies: number) {
  const entry = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .at(-proxies)
    ?.trim();
  return entry && isIP(entry) ? entry : undefined;
}

/** The OAuth issuer, API/MCP, refresh, scheduled collection and Events on PostgreSQL. */
export function createHostedService(
  config: HostedConfiguration,
  options: HostedServiceOptions,
) {
  const poolConfig = {
    connectionString: options.connectionString,
    max: 3,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  };
  const financialPool = new Pool({
    ...poolConfig,
    options: FINANCIAL_SESSION_OPTIONS,
  });
  const authPool = new Pool({
    ...poolConfig,
    options: "-c search_path=identity",
  });
  // pg removes failed idle clients before emitting this; never let a raw driver
  // error crash the process or enter logs. The financial pool's store does the same.
  authPool.on("error", () =>
    console.error("PostgreSQL idle connection failed."),
  );
  options.attachPool?.(financialPool);
  options.attachPool?.(authPool);
  const store = openPostgresDatabase(financialPool);
  const issuer = createBetterAuth(authPool, {
    publicOrigin: config.publicOrigin,
    secret: config.secret,
    ownerId: config.ownerId,
    ownerEmail: config.ownerEmail,
    ...(config.socialLogin && { socialLogin: config.socialLogin }),
    ...(options.googleLogin && { googleLogin: options.googleLogin }),
  });
  const shutdown = new AbortController();
  const { events, writes, refreshes, routes, scheduler } = collectionServices(
    config,
    options.scheduler,
    store,
    financialPool,
    issuer,
    shutdown.signal,
    options.embeddedScheduler,
    options.refreshExecution,
  );
  const service = createHttpService(
    createApplication(store, {
      ...(refreshes && { refreshes: ownerRefreshes(refreshes) }),
      afterWrite: writes.afterWrite,
      onOperation: (entry) => logEvent("fonds_operation", entry),
      meterDbBytes: store.meterDbBytes,
    }),
    {
      publicOrigin: config.publicOrigin,
      ownerId: config.ownerId,
      authProvider: issuer.provider,
      ...(config.publicApiDescription && { publicApiDescription: true }),
      ...(routes &&
        options.scheduler?.internalIngress && {
          platformRoutes: async (request: Request) =>
            new URL(request.url).pathname === COLLECTION_TRIGGER_PATH
              ? routes.handleRequest(request)
              : null,
        }),
      publicRoutes: async (request) =>
        (await routes?.handleRequest(request)) ??
        issuer.handlePublicRequest(request),
      ...(events && { events }),
      onRequest: (entry) => logEvent("fonds_http_request", entry),
    },
  );
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      // No new scheduled run starts; an interrupted one releases its claim.
      scheduler?.stop();
      // Interrupted refreshes stay active, to resume after a restart.
      shutdown.abort();
      await service.stop();
    })());
  /** Ending a pool waits for clients that requests still have checked out. */
  const dispose = async () => {
    try {
      // Neither scheduled runs, refreshes nor deliveries are requests the
      // listener drains.
      await scheduler?.settled();
      await refreshes?.settled();
      await writes.settled();
      await service.close();
    } finally {
      await Promise.allSettled([store.close(), authPool.end()]);
    }
  };
  return {
    /**
     * Serves a request from the host's ingress. `clientAddress` is the address
     * the ingress trusts for this client; without one, auth rate limits share
     * one bucket per route rather than trust anything the client sent.
     */
    fetch: (request: Request, clientAddress?: string) => {
      if (!clientAddress && !request.headers.has(CLIENT_ADDRESS_HEADER)) {
        return service.app.fetch(request);
      }
      const headers = new Headers(request.headers);
      headers.delete(CLIENT_ADDRESS_HEADER);
      if (clientAddress) {
        headers.set(CLIENT_ADDRESS_HEADER, clientAddress);
      }
      return service.app.fetch(new Request(request, { headers }));
    },
    /** Starts the embedded scheduler's ticks, once the host serves requests. */
    startScheduler() {
      scheduler?.start();
    },
    /** Interrupts collections and ends MCP subscription streams; requests keep the pools. */
    stop,
    /** Closes MCP and ends both pools; a listener calls it after draining. */
    dispose,
    /** Without a listener: stops the service, then ends both pools. */
    async close() {
      try {
        await stop();
      } finally {
        await dispose();
      }
    },
  };
}
