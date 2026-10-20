import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neonGoogleLogin } from "../../deploy/neon/neon-login.js";
import {
  createEventService,
  type EventSubscription,
  type SignedWebhookInput,
} from "../../src/application/events.js";
import { decodeCursor } from "../../src/application/query-inputs.js";
import { createBetterAuth } from "../../src/runtime/auth/better-auth.js";
import { createPostgresEventStore } from "../../src/storage/postgres/events.js";
import {
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../../src/storage/postgres/store.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("durable PostgreSQL event subscriptions", () => {
  let admin: Pool;
  let pool: Pool;
  let otherPool: Pool;
  let db: ReturnType<typeof openPostgresDatabase>;
  let databaseName: string;
  let store: ReturnType<typeof createPostgresEventStore>;
  const now = Date.parse("2040-01-01T00:00:00Z");

  beforeEach(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    databaseName = `fonds_events_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const connection = new URL(postgresUrl!);
    connection.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: connection.href });
    otherPool = new Pool({ connectionString: connection.href });
    db = openPostgresDatabase({
      connectionString: connection.href,
      options: "-c search_path=financial",
    });
    await initializePostgresDatabase(db.pool);
    await initializePostgresDatabase(db.pool);
    store = createPostgresEventStore(pool, db);
  });

  afterEach(async () => {
    await db?.close();
    await pool?.end();
    await otherPool?.end();
    if (admin) {
      if (databaseName) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      }
      await admin.end();
    }
  });

  function subscription(id = "sub-synthetic"): EventSubscription {
    return {
      id,
      ownerId: "owner",
      clientId: "client",
      connectionId: "cal",
      url: "https://callback.synthetic.invalid/events",
      secret: `whsec_${btoa("s".repeat(32))}`,
      previousSecret: null,
      rotationUntil: null,
      verifiedUntil: now + 300_000,
      expiresAt: now + 86_400_000,
      status: "active",
      cursor: 0,
      pendingBatch: null,
      attempts: 0,
      nextAttemptAt: now,
      generation: 0,
      reason: null,
    };
  }

  it("persists through independent connections without adding financial tables", async () => {
    const saved = await store.save(subscription(), 0);
    expect(saved?.generation).toBe(1);
    expect(
      await createPostgresEventStore(otherPool, db).get("sub-synthetic"),
    ).toEqual(saved);
    // The seven financial tables, the schedule, lease and refresh tables and
    // the migration versions, nothing more.
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='financial' AND table_type='BASE TABLE'",
        )
      ).rows[0].count,
    ).toBe(13);
    expect(
      (await pool.query("SELECT current_schema() AS schema")).rows[0].schema,
    ).toBe("public");
    expect(
      (
        await pool.query(
          "SELECT to_regclass('operations.event_subscriptions') AS name",
        )
      ).rows[0].name,
    ).toBe("operations.event_subscriptions");
  });

  it("creates the Neon bridge and passkey tables on setup", async () => {
    await pool.query("CREATE SCHEMA identity");
    const identityPool = new Pool({
      connectionString: pool.options.connectionString,
      options: "-c search_path=identity",
    });
    try {
      const auth = createBetterAuth(
        identityPool,
        {
          publicOrigin: "https://owner.synthetic.invalid",
          secret: "synthetic-identity-secret-00000000000000000000",
          ownerId: "synthetic-owner",
          ownerEmail: "owner@synthetic.invalid",
          googleLogin: neonGoogleLogin({
            upstreamURL: "https://synthetic.neonauth.neon.tech/auth",
            allowedEmail: "owner@synthetic.invalid",
          }),
        },
        { forSetup: true },
      );
      await auth.migrate();
      await auth.bootstrapOwner("synthetic-setup-password-00000000000000");
      const columns = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='identity' AND table_name IN ('fonds_neon_identity','passkey')
        ORDER BY table_name, column_name`,
      );
      expect(
        columns.rows
          .filter((row) => row.table_name === "fonds_neon_identity")
          .map((row) => row.column_name),
      ).toEqual([
        "created_at",
        "google_account_id",
        "local_user_id",
        "upstream_url",
        "upstream_user_id",
      ]);
      expect(columns.rows.some((row) => row.table_name === "passkey")).toBe(
        true,
      );
      await identityPool.query(
        `INSERT INTO fonds_neon_identity
        (local_user_id, upstream_url, upstream_user_id, google_account_id) VALUES ($1,$2,$3,$4)`,
        [
          "synthetic-owner",
          "https://synthetic.neonauth.neon.tech/auth",
          "synthetic-upstream-user",
          "synthetic-google-account",
        ],
      );
    } finally {
      await identityPool.end();
    }
  });

  it("isolates financial, identity and operations state in stable functional namespaces", async () => {
    await pool.query("CREATE SCHEMA identity");
    const identityPool = new Pool({
      connectionString: pool.options.connectionString,
      options: "-c search_path=identity",
    });
    try {
      const auth = createBetterAuth(
        identityPool,
        {
          publicOrigin: "https://owner.synthetic.invalid",
          secret: "synthetic-identity-secret-00000000000000000000",
          ownerId: "synthetic-owner",
          ownerEmail: "owner@synthetic.invalid",
          googleLogin: neonGoogleLogin({
            upstreamURL: "https://synthetic.neonauth.neon.tech/auth",
            allowedEmail: "owner@synthetic.invalid",
          }),
        },
        { forSetup: true },
      );
      await auth.migrate();
      await auth.bootstrapOwner("synthetic-setup-password-00000000000000");
      expect((await identityPool.query('SELECT id FROM "user"')).rows).toEqual([
        { id: "synthetic-owner" },
      ]);
      expect(
        (
          await pool.query(
            "SELECT to_regclass('identity.fonds_neon_identity') AS identity_table, to_regclass('identity.fonds_neon_login') AS login_table",
          )
        ).rows,
      ).toEqual([
        {
          identity_table: "identity.fonds_neon_identity",
          login_table: "identity.fonds_neon_login",
        },
      ]);
      expect(
        (
          await pool.query(`SELECT table_schema,table_name FROM information_schema.tables
        WHERE table_schema IN ('financial','identity','operations') AND table_name IN ('connections','user','event_subscriptions')
        ORDER BY table_schema,table_name`)
        ).rows,
      ).toEqual([
        { table_schema: "financial", table_name: "connections" },
        { table_schema: "identity", table_name: "user" },
        { table_schema: "operations", table_name: "event_subscriptions" },
      ]);
      expect(
        (
          await pool.query(
            "SELECT nspname FROM pg_namespace WHERE nspname IN ('fonds','fonds_auth','fonds_ops')",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await identityPool.end();
    }
  });

  it("accepts only one racing generation and never recreates a missing stale row", async () => {
    const saved = (await store.save(subscription(), 0))!;
    const concurrent = createPostgresEventStore(otherPool, db);
    const results = await Promise.all([
      store.save({ ...saved, cursor: 1 }, saved.generation),
      concurrent.save({ ...saved, cursor: 2 }, saved.generation),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.get(saved.id))?.generation).toBe(2);
    expect(
      await store.save({ ...saved, status: "inactive" }, saved.generation),
    ).toBeUndefined();
    expect(await store.save(subscription("missing-stale"), 10)).toBeUndefined();
    expect(await store.get("missing-stale")).toBeUndefined();
    expect(await store.save(subscription(), 0)).toBeUndefined();
  });

  it("filters due state using persisted expiry, retry schedule and active status", async () => {
    await store.save(subscription("due"), 0);
    await store.save(
      { ...subscription("later"), nextAttemptAt: now + 60_000 },
      0,
    );
    await store.save({ ...subscription("expired"), expiresAt: now }, 0);
    await store.save(
      { ...subscription("failed"), status: "failed", attempts: 5 },
      0,
    );
    expect((await store.listDue(now, 25)).map((value) => value.id)).toEqual([
      "due",
    ]);
    expect(
      (await store.listDue(now + 60_000, 25)).map((value) => value.id),
    ).toEqual(["due", "later"]);
  });

  it("initializes cursors from committed connection-scoped financial changes", async () => {
    await db.ensureConnection({ id: "cal", provider: "cal" });
    await db.ensureConnection({ id: "other", provider: "cal" });
    expect(await store.latestEventId("cal")).toBe(0);
    for (const connectionId of ["cal", "other"]) {
      await db.ingestRun(
        {
          runId: `${connectionId}-baseline`,
          connectionId,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: "2040-01-01T00:00:00Z",
              responseText: JSON.stringify([row("one")]),
            },
          ],
        },
        synthetic,
      );
    }
    const changes = await db.listEvents({ connectionId: "cal" });
    expect(await store.latestEventId("cal")).toBe(changes.at(-1)?.id);
    expect(await store.latestEventId("other")).toBeGreaterThan(
      await store.latestEventId("cal"),
    );
  });
  it("uses the real durable financial feed after restart and excludes historical baseline alerts", async () => {
    await db.ensureConnection({ id: "cal", provider: "cal" });

    async function ingest(runId: string, keys: string[], historical = false) {
      await db.ingestRun(
        {
          runId,
          connectionId: "cal",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: "2040-01-01T00:00:00Z",
              responseText: JSON.stringify(keys.map((key) => row(key))),
              ...(historical
                ? {
                    scope: {
                      kind: "history" as const,
                      from: "2039-01-01",
                      to: "2039-01-31",
                    },
                  }
                : {}),
            },
          ],
        },
        synthetic,
      );
    }

    let pollTime = now;
    const send = vi.fn(
      async (_input: SignedWebhookInput) => new Response(null, { status: 200 }),
    );
    const dependencies = {
      source: db,
      sendSignedWebhook: send,
      verifyWebhookCallback: async () => {},
      grantCheck: async () => true,
      now: () => pollTime,
    };
    const service = createEventService({ ...dependencies, store });
    const { id } = await service.subscribe(
      {
        ownerId: "owner",
        clientId: "client",
        scopes: ["financial:read"],
      },
      {
        name: "changes.available",
        arguments: { connectionId: "cal" },
        delivery: {
          mode: "webhook",
          url: "https://callback.synthetic.invalid/events",
          secret: subscription().secret,
        },
      },
    );
    await ingest("baseline", ["one"]);
    expect((await service.deliver()).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    pollTime += 60_000;
    await ingest("history", ["two"], true);
    expect((await service.deliver()).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    pollTime += 60_000;
    await ingest("recent", ["one", "two", "three"]);
    const restarted = createEventService({
      ...dependencies,
      store: createPostgresEventStore(otherPool, db),
    });
    expect((await restarted.deliver()).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    const sentChangeId = send.mock.calls[2]![0].body.data as {
      highWaterMark: string;
    };
    expect((await store.get(id))?.cursor).toBeGreaterThanOrEqual(
      decodeCursor("event", sentChangeId.highWaterMark),
    );
    await restarted.deliver();
    expect(send).toHaveBeenCalledTimes(3);

    pollTime += 60_000;
    await ingest("retry-boundary", ["one", "two", "three", "four"]);
    send.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await restarted.deliver()).failed).toBe(1);
    const retryBody = structuredClone(send.mock.calls.at(-1)![0].body);
    expect((await store.get(id))?.pendingBatch).not.toBeNull();
    await ingest("newer-boundary", ["one", "two", "three", "four", "five"]);
    pollTime += 60_000;
    const retryAfterRestart = createEventService({
      ...dependencies,
      store: createPostgresEventStore(otherPool, db),
    });
    expect((await retryAfterRestart.deliver()).sent).toBe(1);
    expect(send.mock.calls.at(-1)![0].body).toEqual(retryBody);
    expect((await store.get(id))?.pendingBatch).toBeNull();
    expect((await retryAfterRestart.deliver()).sent).toBe(1);
    expect(send.mock.calls.at(-1)![0].eventId).not.toBe(retryBody.eventId);
    expect((await store.get(id))?.cursor).toBe(await db.latestEventId("cal"));
  });
});
