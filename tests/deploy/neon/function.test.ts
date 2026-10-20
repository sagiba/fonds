import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNeonService,
  neonConfiguration,
  REFRESH_TRIGGER_NAME,
} from "../../../deploy/neon/function.js";
import { generateCredentialsKey } from "../../../src/runtime/credential-vault.js";

// Keep the actual Neon target, HTTP boundary, poller and database pool wiring.
// These rejected requests must never reach authentication storage or collection.
vi.mock("../../../src/runtime/auth/better-auth.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/runtime/auth/better-auth.js")
  >()),
  createBetterAuth: () => ({
    provider: {
      issuer: "https://fonds.synthetic.invalid/api/auth",
      authenticate: async () => null,
    },
    handlePublicRequest: async () => null,
    hasActiveEventReadGrant: async () => false,
  }),
}));

const publicOrigin = "https://fonds.synthetic.invalid";
const internalOrigin = "http://neon-internal.invalid";
const operatorSecret = "synthetic-operator-token-00000000000000000000";
const invocationId = "synthetic-native-invocation";
const environment = {
  FONDS_PUBLIC_ORIGIN: publicOrigin,
  FONDS_AUTH_SECRET: "synthetic-auth-secret-00000000000000000000",
  FONDS_OWNER_ID: "synthetic-owner",
  DATABASE_URL_UNPOOLED:
    "postgresql://synthetic:synthetic@synthetic-target.neon.tech/neondb",
  FONDS_REFRESH_SECRET: operatorSecret,
  FONDS_CONNECTION_ID: "primary",
  FONDS_CONNECTION_PROVIDER: "cal",
  FONDS_CONNECTION_CREDENTIALS: JSON.stringify({
    username: "synthetic-user",
    password: "synthetic-password",
  }),
};

