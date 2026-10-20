import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { z } from "zod";

import {
  ensurePostgresSchema,
  openPostgresDatabase,
} from "../storage/postgres/store.js";
import { createBetterAuth } from "./auth/better-auth.js";
import { bearerScheduleAuthenticator } from "./collection-routes.js";
import {
  COLLECTION_TIME_SETTING,
  CollectionScheduleError,
  type CollectionScheduleSettings,
  generateCollectionTime,
  nextOccurrence,
  parseCollectionSchedule,
} from "./collection-schedule.js";
import {
  createHostedService,
  forwardedAddress,
  type HostedConfiguration,
  hostedConfiguration,
  HostedConfigurationError,
  hostedEnvironmentSchema,
  logEvent,
  parseHostedEnvironment,
} from "./hosted-service.js";
import { type Installation, installationFingerprint } from "./installation.js";
import { listen } from "./node-service.js";
import {
  bindPostgresInstallation,
  databaseUrl,
  FINANCIAL_SCHEMA,
  financialPoolConfig,
  postgresInstallation,
  verifyPostgresInstallation,
} from "./postgres-environment.js";
import { StateError } from "./state.js";

const hostedNodeEnvironmentSchema = hostedEnvironmentSchema.extend({
  // Interactive transactions and their locks need a session: transaction poolers break them.
  FONDS_DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => !/-pooler\./.test(value), {
      message: "use a direct or session-mode endpoint",
    }),
  // A private container network may run PostgreSQL without TLS; say so explicitly.
  FONDS_DATABASE_TLS: z.literal("disable").optional(),
  FONDS_SCHEDULE_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/)
    .optional(),
  // Validated together by parseCollectionSchedule, with value-free messages.
  FONDS_COLLECTION_SCHEDULE: z.string().optional(),
  FONDS_COLLECTION_TIME: z.string().optional(),
  FONDS_COLLECTION_TIMEZONE: z.string().optional(),
  // The number of trusted proxies in front of Fonds that each append to
  // X-Forwarded-For; almost always one.
  FONDS_TRUST_PROXY: z
    .string()
    .regex(/^[1-9]$/)
    .transform(Number)
    .optional(),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
});

/** Parse the generic hosted environment once; inner modules receive typed values. */
export function hostedNodeConfiguration(env: NodeJS.ProcessEnv) {
  const values = parseHostedEnvironment(
    hostedNodeEnvironmentSchema,
    env,
    "hosted",
  );
  const scheduleSettings: CollectionScheduleSettings = {
    FONDS_COLLECTION_SCHEDULE: values.FONDS_COLLECTION_SCHEDULE,
    FONDS_COLLECTION_TIME: values.FONDS_COLLECTION_TIME,
    FONDS_COLLECTION_TIMEZONE: values.FONDS_COLLECTION_TIMEZONE,
  };
  // Fails before startup on a bad value; the database supplies a missing time.
  hostedSchedule(scheduleSettings, "00:00");
  return {
    ...hostedConfiguration(values),
    scheduleSettings,
    connectionString: databaseUrl(values.FONDS_DATABASE_URL, {
      allowPlaintextRemote: values.FONDS_DATABASE_TLS === "disable",
    }),
    scheduleSecret: values.FONDS_SCHEDULE_SECRET,
    trustedProxies: values.FONDS_TRUST_PROXY ?? 0,
    host: values.HOST,
    port: values.PORT,
  };
}

/**
 * The schedule, with the operator's time or else the installation's random
 * one, which the database keeps so every start and replica shares it.
 */
export function hostedSchedule(
  settings: CollectionScheduleSettings,
  storedTime: string,
) {
  try {
    return parseCollectionSchedule(
      {
        ...settings,
        FONDS_COLLECTION_TIME: settings.FONDS_COLLECTION_TIME || storedTime,
      },
      "FONDS_COLLECTION_SCHEDULE needs FONDS_COLLECTION_TIME",
    );
  } catch (error) {
    throw error instanceof CollectionScheduleError
      ? new HostedConfigurationError(error.message)
      : error;
  }
}

/**
 * Idempotently creates the financial, operations and identity schemas and the
 * sole owner. The first bootstrap records which owner ID, auth secret and
 * credentials key the installation uses; any later start with different ones
 * fails, so a lost or replaced state file never silently re-keys a database.
 */
export async function bootstrapHostedDatabase(
  config: HostedConfiguration & {
    connectionString: string;
    credentialsKeyId: string | null;
  },
) {
  const pool = (schema: string) => {
    const created = new Pool({
      ...financialPoolConfig(config.connectionString),
      max: 1,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 30_000,
      options: `-c search_path=${schema}`,
    });
    created.on("error", () => {});
    return created;
  };
  const financialPool = pool(FINANCIAL_SCHEMA);
  const authPool = pool("identity");
  try {
    // A fresh database is migrated and bound in one transaction, before
    // anything is populated, so an interrupted first start resumes safely.
    await bindPostgresInstallation(
      financialPool,
      installationFingerprint({
        ownerId: config.ownerId,
        secret: config.secret,
        credentialsKeyId: config.credentialsKeyId,
      }),
    );
    // Generated whether or not a schedule is on, so turning one on keeps it.
    const collectionTime = await openPostgresDatabase(
      financialPool,
    ).ensureSetting(COLLECTION_TIME_SETTING, generateCollectionTime);
    await ensurePostgresSchema(authPool, "identity");
    const auth = createBetterAuth(
      authPool,
      {
        publicOrigin: config.publicOrigin,
        secret: config.secret,
        ownerId: config.ownerId,
        ownerEmail: config.ownerEmail,
      },
      { forSetup: true },
    );
    await auth.migrate();
    // Owner login never uses this password; it only creates the owner row.
    await auth.bootstrapOwner(randomBytes(32).toString("base64url"));
    return { collectionTime };
  } finally {
    await Promise.allSettled([financialPool.end(), authPool.end()]);
  }
}

