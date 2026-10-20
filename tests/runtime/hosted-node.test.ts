import { connect } from "node:net";

import { memoryAdapter } from "better-auth/adapters/memory";
import { getSchema } from "better-auth/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bearerScheduleAuthenticator } from "../../src/runtime/collection-routes.js";
import {
  externalRequest,
  hostedIngress,
  hostedNodeConfiguration,
  hostedSchedule,
} from "../../src/runtime/hosted-node.js";
import {
  createHostedService,
  HostedConfigurationError,
} from "../../src/runtime/hosted-service.js";
import { listen } from "../../src/runtime/node-service.js";
import { financialPoolConfig } from "../../src/runtime/postgres-environment.js";

// The real issuer and its database-backed rate limit, on in-memory state.
// PostgreSQL storage is exercised by the hosted bootstrap suite.
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

const origin = "https://fonds.synthetic.invalid";
const secret = "synthetic-schedule-secret-000000000000000000";
const base = {
  FONDS_PUBLIC_ORIGIN: origin,
  FONDS_AUTH_SECRET: "synthetic-auth-secret-00000000000000000000",
  FONDS_OWNER_ID: "synthetic-owner",
};

describe("bearer schedule authenticator", () => {
  const authenticate = bearerScheduleAuthenticator(origin, secret);
  const request = (headers: Record<string, string>, url = origin) =>
    new Request(`${url}/internal/triggers/recent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, ...headers },
    });

  it("accepts the secret on the public origin and reuses an idempotency key", async () => {
    expect(
      await authenticate(
        request({ "Idempotency-Key": "hour-1" }),
        async () => ({}),
      ),
    ).toEqual({ invocationId: "hour-1" });
    const first = await authenticate(request({}), async () => ({}));
    const second = await authenticate(request({}), async () => ({}));
    expect(first).not.toEqual(second);
  });

  it.each([
    [{ Authorization: "Bearer wrong" }, origin, "invalid_schedule_secret"],
    [{}, "http://internal.invalid", "untrusted_origin_or_host"],
    [
      { Origin: "https://attacker.invalid" },
      origin,
      "untrusted_origin_or_host",
    ],
    [{ "Idempotency-Key": "has spaces" }, origin, "invalid_idempotency_key"],
  ])("denies %o at %s", async (headers, url, reason) => {
    let read = false;
    expect(
      await authenticate(request(headers, url), async () => {
        read = true;
        return {};
      }),
    ).toEqual({ denied: reason });
    expect(read).toBe(false);
  });

  it("requires an empty JSON object body", async () => {
    expect(
      await authenticate(request({}), async () => ({ connectionId: "x" })),
    ).toEqual({ denied: "invalid_schedule_body" });
  });
});

describe("trusted proxy requests", () => {
  it("addresses only the public Host with the public scheme to the public origin", async () => {
    const forwarded = externalRequest(
      new Request("http://fonds.synthetic.invalid/v1/connections?limit=1", {
        method: "POST",
        headers: {
          Host: "fonds.synthetic.invalid",
          "X-Forwarded-Proto": "https",
        },
        body: "{}",
      }),
      origin,
    );
    expect(forwarded.url).toBe(`${origin}/v1/connections?limit=1`);
    expect(await forwarded.text()).toBe("{}");
    for (const headers of [
      { Host: "other.invalid", "X-Forwarded-Proto": "https" },
      { Host: "fonds.synthetic.invalid", "X-Forwarded-Proto": "http" },
      { Host: "fonds.synthetic.invalid" },
    ]) {
      const unchanged = new Request("http://fonds.synthetic.invalid/v1", {
        headers,
      });
      expect(externalRequest(unchanged, origin)).toBe(unchanged);
    }
  });
});

describe("trusted client address", () => {
  const forwardedFor = (value?: string) =>
    new Request(`${origin}/api/auth/get-session`, {
      headers: value === undefined ? {} : { "X-Forwarded-For": value },
    });
  const received = async (
    trustedProxies: number,
    request: Request,
    socketAddress = "192.0.2.1",
  ) => {
    let address: string | undefined;
    await hostedIngress(
      {
        fetch: (_request, clientAddress) => {
          address = clientAddress;
          return new Response();
        },
      },
      origin,
      trustedProxies,
    )(request, socketAddress);
    return address;
  };

  it("is the socket's peer on direct ingress, whatever the headers say", async () => {
    expect(await received(0, forwardedFor("198.51.100.7"))).toBe("192.0.2.1");
    expect(await received(0, forwardedFor())).toBe("192.0.2.1");
  });

  it.each([
    [1, "198.51.100.7", "198.51.100.7"],
    [1, "203.0.113.9, 198.51.100.7", "198.51.100.7"],
    [1, "203.0.113.9,198.51.100.7", "198.51.100.7"],
    [1, "2001:db8::7", "2001:db8::7"],
    [2, "203.0.113.9, 198.51.100.7, 192.0.2.10", "198.51.100.7"],
    // Too short or malformed where a trusted proxy appended: the socket.
    [1, undefined, "192.0.2.1"],
    [1, "203.0.113.9, ", "192.0.2.1"],
    [1, "198.51.100.7:443", "192.0.2.1"],
    [1, "unknown", "192.0.2.1"],
    [2, "198.51.100.7", "192.0.2.1"],
  ])(
    "behind %i trusted proxies is the appended entry of %s",
    async (trustedProxies, header, expected) => {
      expect(await received(trustedProxies, forwardedFor(header))).toBe(
        expected,
      );
    },
  );

  it.each(["", "0", "10", "yes", "1.0"])(
    "accepts only a trusted proxy count from 1 to 9, not %o",
    (value) => {
      const parse = (FONDS_TRUST_PROXY?: string) =>
        hostedNodeConfiguration({
          ...base,
          FONDS_DATABASE_URL: "postgresql://u:p@127.0.0.1/fonds",
          ...(FONDS_TRUST_PROXY !== undefined && { FONDS_TRUST_PROXY }),
        }).trustedProxies;
      expect(parse()).toBe(0);
      expect(parse("1")).toBe(1);
      expect(parse("2")).toBe(2);
      expect(() => parse(value)).toThrow(/FONDS_TRUST_PROXY/);
    },
  );
});

describe("hosted auth rate limit", () => {
  const spoofHeaders = (i: number) => ({
    "X-Forwarded-For": `203.0.113.${i}`,
    "X-Real-IP": `203.0.113.${i}`,
    "CF-Connecting-IP": `203.0.113.${i}`,
    Forwarded: `for=203.0.113.${i}`,
    "X-Fonds-Client-Address": `203.0.113.${i}`,
  });

  /** The hosted service on a real Node listener, on in-memory auth state. */
  async function serve(trustedProxies: number) {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let handle: ReturnType<typeof hostedIngress> = () =>
      new Response(null, { status: 503 });
    const service: { close(): Promise<void> }[] = [];
    const running = await listen(
      (request, socketAddress) => handle(request, socketAddress),
      {
        stop: async () => {},
        dispose: async () => {
          await Promise.all(service.map((started) => started.close()));
        },
      },
      { hostname: "127.0.0.1", port: 0 },
    );
    const { publicOrigin, connectionString, ...config } =
      hostedNodeConfiguration({
        ...base,
        // Never contacted: auth state is in memory.
        FONDS_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/unused",
        FONDS_PUBLIC_ORIGIN: running.url,
      });
    const hosted = createHostedService(
      { ...config, publicOrigin },
      { connectionString },
    );
    service.push(hosted);
    handle = hostedIngress(hosted, publicOrigin, trustedProxies);
    const getSession = async (headers: Record<string, string>) =>
      (await fetch(`${running.url}/api/auth/get-session`, { headers })).status;
    return { running, getSession };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keys direct clients by socket address, so forwarding headers cannot reset it", async () => {
    const { running, getSession } = await serve(0);
    try {
      for (let i = 1; i <= 30; i += 1) {
        expect(await getSession(spoofHeaders(i)), `request ${i}`).toBe(200);
      }
      expect(await getSession(spoofHeaders(31))).toBe(429);
      expect(await getSession({})).toBe(429);
    } finally {
      await running.close();
    }
  });

  it("keys proxied clients by the address the trusted proxy appended", async () => {
    const { running, getSession } = await serve(1);
    try {
      for (let i = 1; i <= 30; i += 1) {
        expect(
          await getSession({
            ...spoofHeaders(i),
            "X-Forwarded-For": `203.0.113.${i}, 198.51.100.1`,
          }),
          `request ${i}`,
        ).toBe(200);
      }
      // A different left-most value is still the same client.
      expect(
        await getSession({
          ...spoofHeaders(31),
          "X-Forwarded-For": "203.0.113.31, 198.51.100.1",
        }),
      ).toBe(429);
      // A different client behind the same proxy has its own bucket.
      expect(await getSession({ "X-Forwarded-For": "198.51.100.2" })).toBe(200);
      // Without an appended address the proxy's own socket address is used.
      expect(await getSession({})).toBe(200);
    } finally {
      await running.close();
    }
  });

  it("ignores a client-supplied address when the ingress trusts none", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { connectionString, ...config } = hostedNodeConfiguration({
      ...base,
      FONDS_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/unused",
    });
    // Neon's entry point passes no client address.
    const hosted = createHostedService(config, { connectionString });
    try {
      const getSession = async (i: number) =>
        (
          await hosted.fetch(
            new Request(`${origin}/api/auth/get-session`, {
              headers: spoofHeaders(i),
            }),
          )
        ).status;
      for (let i = 1; i <= 30; i += 1) {
        expect(await getSession(i), `request ${i}`).toBe(200);
      }
      expect(await getSession(31)).toBe(429);
    } finally {
      await hosted.close();
    }
  });
});

describe("hosted configuration", () => {
  it.each([
    ["postgresql://u:p@db.example.invalid/fonds", false],
    ["postgresql://u:p@db.example.invalid/fonds?sslmode=verify-full", true],
    ["postgresql://u:p@127.0.0.1/fonds", true],
  ])("requires TLS for non-loopback databases: %s", (url, accepted) => {
    const parse = () =>
      hostedNodeConfiguration({ ...base, FONDS_DATABASE_URL: url });
    if (accepted) {
      expect(parse()).toMatchObject({ host: "127.0.0.1", port: 8787 });
    } else {
      expect(parse).toThrow(/sslmode=verify-full/);
      expect(
        hostedNodeConfiguration({
          ...base,
          FONDS_DATABASE_URL: url,
          FONDS_DATABASE_TLS: "disable",
        }).connectionString,
      ).toBe(url);
    }
  });
});

describe("hosted collection schedule", () => {
  const database = {
    ...base,
    FONDS_DATABASE_URL: "postgresql://u:p@127.0.0.1/fonds",
  };
  const schedule = (settings: Record<string, string>, stored = "07:07") =>
    hostedSchedule(
      hostedNodeConfiguration({ ...database, ...settings }).scheduleSettings,
      stored,
    );

  it("is off unless set, and parses daily, hourly and hour lists in a zone", () => {
    expect(schedule({})).toBeUndefined();
    expect(schedule({ FONDS_REFRESH_SCHEDULE: "off" })).toBeUndefined();
    expect(
      schedule({
        FONDS_REFRESH_SCHEDULE: "13,9",
        FONDS_REFRESH_TIMEZONE: "Europe/London",
      }),
    ).toEqual({
      mode: "hours",
      hours: [9, 13],
      minute: 7,
      timeZone: "Europe/London",
    });
  });

  it("uses the stored random time unless the operator pins one", () => {
    expect(schedule({ FONDS_REFRESH_SCHEDULE: "daily" })).toMatchObject({
      hours: [7],
      minute: 7,
    });
    expect(
      schedule({
        FONDS_REFRESH_SCHEDULE: "daily",
        FONDS_REFRESH_TIME: "22:45",
      }),
    ).toMatchObject({ hours: [22], minute: 45 });
  });

  it("reports schedule mistakes before startup, without their values", () => {
    for (const [settings, message] of [
      [
        { FONDS_REFRESH_SCHEDULE: "9,99" },
        "FONDS_REFRESH_SCHEDULE must be daily, hourly or hours 0-23 such as 9,13,18",
      ],
      [
        { FONDS_REFRESH_SCHEDULE: "daily", FONDS_REFRESH_TIME: "25:00" },
        "FONDS_REFRESH_TIME must be a 24-hour HH:MM time",
      ],
      [
        {
          FONDS_REFRESH_SCHEDULE: "hourly",
          FONDS_REFRESH_TIMEZONE: "Nowhere/Synthetic",
        },
        "FONDS_REFRESH_TIMEZONE must be an IANA time zone such as Europe/London",
      ],
    ] as const) {
      let error: unknown;
      try {
        hostedNodeConfiguration({ ...database, ...settings });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(HostedConfigurationError);
      expect((error as Error).message).toBe(message);
    }
  });

  it("needs the collection secret that enables scheduled runs", () => {
    const { scheduleSettings, connectionString, ...config } =
      hostedNodeConfiguration({
        ...database,
        FONDS_REFRESH_SCHEDULE: "daily",
      });
    expect(() =>
      createHostedService(config, {
        connectionString,
        embeddedScheduler: {
          schedule: hostedSchedule(scheduleSettings, "01:02"),
        },
      }),
    ).toThrow("FONDS_REFRESH_SCHEDULE needs FONDS_REFRESH_SECRET");
  });
});

describe("database URL parameters", () => {
  it.each([
    "postgresql://u:p@db.example.invalid/fonds?sslmode=verify-full&sslmode=disable",
    "postgresql://u:p@127.0.0.1/fonds?host=db.example.invalid&sslmode=disable",
    "postgresql://u:p@127.0.0.1/fonds?options=-c%20search_path%3Dpublic",
    "mysql://u:p@127.0.0.1/fonds",
  ])("rejects parameters that would change host, TLS or schema: %s", (url) => {
    expect(() =>
      hostedNodeConfiguration({
        ...base,
        FONDS_DATABASE_URL: url,
        FONDS_DATABASE_TLS: "disable",
      }),
    ).toThrow(/at most one sslmode parameter/);
    expect(() => financialPoolConfig(url)).toThrow();
  });
});

it("rejects transaction-pooler endpoints, which break the collection lock", () => {
  expect(() =>
    hostedNodeConfiguration({
      ...base,
      FONDS_DATABASE_URL:
        "postgresql://u:p@ep-synthetic-pooler.example.invalid/db?sslmode=verify-full",
    }),
  ).toThrow(/FONDS_DATABASE_URL/);
});

describe("Node HTTP boundary", () => {
  it("rejects absolute-form request targets that claim another scheme", async () => {
    const running = await listen(
      async () => new Response("served"),
      { stop: async () => {} },
      { hostname: "127.0.0.1", port: 0 },
    );
    try {
      const { port } = new URL(running.url);
      const status = (target: string) =>
        new Promise<string>((resolve, reject) => {
          const socket = connect(Number(port), "127.0.0.1", () =>
            socket.write(
              `GET ${target} HTTP/1.1\r\nHost: fonds.synthetic.invalid\r\nConnection: close\r\n\r\n`,
            ),
          );
          let text = "";
          socket.on("data", (chunk) => (text += chunk));
          socket.on("end", () => resolve(text.split("\r\n")[0]!));
          socket.on("error", reject);
        });
      expect(await status("https://fonds.synthetic.invalid/v1")).toMatch(
        / 400 /,
      );
      expect(await status("/v1")).toMatch(/ 200 /);
    } finally {
      await running.close();
    }
  });
});