function nativeRequest(attested = true) {
  return new Request(`${internalOrigin}/internal/triggers/recent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Native dispatch must not depend on matching the public URL or Host.
      Host: "different-native-host.invalid",
      ...(attested ? { "X-Neon-Trigger-Invocation-Id": invocationId } : {}),
    },
    body: JSON.stringify({
      version: 1,
      invocation_id: invocationId,
      trigger: { type: "schedule", id: "trigger-1", name: "other-trigger" },
      data: { scheduled_at: "2040-01-01T00:00:00Z" },
    }),
  });
}

describe("Neon native trigger target dispatch", () => {
  let service: ReturnType<typeof createNeonService>;
  let connect: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    connect = vi.spyOn(Pool.prototype, "connect");
    service = createNeonService(environment);
  });

  afterEach(async () => {
    try {
      await service?.close();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("dispatches attested internal URLs to the native envelope gate before the public host guard", async () => {
    const response = await service.fetch(nativeRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(
      vi
        .mocked(console.info)
        .mock.calls.map(([message]) => JSON.parse(String(message))),
    ).toContainEqual({
      event: "fonds_native_trigger_denied",
      reason: "wrong_trigger",
    });
  });

  it("rejects the internal native route without Neon attestation", async () => {
    const response = await service.fetch(nativeRequest(false));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(
      vi
        .mocked(console.info)
        .mock.calls.map(([message]) => JSON.parse(String(message))),
    ).toContainEqual({
      event: "fonds_native_trigger_denied",
      reason: "missing_trigger_attestation",
    });
  });

  it.each([
    { "Content-Type": "text/plain", body: "not json" },
    { "Content-Type": "application/json", body: "x".repeat(8193) },
  ])(
    "denies unattested native requests before reading their body: %o",
    async ({ body, ...headers }) => {
      const request = new Request(
        `${internalOrigin}/internal/triggers/recent`,
        { method: "POST", headers, body },
      );
      const response = await service.fetch(request);
      expect(response.status).toBe(403);
      expect(request.bodyUsed).toBe(false);
      expect(
        vi
          .mocked(console.info)
          .mock.calls.map(([message]) => JSON.parse(String(message))),
      ).toContainEqual({
        event: "fonds_native_trigger_denied",
        reason: "missing_trigger_attestation",
      });
    },
  );

  it.each([
    "/internal/collect/recent",
    "/v1/connections",
    "/internal/triggers/recent-extra",
  ])(
    "keeps the shared host guard for internal requests to %s",
    async (path) => {
      const response = await service.fetch(
        new Request(`${internalOrigin}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${operatorSecret}`,
            "X-Neon-Trigger-Invocation-Id": invocationId,
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { code: "forbidden", message: "Untrusted host." },
      });
    },
  );

  it("keeps bearer authentication on the public MCP endpoint", async () => {
    const response = await service.fetch(new Request(`${publicOrigin}/mcp`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required." },
    });
  });
});

describe("Neon configuration", () => {
  it("parses the Function environment once into typed settings", () => {
    const config = neonConfiguration({
      ...environment,
      FONDS_NEON_GOOGLE_AUTH_URL:
        "https://ep-synthetic.neonauth.neon.tech/auth/",
      FONDS_GOOGLE_OWNER_EMAIL: "Owner@Synthetic.invalid",
    });
    expect(config).toMatchObject({
      publicOrigin,
      ownerId: "synthetic-owner",
      ownerEmail: "owner@fonds.invalid",
      google: {
        upstreamURL: "https://ep-synthetic.neonauth.neon.tech/auth",
        allowedEmail: "owner@synthetic.invalid",
      },
      collection: {
        configured: { connectionId: "primary", provider: "cal" },
      },
    });
    expect(new URL(config.connectionString).searchParams.get("sslmode")).toBe(
      "verify-full",
    );
  });

  it("selects Isracard with its own credential fields and an independent connection ID", () => {
    const config = neonConfiguration({
      ...environment,
      FONDS_CONNECTION_PROVIDER: "isracard",
      FONDS_CONNECTION_ID: "second-card-account",
      FONDS_CONNECTION_CREDENTIALS: JSON.stringify({
        username: "synthetic-user",
        password: "synthetic-password",
        cardSuffix: "001234",
      }),
    });
    expect(config.collection?.configured).toMatchObject({
      provider: "isracard",
      connectionId: "second-card-account",
      credentials: { cardSuffix: "001234" },
    });
  });

  it.each([
    { FONDS_CONNECTION_PROVIDER: "unsupported" },
    { FONDS_CONNECTION_PROVIDER: "constructor" },
    { FONDS_CONNECTION_CREDENTIALS: "synthetic-private-invalid-json" },
    { FONDS_CONNECTION_PROVIDER: "isracard" },
  ])(
    "rejects unsupported providers or invalid credentials without revealing values: %o",
    (override) => {
      expect(() => neonConfiguration({ ...environment, ...override })).toThrow(
        /^Invalid collection provider or credentials configuration$/,
      );
    },
  );

  it("accepts optional sign-in providers only as complete client pairs", () => {
    expect(
      neonConfiguration({
        ...environment,
        FONDS_GITHUB_CLIENT_ID: "synthetic-github-client",
        FONDS_GITHUB_CLIENT_SECRET: "synthetic-github-secret",
      }).socialLogin,
    ).toEqual({
      github: {
        clientId: "synthetic-github-client",
        clientSecret: "synthetic-github-secret",
      },
    });
    expect(neonConfiguration(environment)).not.toHaveProperty("socialLogin");
    expect(() =>
      neonConfiguration({
        ...environment,
        FONDS_GOOGLE_CLIENT_ID: "synthetic-google-client",
      }),
    ).toThrow(/^Incomplete sign-in provider configuration$/);
  });

  it("names invalid variables without echoing their values", () => {
    const secret = "short-secret-value";
    expect(() =>
      neonConfiguration({
        ...environment,
        FONDS_AUTH_SECRET: secret,
        DATABASE_URL_UNPOOLED: "postgresql://user:pw@elsewhere.example/db",
      }),
    ).toThrow(
      /^Invalid Neon configuration: FONDS_AUTH_SECRET, DATABASE_URL_UNPOOLED$/,
    );
  });

  it("rejects whitespace in a connection ID rather than changing the seeded identity", () => {
    expect(() =>
      neonConfiguration({
        ...environment,
        FONDS_CONNECTION_ID: " primary ",
      }),
    ).toThrow("FONDS_CONNECTION_ID");
  });

  it.each([
    { FONDS_GOOGLE_OWNER_EMAIL: "owner@synthetic.invalid" },
    { FONDS_CONNECTION_CREDENTIALS: undefined },
  ])("rejects incomplete optional groups: %o", (override) => {
    expect(() => neonConfiguration({ ...environment, ...override })).toThrow(
      /^Incomplete (Neon Google|collection) configuration$/,
    );
  });

  it("uploads provider credentials only from a private regular file", async () => {
    const { chmod, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const directory = await mkdtemp(`${tmpdir()}/fonds-neon-provider-`);
    const file = `${directory}/provider-creds`;
    for (const name of [
      "FONDS_PUBLIC_ORIGIN",
      "FONDS_OWNER_ID",
      "FONDS_AUTH_SECRET",
      "FONDS_CONNECTION_ID",
      "FONDS_CONNECTION_PROVIDER",
      "FONDS_REFRESH_SECRET",
      "FONDS_NEON_GOOGLE_AUTH_URL",
      "FONDS_GOOGLE_OWNER_EMAIL",
    ]) {
      vi.stubEnv(name, `synthetic-${name}`);
    }
    vi.stubEnv("FONDS_CONNECTION_CREDENTIALS_FILE", file);
    vi.stubEnv("FONDS_CONNECTION_PROVIDER", "cal");
    try {
      await writeFile(
        file,
        JSON.stringify({
          username: "synthetic-user",
          password: "synthetic:pass",
        }),
        { mode: 0o600 },
      );
      vi.resetModules();
      const { default: config } = await import("../../../neon.js");
      expect(config.functions?.fonds?.env).toMatchObject({
        FONDS_CONNECTION_CREDENTIALS: JSON.stringify({
          username: "synthetic-user",
          password: "synthetic:pass",
        }),
      });
      const { loadConfigFromFile } = await import("@neon/config/v1");
      const loaded = await loadConfigFromFile({
        path: new URL("../../../neon.ts", import.meta.url).pathname,
      });
      expect(loaded.config.functions?.fonds?.source).toBe(
        "deploy/neon/function.ts",
      );
      for (const [provider, credentials] of [
        [
          "cal",
          { user: "SYNTHETIC-DO-NOT-ECHO", pass: "SYNTHETIC-DO-NOT-ECHO" },
        ],
        [
          "isracard",
          {
            username: "SYNTHETIC-DO-NOT-ECHO",
            password: "SYNTHETIC-DO-NOT-ECHO",
          },
        ],
        [
          "isracard",
          {
            username: "SYNTHETIC-DO-NOT-ECHO",
            password: "SYNTHETIC-DO-NOT-ECHO",
            cardSuffix: "001234",
            token: "extra",
          },
        ],
      ] as const) {
        vi.stubEnv("FONDS_CONNECTION_PROVIDER", provider);
        await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
        vi.resetModules();
        await expect(import("../../../neon.js")).rejects.toThrow(
          /^Provider credentials file does not match the configured provider$/,
        );
      }
      await writeFile(
        file,
        JSON.stringify({
          username: "synthetic-user",
          password: "synthetic-password",
          cardSuffix: "001234",
        }),
        { mode: 0o600 },
      );
      vi.resetModules();
      const { default: selected } = await import("../../../neon.js");
      expect(
        JSON.parse(
          selected.functions!.fonds!.env!.FONDS_CONNECTION_CREDENTIALS!,
        ),
      ).toMatchObject({ cardSuffix: "001234" });
      await chmod(file, 0o644);
      vi.resetModules();
      await expect(import("../../../neon.js")).rejects.toThrow("private 0600");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("matches the deployment declared in the repository neon.ts", async () => {
    for (const name of [
      "FONDS_PUBLIC_ORIGIN",
      "FONDS_OWNER_ID",
      "FONDS_AUTH_SECRET",
      "FONDS_CONNECTION_ID",
      "FONDS_CONNECTION_PROVIDER",
      "FONDS_REFRESH_SECRET",
      "FONDS_NEON_GOOGLE_AUTH_URL",
      "FONDS_GOOGLE_OWNER_EMAIL",
    ]) {
      vi.stubEnv(name, `synthetic-${name}`);
    }
    vi.stubEnv("FONDS_CONNECTION_CREDENTIALS_FILE", undefined);
    vi.stubEnv("FONDS_REFRESH_SCHEDULE", undefined);
    try {
      const { default: config } = await import("../../../neon.js");
      // Literal on both sides: the declaration and the function's envelope
      // gate must name the same trigger, or every native invocation is denied.
      expect(REFRESH_TRIGGER_NAME).toBe("scheduled-refresh");
      expect(Object.keys(config.triggers ?? {})).toEqual(["scheduled-refresh"]);
      expect(config.triggers?.[REFRESH_TRIGGER_NAME]).toEqual({
        type: "schedule",
        function: "fonds",
        cron: "12 * * * *",
        functionPath: "/internal/triggers/recent",
        // Fresh environments never start collecting on their first deploy.
        enabled: false,
      });
      const fonds = config.functions?.fonds;
      expect(fonds?.source).toBe("deploy/neon/function.ts");
      // Omitted credential variables are merged by Neon, never cleared or guessed.
      expect(Object.keys(fonds?.env ?? {}).sort()).toEqual([
        "FONDS_AUTH_SECRET",
        "FONDS_CONNECTION_ID",
        "FONDS_CONNECTION_PROVIDER",
        "FONDS_GOOGLE_OWNER_EMAIL",
        "FONDS_NEON_GOOGLE_AUTH_URL",
        "FONDS_OWNER_ID",
        "FONDS_PUBLIC_ORIGIN",
        "FONDS_REFRESH_SECRET",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("derives the trigger's UTC cron from the schedule, time and zone", async () => {
    for (const name of [
      "FONDS_PUBLIC_ORIGIN",
      "FONDS_OWNER_ID",
      "FONDS_AUTH_SECRET",
      "FONDS_CONNECTION_ID",
      "FONDS_CONNECTION_PROVIDER",
      "FONDS_REFRESH_SECRET",
      "FONDS_NEON_GOOGLE_AUTH_URL",
      "FONDS_GOOGLE_OWNER_EMAIL",
    ]) {
      vi.stubEnv(name, `synthetic-${name}`);
    }
    vi.stubEnv("FONDS_CONNECTION_CREDENTIALS_FILE", undefined);
    const trigger = async (settings: Record<string, string | undefined>) => {
      for (const [name, value] of Object.entries(settings)) {
        vi.stubEnv(name, value);
      }
      vi.resetModules();
      const { default: config } = await import("../../../neon.js");
      const declared = config.triggers?.[REFRESH_TRIGGER_NAME];
      return declared?.type === "schedule"
        ? { cron: declared.cron, enabled: declared.enabled }
        : undefined;
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
    try {
      expect(
        await trigger({
          FONDS_REFRESH_SCHEDULE: "daily",
          FONDS_REFRESH_TIME: "03:17",
          FONDS_REFRESH_TIMEZONE: undefined,
        }),
      ).toEqual({ cron: "17 3 * * *", enabled: true });
      // Hourly runs at the installation's random minute.
      expect(await trigger({ FONDS_REFRESH_SCHEDULE: "hourly" })).toEqual({
        cron: "17 * * * *",
        enabled: true,
      });
      expect(
        await trigger({
          FONDS_REFRESH_SCHEDULE: "9,13,18",
          FONDS_REFRESH_TIMEZONE: "Asia/Jerusalem",
        }),
      ).toEqual({ cron: "17 7,11,16 * * *", enabled: true });
      // Off, like any unrecognized word, keeps the declared cron, whatever
      // the time.
      for (const value of ["off", "enabled"]) {
        expect(await trigger({ FONDS_REFRESH_SCHEDULE: value })).toEqual({
          cron: "12 * * * *",
          enabled: false,
        });
      }
      vi.stubEnv("FONDS_REFRESH_TIME", undefined);
      await expect(
        trigger({ FONDS_REFRESH_SCHEDULE: "daily" }),
      ).rejects.toThrow(
        "FONDS_REFRESH_SCHEDULE is on but FONDS_REFRESH_TIME is missing; rerun npm run neon:setup",
      );
      await expect(
        trigger({
          FONDS_REFRESH_SCHEDULE: "9,24",
          FONDS_REFRESH_TIME: "03:17",
        }),
      ).rejects.toThrow(/hours 0-23/);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("forwards a valid credentials key so stored connections are collected", async () => {
    for (const name of [
      "FONDS_PUBLIC_ORIGIN",
      "FONDS_OWNER_ID",
      "FONDS_AUTH_SECRET",
      "FONDS_CONNECTION_ID",
      "FONDS_CONNECTION_PROVIDER",
      "FONDS_REFRESH_SECRET",
      "FONDS_NEON_GOOGLE_AUTH_URL",
      "FONDS_GOOGLE_OWNER_EMAIL",
    ]) {
      vi.stubEnv(name, `synthetic-${name}`);
    }
    vi.stubEnv("FONDS_CONNECTION_CREDENTIALS_FILE", undefined);
    try {
      const key = generateCredentialsKey();
      vi.stubEnv("FONDS_CREDENTIALS_KEY", key);
      vi.resetModules();
      const { default: config } = await import("../../../neon.js");
      expect(config.functions?.fonds?.env?.FONDS_CREDENTIALS_KEY).toBe(key);
      vi.stubEnv("FONDS_CREDENTIALS_KEY", "not-a-key");
      vi.resetModules();
      await expect(import("../../../neon.js")).rejects.toThrow(
        "FONDS_CREDENTIALS_KEY is not a valid credentials key",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
