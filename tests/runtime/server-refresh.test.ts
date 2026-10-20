import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SignedWebhookInput } from "../../src/application/events.js";
import { main } from "../../src/cli.js";
import { createCredentialVault } from "../../src/runtime/credential-vault.js";
import { startServer } from "../../src/server.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { localState, openBoundDatabase } from "../helpers/local-state.js";

const collector = vi.hoisted(() => ({
  calls: 0,
  gate: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));

// Synthetic CAL collection: the real adapter, no provider requests.
vi.mock("../../src/providers/cal/collect.js", () => ({
  CAL_COLLECTOR_VERSION: "synthetic-refresh-collector-v1",
  async *collectCal() {
    collector.calls++;
    collector.entered?.();
    await collector.gate;
    yield {
      type: "capture",
      capture: {
        accountKey: "synthetic-account",
        endpoint: "synthetic:cal/recent",
        capturedAt: new Date().toISOString(),
        responseText: readFileSync(
          new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
          "utf8",
        ),
        scope: { kind: "recent" },
      },
    };
  },
}));

let directory: string;
let dbPath: string;
let running: Awaited<ReturnType<typeof startServer>>;
let headers: Record<string, string>;
const sent: SignedWebhookInput[] = [];

/** Holds the next collection inside the provider until the returned release. */
function holdNextCollection() {
  let release!: () => void;
  collector.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    collector.entered = resolve;
  });
  return {
    entered,
    release: () => {
      collector.gate = undefined;
      collector.entered = undefined;
      release();
    },
  };
}

