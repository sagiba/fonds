import { memoryAdapter } from "better-auth/adapters/memory";
import { getSchema } from "better-auth/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import neonFunction from "../../../deploy/neon/function.js";

// The real Neon entry point and issuer with its database-backed rate limit, on
// in-memory auth state; the database is never contacted, so the installation
// binding (covered by tests/storage/neon-installation.test.ts) is stubbed.
vi.mock(
  "../../../src/runtime/postgres-environment.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/runtime/postgres-environment.js")
    >()),
    verifyPostgresInstallation: async () => {},
  }),
);
vi.mock("better-auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("better-auth")>();
  return {
    ...original,
    betterAuth: (options: Parameters<typeof original.betterAuth>[0]) =>
      original.betterAuth({
        ...options,
        database: memoryAdapter(
          Object.fromEntries(
            Object.keys(getSchema(options!)).map((model) => [model, []]),
          ),
        ),
      }),
  };
});

const publicOrigin = "https://fonds.synthetic.invalid";

describe("Neon auth rate limit client address", () => {
  beforeAll(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("FONDS_PUBLIC_ORIGIN", publicOrigin);
    vi.stubEnv(
      "FONDS_AUTH_SECRET",
      "synthetic-auth-secret-00000000000000000000",
    );
    vi.stubEnv("FONDS_OWNER_ID", "synthetic-owner");
    vi.stubEnv("FONDS_CREDENTIALS_KEY", "A".repeat(43));
    vi.stubEnv(
      "DATABASE_URL_UNPOOLED",
      "postgresql://synthetic:synthetic@synthetic-target.neon.tech/neondb",
    );
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const getSession = async (headers: Record<string, string>) =>
    (
      await neonFunction.fetch(
        new Request(`${publicOrigin}/api/auth/get-session`, { headers }),
      )
    ).status;

  it("keys on the right-most X-Forwarded-For entry, so left-most values cannot reset it", async () => {
    for (let i = 1; i <= 30; i += 1) {
      expect(
        await getSession({
          "X-Forwarded-For": `203.0.113.${i}, 198.51.100.1`,
          "X-Fonds-Client-Address": `203.0.113.${i}`,
        }),
        `request ${i}`,
      ).toBe(200);
    }
    expect(
      await getSession({ "X-Forwarded-For": "203.0.113.31, 198.51.100.1" }),
    ).toBe(429);
    // Another client Neon saw has its own bucket.
    expect(await getSession({ "X-Forwarded-For": "198.51.100.2" })).toBe(200);
  });

  it("passes no address for an absent or malformed right-most entry", async () => {
    const unaddressed = [
      {},
      { "X-Forwarded-For": "198.51.100.3, unknown" },
      { "X-Forwarded-For": "198.51.100.3:443" },
      { "X-Forwarded-For": "198.51.100.3, " },
    ];
    // All share one bucket, whatever Fonds header the client adds.
    for (let i = 1; i <= 30; i += 1) {
      expect(
        await getSession({
          ...unaddressed[i % unaddressed.length],
          "X-Fonds-Client-Address": `203.0.113.${i}`,
        }),
        `request ${i}`,
      ).toBe(200);
    }
    expect(await getSession({ "X-Forwarded-For": "unknown" })).toBe(429);
    expect(await getSession({ "X-Forwarded-For": "198.51.100.3" })).toBe(200);
  });
});
