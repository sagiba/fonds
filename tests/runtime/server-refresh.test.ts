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
import { decodeCursor } from "../../src/application/query-inputs.js";
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
/** How the synthetic webhook receiver answers each delivery. */
let receive: (input: SignedWebhookInput) => Promise<Response>;

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

/** One MCP request with the protocol metadata the server requires. */
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

/** The CLI's refresh in this process, against its own database handle. */
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
      "refresh",
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
  receive = async () => new Response(null, { status: 204 });
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
        return receive(input);
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
      summary: { type: "refresh_summary", status: "completed" },
    });
    expect(collector.calls).toBe(1);
    expect((await connection()).latestRefresh).toMatchObject({
      status: "completed",
      counts: { captures: 1 },
    });

    // Then the server refreshes, past the cooldown; a CLI refresh meanwhile is busy.
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
        FONDS_REFRESH_SCHEDULE: "hourly",
        FONDS_REFRESH_TIME: "00:05",
        FONDS_REFRESH_TIMEZONE: "UTC",
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

describe("Events delivery after owner writes on the local SQLite server", () => {
  const delivery = {
    mode: "webhook",
    url: "https://callback.synthetic.invalid/events",
    secret: `whsec_${btoa("w".repeat(32))}`,
  };

  /** Imports synthetic rows, then subscribes after them. */
  async function subscribed() {
    expect((await refresh()).body.refresh.status).toBe("completed");
    const subscription = await mcp("events/subscribe", {
      name: "changes.available",
      arguments: { connectionId: "synthetic-cal" },
      delivery,
    });
    const page = await (
      await fetch(
        `${running!.url}/v1/transactions?connectionId=synthetic-cal&limit=2`,
        { headers },
      )
    ).json();
    return {
      subscription,
      transactions: page.data as { id: string; version: number }[],
    };
  }

  async function write(path: string, method: string, body: unknown) {
    const response = await fetch(`${running!.url}${path}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function sentAtLeast(count: number) {
    const deadline = Date.now() + 4_000;
    while (sent.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sent).toHaveLength(count);
  }

  it("wakes subscribers after an annotation update and a confirmed removal, but not after reads", async () => {
    const { subscription, transactions } = await subscribed();
    const [first, second] = transactions;
    // An annotation committed outside this server: only a pass can deliver it.
    const db = await openDatabase(dbPath);
    await db.editAnnotation({
      transactionId: second!.id,
      expectedVersion: 0,
      notes: "Synthetic out-of-band note",
      actor: "owner",
    });
    await db.close();
    for (const path of [
      "/v1/connections",
      "/v1/connections/synthetic-cal",
      "/v1/transactions?connectionId=synthetic-cal",
      `/v1/transactions/${first!.id}`,
      "/v1/transactions/totals?connectionId=synthetic-cal",
      "/v1/events?connectionId=synthetic-cal",
      "/v1/connections/synthetic-cal/sync-runs",
      "/v1/connections/synthetic-cal/refreshes",
    ]) {
      expect((await fetch(`${running!.url}${path}`, { headers })).status).toBe(
        200,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toHaveLength(0);

    const updated = await write(
      `/v1/transactions/${first!.id}/annotation`,
      "PATCH",
      { expectedVersion: 0, notes: "Synthetic owner note" },
    );
    expect(updated.status).toBe(200);
    await sentAtLeast(1);
    expect(sent[0]).toMatchObject({
      subscriptionId: subscription.id,
      body: {
        name: "changes.available",
        data: { connectionId: "synthetic-cal" },
      },
    });
    const events = await (
      await fetch(
        `${running!.url}/v1/events?connectionId=synthetic-cal&cursor=${String(
          (sent[0]!.body.data as { after: string }).after,
        )}`,
        { headers },
      )
    ).json();
    // One wake-up covers the out-of-band edit and the owner's own.
    expect(events.data.map((event: { type: string }) => event.type)).toEqual([
      "annotation.updated",
      "annotation.updated",
    ]);
    expect(events.nextCursor).toBe(
      (sent[0]!.body.data as { highWaterMark: string }).highWaterMark,
    );

    const removed = await write(
      `/v1/transactions/${first!.id}/removal`,
      "POST",
      {
        expectedTransactionVersion: first!.version,
        reason: "Synthetic confirmed removal",
      },
    );
    expect(removed.status).toBe(200);
    await sentAtLeast(2);
    expect(sent[1]!.eventId).not.toBe(sent[0]!.eventId);
  });

  it("closes the database only after a write's pass ends", async () => {
    const { transactions } = await subscribed();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // This receiver ignores the shutdown signal.
    receive = async () => {
      await held;
      return new Response(null, { status: 204 });
    };
    const updated = await write(
      `/v1/transactions/${transactions[0]!.id}/annotation`,
      "PATCH",
      { expectedVersion: 0, notes: "Synthetic shutdown note" },
    );
    expect(updated.status).toBe(200);
    await sentAtLeast(1);
    let closed = false;
    const closing = running!.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(false);
    release();
    await closing;
    running = undefined;
    const db = await openDatabase(dbPath);
    try {
      // The pass recorded its acknowledgement before the database closed.
      const [subscription] = await db.eventSubscriptions.listDue(
        Date.now() + 1,
        10,
      );
      expect(subscription).toMatchObject({
        pendingBatch: null,
        attempts: 0,
        cursor: decodeCursor(
          "event",
          (sent[0]!.body.data as { highWaterMark: string }).highWaterMark,
        ),
      });
    } finally {
      await db.close();
    }
  });

  it("answers the committed write while a receiver is slow or failing, and keeps its backoff", async () => {
    const { transactions } = await subscribed();
    const [first, second] = transactions;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    receive = async () => {
      await held;
      return new Response(null, { status: 500 });
    };
    const slow = await write(
      `/v1/transactions/${first!.id}/annotation`,
      "PATCH",
      { expectedVersion: 0, notes: "Synthetic slow-receiver note" },
    );
    // The response arrives while its delivery is still held at the receiver.
    expect(slow).toMatchObject({
      status: 200,
      body: { annotation: { transactionId: first!.id, version: 1 } },
    });
    await sentAtLeast(1);
    release();
    const reread = await (
      await fetch(`${running!.url}/v1/transactions/${first!.id}`, { headers })
    ).json();
    expect(reread.transaction.annotation).toMatchObject({
      version: 1,
      notes: "Synthetic slow-receiver note",
    });

    // The failed delivery backs off: the next write sends nothing yet.
    receive = async () => new Response(null, { status: 204 });
    const next = await write(
      `/v1/transactions/${second!.id}/annotation`,
      "PATCH",
      { expectedVersion: 0, notes: "Synthetic backed-off note" },
    );
    expect(next).toMatchObject({
      status: 200,
      body: { annotation: { transactionId: second!.id, version: 1 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toHaveLength(1);
  });
});