async function refresh(connectionId = "synthetic-cal") {
  const response = await fetch(
    `${running!.url}/v1/connections/${connectionId}/refreshes`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  return { status: response.status, body: await response.json() };
}

async function connection(connectionId = "synthetic-cal") {
  return (
    await (
      await fetch(`${running!.url}/v1/connections/${connectionId}`, {
        headers,
      })
    ).json()
  ).connection;
}

/** The CLI's collect in this process, against its own database handle. */
async function cliCollect() {
  let stdout = "";
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
  try {
    const status = await main([
      "collect",
      "--db",
      dbPath,
      "--connection",
      "synthetic-cal",
    ]);
    return { status, summary: JSON.parse(stdout) };
  } finally {
    write.mockRestore();
  }
}

beforeEach(async () => {
  collector.calls = 0;
  sent.length = 0;
  directory = mkdtempSync(join(tmpdir(), "fonds-server-refresh-"));
  dbPath = join(directory, "service.sqlite");
  const db = await openBoundDatabase(dbPath);
  await db.ensureConnection({ id: "synthetic-cal", provider: "cal" });
  await db.ensureConnection({ id: "no-credentials", provider: "cal" });
  // `connect` stores credentials encrypted with the state's key.
  const state = await localState();
  await createCredentialVault(db.credentials, state.credentialsKey).save(
    { id: "synthetic-cal", provider: "cal" },
    { username: "synthetic-user", password: "synthetic-password" },
  );
  await db.close();
  chmodSync(dbPath, 0o600);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  running = await startServer(["--db", dbPath, "--port", "0"], {
    webhooks: {
      sendSignedWebhook: async (input) => {
        sent.push(input);
        return new Response(null, { status: 204 });
      },
      verifyWebhookCallback: async () => {},
    },
  });
  headers = { Authorization: `Bearer ${state.secrets.FONDS_API_TOKEN}` };
});

afterEach(async () => {
  collector.gate = undefined;
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("refresh on the local SQLite server", () => {
  it("refreshes over HTTP with stored credentials and records the connection's latest refresh", async () => {
    expect((await connection()).latestRefresh).toBeNull();
    const first = await refresh();
    expect(first.status).toBe(200);
    expect(first.body.refresh).toMatchObject({
      trigger: "manual",
      status: "completed",
      counts: { captures: 1, failures: 0, updated: 0 },
    });
    expect(first.body.refresh.counts.created).toBeGreaterThan(0);
    expect((await connection()).latestRefresh).toMatchObject({
      id: first.body.refresh.id,
      status: "completed",
      requiresAttention: false,
    });
    // The cooldown returns the finished refresh without calling the provider.
    const again = await refresh();
    expect(again.status).toBe(200);
    expect(again.body.refresh.id).toBe(first.body.refresh.id);
    expect(collector.calls).toBe(1);
    // Only connections with stored credentials can refresh.
    expect((await refresh("no-credentials")).status).toBe(404);
    const stderr = vi.mocked(process.stderr.write).mock.calls.flat().join("");
    expect(stderr).toContain('"event":"fonds_refresh"');
    expect(stderr).not.toContain("synthetic-password");
  });

  it("serializes a CLI collect and a server refresh on one database file", async () => {
    // The CLI collects first; a server start finds its refresh in progress.
    const cliHold = holdNextCollection();
    const cli = cliCollect();
    await cliHold.entered;
    const refused = await refresh();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("refresh_in_progress");
    expect((await connection()).latestRefresh).toMatchObject({
      status: "running",
    });
    cliHold.release();
    expect(await cli).toMatchObject({
      status: 0,
      summary: { type: "collection_summary", status: "completed" },
    });
    expect(collector.calls).toBe(1);
    expect((await connection()).latestRefresh).toMatchObject({
      status: "completed",
      counts: { captures: 1 },
    });

    // Then the server refreshes, past the cooldown; a CLI collect meanwhile is busy.
    const db = await openDatabase(dbPath);
    await db.client.execute(
      "UPDATE refreshes SET finished_at = '2000-01-01T00:00:00.000Z'",
    );
    await db.close();
    const serverHold = holdNextCollection();
    const serverRefresh = refresh();
    await serverHold.entered;
    expect(await cliCollect()).toMatchObject({
      status: 1,
      summary: { status: "busy" },
    });
    serverHold.release();
    expect(await serverRefresh).toMatchObject({
      status: 200,
      body: { refresh: { status: "completed" } },
    });
    expect(collector.calls).toBe(2);
  });

  it("offers refresh and Events over MCP and delivers a wake-up after a refresh", async () => {
    async function mcp(
      method: string,
      params: { name?: string; [field: string]: unknown } = {},
    ) {
      const response = await fetch(`${running!.url}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...("name" in params && method === "tools/call"
            ? { "Mcp-Name": String(params.name) }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_INFO_META_KEY]: { name: "synthetic-local", version: "1" },
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      });
      return (await response.json()).result;
    }

    expect((await mcp("server/discover")).capabilities.events).toEqual({});
    expect(
      (await mcp("tools/list")).tools.map(({ name }: { name: string }) => name),
    ).toContain("refresh_connection");
    const subscription = await mcp("events/subscribe", {
      name: "changes.available",
      arguments: { connectionId: "synthetic-cal" },
      delivery: {
        mode: "webhook",
        url: "https://callback.synthetic.invalid/events",
        secret: `whsec_${btoa("s".repeat(32))}`,
      },
    });
    expect(subscription.id).toMatch(/^sub_/);
    const result = await mcp("tools/call", {
      name: "refresh_connection",
      arguments: { connectionId: "synthetic-cal" },
    });
    expect(result.structuredContent).toMatchObject({
      refresh: { status: "completed" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      subscriptionId: subscription.id,
      body: {
        name: "changes.available",
        data: { connectionId: "synthetic-cal" },
      },
    });
  });

  it("runs the configured schedule once per occurrence as a scheduled refresh", async () => {
    await running?.close();
    running = await startServer(["--db", dbPath, "--port", "0"], {
      env: {
        FONDS_COLLECTION_SCHEDULE: "hourly",
        FONDS_COLLECTION_TIME: "00:05",
        FONDS_COLLECTION_TIMEZONE: "UTC",
      },
      scheduler: { maxJitterMs: 0, tickMs: 20 },
    });
    const deadline = Date.now() + 4000;
    let refresh: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      refresh = (await connection()).latestRefresh;
      if (refresh?.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(refresh).toMatchObject({
      trigger: "scheduled",
      status: "completed",
      scheduledAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:05:00\.000Z$/,
      ),
    });
    // Later ticks find the occurrence claimed and collect nothing more.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(collector.calls).toBe(1);
  });
});
