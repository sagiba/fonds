import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SignedWebhookInput } from "../../src/application/events.js";
import { decodeCursor } from "../../src/application/query-inputs.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  createHostedService,
  hostedConfiguration,
} from "../../src/runtime/hosted-service.js";
import { createPostgresEventStore } from "../../src/storage/postgres/events.js";
import {
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../../src/storage/postgres/store.js";
import { disposableDatabase } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;
const origin = "https://fonds.synthetic.invalid";
const ownerId = "synthetic-owner";
const clientId = "synthetic-client";

const webhooks = vi.hoisted(() => ({
  sent: [] as unknown[],
  receive: async (): Promise<Response> => new Response(null, { status: 204 }),
}));

// The owner's OAuth grant is outside this suite: every request is the owner's.
vi.mock("../../src/runtime/auth/better-auth.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/runtime/auth/better-auth.js")
  >()),
  createBetterAuth: () => ({
    provider: {
      issuer: `${origin}/api/auth`,
      authenticate: async () => ({
        source: "synthetic",
        subject: ownerId,
        ownerId,
        resource: `${origin}/mcp`,
        clientId,
        scopes: ["financial:read", "financial:write"],
      }),
    },
    handlePublicRequest: async () => null,
    hasActiveEventReadGrant: async () => true,
  }),
}));

vi.mock("../../src/runtime/webhook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/runtime/webhook.js")>()),
  sendSignedWebhook: async (input: SignedWebhookInput) => {
    webhooks.sent.push(input);
    return webhooks.receive();
  },
}));