/**
 * Behind a TLS-terminating proxy the socket is plain HTTP. With trusted proxies, a
 * request whose Host is the public host and whose X-Forwarded-Proto matches the
 * public scheme is addressed to the public origin; anything else keeps its
 * socket URL and meets the HTTP host guard unchanged.
 */
export function externalRequest(request: Request, publicOrigin: string) {
  const origin = new URL(publicOrigin);
  if (
    request.headers.get("host") !== origin.host ||
    request.headers.get("x-forwarded-proto") !== origin.protocol.slice(0, -1)
  ) {
    return request;
  }
  const url = new URL(request.url);
  // The original request as init carries its method, headers, body stream and signal.
  return new Request(new URL(`${url.pathname}${url.search}`, origin), request);
}

/**
 * The client address rate limits trust. On direct ingress it is the socket's
 * peer, whatever forwarding headers say. Behind trusted proxies that each
 * append the address they received the request from to X-Forwarded-For, it is
 * the entry the outermost of them appended; entries to its left came from the
 * client. A chain too short or malformed for that falls back to the socket.
 */
function clientAddress(
  request: Request,
  socketAddress: string | undefined,
  trustedProxies: number,
) {
  return (
    (trustedProxies > 0 && forwardedAddress(request, trustedProxies)) ||
    socketAddress
  );
}

/** The Node listener's handler: public addressing and the trusted client address. */
export function hostedIngress(
  service: Pick<ReturnType<typeof createHostedService>, "fetch">,
  publicOrigin: string,
  trustedProxies: number,
) {
  return (request: Request, socketAddress: string | undefined) =>
    service.fetch(
      trustedProxies > 0 ? externalRequest(request, publicOrigin) : request,
      clientAddress(request, socketAddress, trustedProxies),
    );
}

/** The full hosted service on any Node host with a PostgreSQL database. */
export async function startHostedNodeService(env: NodeJS.ProcessEnv) {
  const {
    connectionString,
    scheduleSecret,
    scheduleSettings,
    trustedProxies,
    host,
    port,
    ...config
  } = hostedNodeConfiguration(
    (await postgresInstallation(env, { create: true })).env,
  );
  const { collectionTime } = await bootstrapHostedDatabase({
    ...config,
    connectionString,
    credentialsKeyId: config.credentialsKey?.id ?? null,
  });
  const schedule = hostedSchedule(scheduleSettings, collectionTime);
  const service = createHostedService(config, {
    connectionString,
    ...(scheduleSecret && {
      scheduler: {
        authenticate: bearerScheduleAuthenticator(
          config.publicOrigin,
          scheduleSecret,
        ),
      },
    }),
    embeddedScheduler: { schedule },
  });
  const running = await listen(
    hostedIngress(service, config.publicOrigin, trustedProxies),
    { stop: service.stop, dispose: service.dispose },
    { hostname: host, port },
  );
  logEvent("fonds_hosted_listening", {
    url: running.url,
    publicOrigin: config.publicOrigin,
    collection: config.collection !== undefined,
    schedule: schedule
      ? {
          mode: schedule.mode,
          timeZone: schedule.timeZone,
          next: new Date(nextOccurrence(schedule, Date.now()).at).toISOString(),
        }
      : null,
  });
  service.startScheduler();
  return running;
}

/**
 * A one-time owner sign-in link for this deployment, printed to the operator
 * who ran the command where the deployment's database and secrets live. The
 * environment is the caller's, already resolved with its state directory.
 */
export async function issueHostedLoginLink(
  env: NodeJS.ProcessEnv,
  installation: Installation,
) {
  const { connectionString, ...config } = hostedNodeConfiguration(env);
  const authPool = new Pool({
    ...financialPoolConfig(connectionString),
    max: 1,
    connectionTimeoutMillis: 15_000,
    options: "-c search_path=identity",
  });
  authPool.on("error", () => {});
  try {
    await verifyPostgresInstallation(authPool, installation.fingerprint);
    return await createBetterAuth(
      authPool,
      {
        publicOrigin: config.publicOrigin,
        secret: config.secret,
        ownerId: config.ownerId,
        ownerEmail: config.ownerEmail,
      },
      { forSetup: true },
    ).issueOwnerLoginLink();
  } finally {
    await authPool.end();
  }
}

/** Process entry: fixed, secret-free diagnostics and graceful shutdown. */
export async function runHostedNodeService(env: NodeJS.ProcessEnv) {
  try {
    const running = await startHostedNodeService(env);
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void running.close().catch(() => {
        process.stderr.write("Service shutdown failed.\n");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    // Driver and upstream errors can contain connection strings or secrets.
    process.stderr.write(
      `${
        error instanceof HostedConfigurationError || error instanceof StateError
          ? error.message
          : "Could not start the hosted service. Check the database, state directory and port."
      }\n`,
    );
    process.exitCode = 1;
  }
}
