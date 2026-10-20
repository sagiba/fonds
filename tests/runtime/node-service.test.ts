import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DRAIN_DEADLINE_MS,
  listen,
  runNodeService,
  serviceOptionsFromEnvironment,
  startNodeService,
} from "../../src/runtime/node-service.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["postgres", "turso"])(
  "starts the %s artifact main through an ordinary or symlinked path",
  async (backend) => {
    const directory = mkdtempSync(join(tmpdir(), "fonds-launcher-regression-"));
    try {
      await build({
        entryPoints: [
          fileURLToPath(
            new URL(`../../src/targets/${backend}.ts`, import.meta.url),
          ),
        ],
        outfile: join(directory, "server.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
      });
      symlinkSync(
        fileURLToPath(new URL("../../node_modules", import.meta.url)),
        join(directory, "node_modules"),
        "dir",
      );
      symlinkSync(directory, join(directory, "linked"), "dir");
      for (const entry of [
        join(directory, "server.mjs"),
        join(directory, "linked/server.mjs"),
      ]) {
        const result = spawnSync(process.execPath, [entry], {
          env: { ...process.env, FONDS_API_TOKEN: "", FONDS_DATABASE_URL: "" },
          encoding: "utf8",
          timeout: 20_000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          backend === "postgres"
            ? "FONDS_STATE_DIR is required"
            : "Could not start service.",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

it("prints the turso artifact's usage for --help and rejects unknown commands", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-turso-help-"));
  try {
    await build({
      entryPoints: [
        fileURLToPath(new URL("../../src/targets/turso.ts", import.meta.url)),
      ],
      outfile: join(directory, "server.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
    });
    symlinkSync(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(directory, "server.mjs"), ...args], {
        env: { ...process.env, FONDS_API_TOKEN: "", FONDS_DATABASE_URL: "" },
        encoding: "utf8",
        timeout: 20_000,
      });
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Fonds — Turso/libSQL target");
    expect(help.stdout).toContain("  list-transactions");
    expect(help.stderr).toBe("");
    const unknown = run("no-such-command");
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toBe("Unknown command. Use --help for usage.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

it("keeps both failed startup and failed cleanup diagnostics private", async () => {
  vi.stubEnv("FONDS_API_TOKEN", "synthetic-launcher-token-00000000000000000");
  vi.stubEnv("PORT", "0");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const db = await openDatabase(":memory:");
  try {
    await expect(
      runNodeService(async () => ({
        ...db,
        listConnections: async () => {
          throw new Error("SQL contains synthetic-private-data");
        },
        close: async () => {
          throw new Error("synthetic-private-credential");
        },
      })),
    ).resolves.toBeUndefined();
    const diagnostic = stderr.mock.calls.flat().join("");
    expect(diagnostic).toContain("Could not start service.");
    expect(diagnostic).not.toContain("synthetic-private");
    expect(process.exitCode).toBe(1);
  } finally {
    await db.close();
  }
});

it("drains an in-flight async operation before closing HTTP", async () => {
  const db = await openDatabase(":memory:");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startNodeService(
    {
      ...db,
      listConnections: async () => {
        entered();
        await barrier;
        return db.listConnections();
      },
    },
    { token: "synthetic-drain-token-0000000000000000000", port: 0 },
  );
  try {
    const response = fetch(`${service.url}/v1/connections`, {
      headers: {
        Authorization: "Bearer synthetic-drain-token-0000000000000000000",
      },
    });
    await started;
    const closing = service.close();
    release();
    expect((await response).status).toBe(200);
    // The finished response's keep-alive connection must not hold close open
    // until the client's idle timeout or the five-second forced close.
    const closeStarted = performance.now();
    await closing;
    expect(performance.now() - closeStarted).toBeLessThan(1_000);
  } finally {
    release();
    await service.close();
    await db.close();
  }
});

/** A modern MCP subscription stream, which stays open until shutdown ends it. */
function openSubscriptionStream(url: string, token: string) {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "subscriptions/listen",
      params: {
        notifications: { toolsListChanged: true },
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: {
            name: "synthetic-drain-test",
            version: "1",
          },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
}

it("ends MCP subscription streams on close after a garbage collection", async () => {
  const token = "synthetic-mcp-gc-token-0000000000000000";
  const db = await openDatabase(":memory:");
  const service = await startNodeService(db, { token, port: 0 });
  try {
    const subscription = await openSubscriptionStream(service.url, token);
    const reader = subscription.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    // Collects whatever only weakly links the stream to the shutdown signal.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    for (let round = 0; round < 3; round += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const closing = service.close();
    // A stream that stop() missed is cut at the drain deadline instead.
    for (let chunk = await reader.read(); !chunk.done;) {
      chunk = await reader.read();
    }
    await closing;
  } finally {
    await service.close();
    await db.close();
  }
}, 15_000);

it("ends MCP subscription streams but finishes accepted MCP calls on close", async () => {
  const token = "synthetic-mcp-drain-token-00000000000000";
  const db = await openDatabase(":memory:");
  let entered = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startNodeService(
    {
      ...db,
      listConnections: async () => {
        entered += 1;
        await barrier;
        return db.listConnections();
      },
    },
    { token, port: 0 },
  );
  const client = (mode: "legacy" | { pin: "2026-07-28" }) =>
    new Client(
      { name: "synthetic-drain-test", version: "1" },
      { versionNegotiation: { mode } },
    );
  const modern = client({ pin: "2026-07-28" });
  const legacy = client("legacy");
  try {
    const subscription = await openSubscriptionStream(service.url, token);
    expect(subscription.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    const reader = subscription.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const streamEnded = (async () => {
      while (!(await reader.read()).done) {
        /* The stream ends when shutdown begins. */
      }
    })();
    await modern.connect(
      new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    // Legacy requests are not cross-checked: a misleading Mcp-Method header
    // must not mark an ordinary call as a subscription stream.
    await legacy.connect(
      new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            "Mcp-Method": "subscriptions/listen",
          },
        },
      }),
    );
    const calls = [modern, legacy].map((connected) =>
      connected.callTool({ name: "list_connections", arguments: {} }),
    );
    await vi.waitFor(() => expect(entered).toBe(2));
    const closeStarted = performance.now();
    const closing = service.close();
    await streamEnded;
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    for (const result of await Promise.all(calls)) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: [] });
    }
    await closing;
    expect(performance.now() - closeStarted).toBeLessThan(DRAIN_DEADLINE_MS);
  } finally {
    release();
    await Promise.all([modern.close(), legacy.close()]);
    await service.close();
    await db.close();
  }
});

it("delivers buffered pipelined responses before closing their connection", async () => {
  const token = "synthetic-pipeline-token-000000000000000";
  const db = await openDatabase(":memory:");
  await db.ensureConnection({ id: "synthetic-cal", provider: "cal" });
  const [connection] = await db.listConnections();
  // Large responses stay buffered while the client is paused, so an ended
  // pipelined response is not yet written when earlier ones finish.
  const connections = Array.from({ length: 60 }, (_, index) => ({
    ...connection!,
    id: `synthetic-${index}`,
    displayName: "x".repeat(4_000),
  }));
  let entered = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startNodeService(
    {
      ...db,
      listConnections: async () => {
        entered += 1;
        await barrier;
        return connections;
      },
    },
    { token, port: 0 },
  );
  const url = new URL(service.url);
  const socket = connect(Number(url.port), url.hostname);
  try {
    await once(socket, "connect");
    socket.pause();
    socket.write(
      `GET /v1/connections HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\n\r\n`.repeat(
        20,
      ),
    );
    await vi.waitFor(() => expect(entered).toBe(20));
    const closing = service.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    let output = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      output += chunk;
    });
    const closed = once(socket, "close");
    socket.resume();
    await closing;
    await closed;
    expect(output.split("HTTP/1.1 200 OK").length - 1).toBe(20);
  } finally {
    release();
    socket.destroy();
    await service.close();
    await db.close();
  }
});

it("still closes promptly after a connection with queued pipelined requests aborts", async () => {
  const token = "synthetic-aborted-token-0000000000000000";
  const db = await openDatabase(":memory:");
  let entered = 0;
  let release!: () => void;
  let barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startNodeService(
    {
      ...db,
      listConnections: async () => {
        entered += 1;
        await barrier;
        return db.listConnections();
      },
    },
    { token, port: 0 },
  );
  const url = new URL(service.url);
  const socket = connect(Number(url.port), url.hostname);
  try {
    await once(socket, "connect");
    socket.write(
      `GET /v1/connections HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\n\r\n`.repeat(
        20,
      ),
    );
    await vi.waitFor(() => expect(entered).toBe(20));
    // Queued responses on an aborted connection must not keep shutdown waiting.
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    entered = 0;
    barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = fetch(`${service.url}/v1/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await vi.waitFor(() => expect(entered).toBe(1));
    const closing = service.close();
    release();
    expect((await response).status).toBe(200);
    const closeStarted = performance.now();
    await closing;
    expect(performance.now() - closeStarted).toBeLessThan(1_000);
  } finally {
    release();
    socket.destroy();
    await service.close();
    await db.close();
  }
});

describe("listener shutdown", () => {
  const address = { hostname: "127.0.0.1", port: 0 };

  /** A handler that waits for release(), recording shutdown steps in order. */
  function pausedService(stop = async () => {}) {
    const steps: string[] = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      steps,
      started,
      release,
      fetch: async () => {
        entered();
        await barrier;
        steps.push("handled");
        return new Response("served");
      },
      service: {
        stop: async () => {
          steps.push("stop");
          await stop();
        },
        dispose: async () => {
          steps.push("dispose");
        },
      },
    };
  }

  it("disposes only after a handler whose client disconnected has finished", async () => {
    const paused = pausedService();
    const running = await listen(paused.fetch, paused.service, address);
    const client = new AbortController();
    const response = fetch(running.url, { signal: client.signal }).catch(
      () => "disconnected",
    );
    await paused.started;
    client.abort();
    expect(await response).toBe("disconnected");
    const closing = running.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(paused.steps).toEqual(["stop"]);
    paused.release();
    await closing;
    expect(paused.steps).toEqual(["stop", "handled", "dispose"]);
  });

  it("still drains accepted requests when stopping fails, then reports it", async () => {
    const paused = pausedService(async () => {
      throw new Error("synthetic stop failure");
    });
    const running = await listen(paused.fetch, paused.service, address);
    const response = fetch(running.url);
    await paused.started;
    const closing = running.close();
    const outcome = closing.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(paused.steps).toEqual(["stop"]);
    paused.release();
    expect((await response).status).toBe(200);
    expect(await outcome).toEqual(new Error("synthetic stop failure"));
    expect(paused.steps).toEqual(["stop", "handled", "dispose"]);
  });

  it.each([
    { stalled: "a request", stop: async () => {} },
    { stalled: "stopping", stop: () => new Promise<void>(() => {}) },
  ])(
    "closes connections at the deadline when $stalled stalls, then disposes",
    { timeout: DRAIN_DEADLINE_MS + 5_000 },
    async ({ stop }) => {
      const paused = pausedService(stop);
      const running = await listen(paused.fetch, paused.service, address);
      try {
        const response = fetch(running.url).then(
          () => "response",
          () => "disconnected",
        );
        await paused.started;
        const started = performance.now();
        await running.close();
        expect(performance.now() - started).toBeGreaterThanOrEqual(
          DRAIN_DEADLINE_MS - 50,
        );
        expect(await response).toBe("disconnected");
        expect(paused.steps).toEqual(["stop", "dispose"]);
      } finally {
        paused.release();
      }
    },
  );

  it("stops and disposes the service when it cannot listen", async () => {
    const first = pausedService();
    const running = await listen(first.fetch, first.service, address);
    const second = pausedService();
    try {
      await expect(
        listen(second.fetch, second.service, {
          ...address,
          port: Number(new URL(running.url).port),
        }),
      ).rejects.toThrow();
      expect(second.steps).toEqual(["stop", "dispose"]);
    } finally {
      await running.close();
    }
  });
});

describe("local Node service configuration", () => {
  it("supports token authentication and a loopback port without OAuth", () => {
    vi.stubEnv(
      "FONDS_API_TOKEN",
      "synthetic-local-token-000000000000000000000",
    );
    vi.stubEnv("PORT", "0");
    expect(serviceOptionsFromEnvironment()).toEqual({
      token: "synthetic-local-token-000000000000000000000",
      port: 0,
    });
  });
});