describe.skipIf(!postgresUrl)("hosted delivery after owner writes", () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let transactionId: string;
  let hosted: ReturnType<typeof createHostedService> | undefined;

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    webhooks.sent.length = 0;
    webhooks.receive = async () => new Response(null, { status: 204 });
    database = await disposableDatabase(postgresUrl!, "fonds_write_delivery");
    const seed = openPostgresDatabase({
      connectionString: database.url,
      options: database.options,
    });
    try {
      await initializePostgresDatabase(seed.pool);
      await seed.ensureConnection({ id: "synthetic-cal", provider: "cal" });
      await seed.ingestRun(
        {
          runId: "synthetic-hosted-run",
          connectionId: "synthetic-cal",
          responses: [
            {
              accountKey: "synthetic-account",
              endpoint: "synthetic:cal/recent",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: readFileSync(
                new URL(
                  "../providers/cal/fixtures/recent-01.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            },
          ],
        },
        calAdapter,
      );
      transactionId = (await seed.listTransactions())[0]!.id;
      const events = createPostgresEventStore(seed.pool, seed);
      const now = Date.now();
      await events.save(
        {
          id: "sub-synthetic-hosted",
          ownerId,
          clientId,
          connectionId: "synthetic-cal",
          url: "https://callback.synthetic.invalid/events",
          secret: `whsec_${btoa("h".repeat(32))}`,
          previousSecret: null,
          rotationUntil: null,
          verifiedUntil: now + 300_000,
          expiresAt: now + 86_400_000,
          status: "active",
          // Subscribed after the import: only later changes are due.
          cursor: await events.latestEventId("synthetic-cal"),
          pendingBatch: null,
          attempts: 0,
          nextAttemptAt: now,
          generation: 0,
          reason: null,
        },
        0,
      );
    } finally {
      await seed.close();
    }
  });

  afterEach(async () => {
    try {
      await hosted?.close();
      hosted = undefined;
    } finally {
      await database.drop();
      vi.restoreAllMocks();
    }
  });

  function serve(background?: (work: Promise<unknown>) => void) {
    hosted = createHostedService(
      hostedConfiguration({
        FONDS_PUBLIC_ORIGIN: origin,
        FONDS_AUTH_SECRET: "synthetic-auth-secret-00000000000000000000",
        FONDS_OWNER_ID: ownerId,
      }),
      {
        connectionString: database.url,
        ...(background && { refreshExecution: { background } }),
      },
    );
    return hosted;
  }

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await hosted!.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: {
          Authorization: "Bearer synthetic-owner-grant",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  }

  it("keeps a serverless invocation alive for the pass after a write, and not for reads", async () => {
    const background = vi.fn();
    serve(background);
    for (const path of [
      "/v1/connections",
      "/v1/transactions?connectionId=synthetic-cal",
      `/v1/transactions/${transactionId}`,
      "/v1/events?connectionId=synthetic-cal",
    ]) {
      expect((await call(path)).status).toBe(200);
    }
    expect(background).not.toHaveBeenCalled();

    const updated = await call(
      `/v1/transactions/${transactionId}/annotation`,
      "PATCH",
      { expectedVersion: 0, notes: "Synthetic hosted note" },
    );
    expect(updated).toMatchObject({
      status: 200,
      body: { annotation: { transactionId, version: 1 } },
    });
    expect(background).toHaveBeenCalledTimes(1);
    await background.mock.calls[0]![0];
    expect(webhooks.sent).toHaveLength(1);
    expect(webhooks.sent[0]).toMatchObject({
      subscriptionId: "sub-synthetic-hosted",
      body: { name: "changes.available" },
    });

    // Undoing the edit is another write without a refresh.
    const events = await call(
      "/v1/events?connectionId=synthetic-cal&limit=200",
    );
    const edit = (events.body.data as { id: number; type: string }[])
      .filter((event) => event.type === "annotation.updated")
      .at(-1)!;
    const undone = await call("/v1/annotations/undo", "POST", {
      eventId: edit.id,
      expectedVersion: 1,
    });
    expect(undone.status).toBe(200);
    expect(background).toHaveBeenCalledTimes(2);
    await background.mock.calls[1]![0];
    expect(webhooks.sent).toHaveLength(2);
  });

  it("answers a write before a held delivery finishes on a long-lived host", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const receiving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    webhooks.receive = async () => {
      entered();
      await held;
      return new Response(null, { status: 503 });
    };
    serve();
    const updated = await call(
      `/v1/transactions/${transactionId}/annotation`,
      "PATCH",
      { expectedVersion: 0, notes: "Synthetic held note" },
    );
    expect(updated).toMatchObject({
      status: 200,
      body: { annotation: { transactionId, version: 1 } },
    });
    await receiving;
    release();
    // The pass continues after the response and records the failure for a retry.
    const seed = openPostgresDatabase({
      connectionString: database.url,
      options: database.options,
    });
    try {
      const subscriptions = createPostgresEventStore(seed.pool, seed);
      const deadline = Date.now() + 4_000;
      let subscription = await subscriptions.get("sub-synthetic-hosted");
      while (subscription?.attempts === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        subscription = await subscriptions.get("sub-synthetic-hosted");
      }
      expect(subscription).toMatchObject({
        status: "active",
        attempts: 1,
        reason: "retry_pending",
      });
      expect(subscription!.pendingBatch).not.toBeNull();
    } finally {
      await seed.close();
    }
  });

  it("ends its pools only after a write's pass ends", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const receiving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // This receiver ignores the shutdown signal.
    webhooks.receive = async () => {
      entered();
      await held;
      return new Response(null, { status: 204 });
    };
    serve();
    const updated = await call(
      `/v1/transactions/${transactionId}/annotation`,
      "PATCH",
      { expectedVersion: 0, notes: "Synthetic shutdown note" },
    );
    expect(updated.status).toBe(200);
    await receiving;
    let closed = false;
    const closing = hosted!.close().then(() => {
      closed = true;
    });
    hosted = undefined;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(false);
    release();
    await closing;
    const seed = openPostgresDatabase({
      connectionString: database.url,
      options: database.options,
    });
    try {
      // The pass recorded its acknowledgement before the pools ended.
      expect(
        await createPostgresEventStore(seed.pool, seed).get(
          "sub-synthetic-hosted",
        ),
      ).toMatchObject({
        pendingBatch: null,
        attempts: 0,
        cursor: decodeCursor(
          "event",
          (webhooks.sent[0] as { body: { data: { highWaterMark: string } } })
            .body.data.highWaterMark,
        ),
      });
    } finally {
      await seed.close();
    }
  });
});
