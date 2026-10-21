import { attachDatabasePool, waitUntil } from "@neon/functions";
import { parseTriggerInvocation } from "@neon/functions/triggers";
import { Pool } from "pg";
import { z } from "zod";

import type { ScheduledRequestAuthenticator } from "../../src/runtime/collection-routes.js";
import {
  createHostedService,
  forwardedAddress,
  hostedConfiguration,
  HostedConfigurationError,
  hostedEnvironmentSchema,
  logEvent,
  parseHostedEnvironment,
} from "../../src/runtime/hosted-service.js";
import {
  neonInstallation,
  verifyPostgresInstallation,
} from "../../src/runtime/postgres-environment.js";
import { StateError } from "../../src/runtime/state.js";
import { neonGoogleLogin } from "./neon-login.js";

/**
 * Must match the trigger declared in the repository's neon.ts. Renaming it
 * gives deployed installations a second trigger instead of updating theirs.
 */
export const REFRESH_TRIGGER_NAME = "scheduled-refresh";

const emailSchema = z.string().regex(/^[^\s@]+@[^\s@]+$/);
const scheduledAtSchema = z.iso.datetime({ offset: true });

const neonEnvironmentSchema = hostedEnvironmentSchema.extend({
  // Native libpq/pg transactions and schema selection use the direct endpoint.
  // Never fall back to a different database when its configuration is missing.
  DATABASE_URL_UNPOOLED: z
    .url({ protocol: /^postgres(ql)?$/, hostname: /\.neon\.tech$/ })
    .transform((value) => {
      const url = new URL(value);
      url.searchParams.set("sslmode", "verify-full");
      return url.href;
    }),
  FONDS_NEON_GOOGLE_AUTH_URL: z
    .url({ protocol: /^https$/, hostname: /\.neon\.tech$/ })
    .refine((value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash;
    })
    .transform((value) => value.replace(/\/$/, ""))
    .optional(),
  FONDS_GOOGLE_OWNER_EMAIL: emailSchema.optional(),
});

/** Parse the Function environment once; inner modules receive typed values. */
export function neonConfiguration(env: NodeJS.ProcessEnv) {
  const values = parseHostedEnvironment(neonEnvironmentSchema, env, "Neon");
  if (
    (values.FONDS_NEON_GOOGLE_AUTH_URL === undefined) !==
    (values.FONDS_GOOGLE_OWNER_EMAIL === undefined)
  ) {
    throw new HostedConfigurationError("Incomplete Neon Google configuration");
  }
  return {
    ...hostedConfiguration(values),
    connectionString: values.DATABASE_URL_UNPOOLED,
    ...(values.FONDS_NEON_GOOGLE_AUTH_URL &&
      values.FONDS_GOOGLE_OWNER_EMAIL && {
        google: {
          upstreamURL: values.FONDS_NEON_GOOGLE_AUTH_URL,
          allowedEmail: values.FONDS_GOOGLE_OWNER_EMAIL.toLowerCase(),
        },
      }),
  };
}

/**
 * Native Neon invocations use an internal URL/Host. Their caller identity comes
 * from Neon's reserved attestation header plus the validated envelope; the
 * public ingress strips caller-supplied X-Neon-* headers.
 */
export function neonTriggerAuthenticator(
  triggerName: string,
): ScheduledRequestAuthenticator {
  return async (request, readBody) => {
    if (!request.headers.get("x-neon-trigger-invocation-id")) {
      return { denied: "missing_trigger_attestation" };
    }
    const parsed = parseTriggerInvocation({
      headers: request.headers,
      body: await readBody(),
    });
    if (!parsed.ok) {
      return { denied: "invalid_trigger_envelope" };
    }
    if (parsed.invocation.trigger.name !== triggerName) {
      return { denied: "wrong_trigger" };
    }
    if (
      !scheduledAtSchema.safeParse(parsed.invocation.data.scheduledAt).success
    ) {
      return { denied: "invalid_schedule_metadata" };
    }
    return {
      invocationId: parsed.invocation.invocationId,
      scheduledAt: Date.parse(parsed.invocation.data.scheduledAt),
    };
  };
}

export function createNeonService(env: NodeJS.ProcessEnv) {
  const { connectionString, google, ...config } = neonConfiguration(env);
  const onUnexpectedError = () =>
    console.error("Neon database connection failed.");
  return createHostedService(config, {
    connectionString,
    attachPool: (pool) => attachDatabasePool(pool, { onUnexpectedError }),
    ...(google && { googleLogin: neonGoogleLogin(google) }),
    // An invocation lives at most 15 minutes; a longer refresh continues in a
    // new one, and the runtime keeps each alive until its refresh or its
    // write's delivery settles.
    refreshExecution: { background: waitUntil, budgetMs: 14 * 60_000 },
    scheduler: {
      authenticate: neonTriggerAuthenticator(REFRESH_TRIGGER_NAME),
      internalIngress: true,
    },
  });
}

/**
 * The private env file is Neon's state: `neon:setup` binds the database to
 * its secrets as it provisions the schemas, and the Function serves only a
 * database bound to the same ones.
 */
export function verifyNeonDatabase(pool: Pool, env: NodeJS.ProcessEnv) {
  return verifyPostgresInstallation(pool, neonInstallation(env).fingerprint);
}

let verified: Promise<void> | undefined;

/** Checked once per instance, before the first request is served. */
function ensureVerified(env: NodeJS.ProcessEnv) {
  verified ??= (async () => {
    const pool = new Pool({
      connectionString: neonConfiguration(env).connectionString,
      max: 1,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 30_000,
      options: "-c search_path=financial",
    });
    pool.on("error", () => {});
    try {
      await verifyNeonDatabase(pool, env);
    } finally {
      await pool.end();
    }
  })().catch((error: unknown) => {
    // A later request retries a transient failure; a refusal fails again.
    verified = undefined;
    throw error;
  });
  return verified;
}

let service: ReturnType<typeof createNeonService> | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      await ensureVerified(process.env);
      service ??= createNeonService(process.env);
      // The Function sees no socket. If Neon's ingress appends to or replaces
      // X-Forwarded-For, its right-most entry is the client Neon saw; if it
      // passes the header through, the client chooses it. Neon's behavior is
      // unverified.
      return await service.fetch(request, forwardedAddress(request, 1));
    } catch (error) {
      // Upstream diagnostics can contain secrets: log only our own fixed
      // configuration messages, otherwise the error class.
      logEvent("fonds_unhandled_error", {
        name: error instanceof Error ? error.name : "unknown",
        ...((error instanceof HostedConfigurationError ||
          error instanceof StateError) && { message: error.message }),
      });
      return Response.json(
        { error: { code: "unavailable", message: "Service unavailable." } },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
};
