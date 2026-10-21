import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplication } from "../../src/application/operations.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { connections } from "../../src/storage/sqlite/schema.js";
import { createHttpService } from "../../src/transport/http.js";

const token = "synthetic-test-only-000000000000000000000000";
const fixture = (n: number) =>
  readFileSync(
    new URL(`../providers/cal/fixtures/recent-0${n}.json`, import.meta.url),
    "utf8",
  );
let db: Database;
let service: ReturnType<typeof createHttpService>;

function request(path: string, init: RequestInit = {}) {
  return service.app.request(`http://127.0.0.1:8787${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
}

async function ingest(n: number) {
  return await db.ingestRun(
    {
      connectionId: "synthetic-cal",
      runId: `run-${n}`,
      responses: [
        {
          accountKey: "SYNTHETIC-ACCOUNT",
          endpoint: "synthetic:cal/recent",
          capturedAt: `2040-08-0${n}T00:00:00Z`,
          responseText: fixture(n),
        },
      ],
    },
    calAdapter,
  );
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await db.ensureConnection({ id: "synthetic-cal", provider: "cal" });
  await ingest(1);
  service = createHttpService(createApplication(db), { token });
});
afterEach(async () => {
  await service.close();
  await db.close();
});

describe("authenticated local HTTP service", () => {
  it("requires bearer authentication and rejects browser cross-origin/DNS rebinding access", async () => {
    for (const path of ["/health", "/v1/connections", "/mcp"]) {
      const response = await service.app.request(`http://127.0.0.1${path}`, {
        headers: { "oai-authenticated-user-id": "spoofed-owner" },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(
      (
        await request("/health", {
          headers: { Origin: "https://attacker.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/health", { headers: { Host: "attacker.invalid" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await service.app.request("http://attacker.invalid/health", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    expect((await request("/health")).status).toBe(200);
  });

  it("returns bounded deterministic pages and omits connection secrets and snapshots", async () => {
    await db.orm
      .update(connections)
      .set({
        config: {
          schemaVersion: 1,
          privateSetting: "synthetic-private-config",
        },
      })
      .where(eq(connections.id, "synthetic-cal"))
      .run();
    const connectionResponse = await request("/v1/connections");
    const connectionText = await connectionResponse.text();
    expect(connectionResponse.status).toBe(200);
    expect(JSON.parse(connectionText)).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(JSON.parse(connectionText).data[0]).not.toHaveProperty("cards");
    expect(connectionText).not.toContain("config");
    expect(connectionText).not.toContain("synthetic-private-config");
    const first = await (
      await request("/v1/transactions?connectionId=synthetic-cal&limit=2")
    ).json();
    const second = await (
      await request(
        `/v1/transactions?connectionId=synthetic-cal&limit=2&cursor=${first.nextCursor}`,
      )
    ).json();
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.data[0]).toHaveProperty("id");
    expect(first.data[0]).not.toHaveProperty("transactionId");
    expect(first.data[0]).not.toHaveProperty("details");
    expect(first.data[0]).not.toHaveProperty("sourceKey");
    expect(JSON.stringify(first)).not.toContain("providerPaymentHistory");
    expect(typeof first.nextCursor).toBe("string");
    expect(
      second.data.every((row: { id: string }) =>
        first.data.every((a: { id: string }) => a.id !== row.id),
      ),
    ).toBe(true);
    const all = await (
      await request("/v1/transactions?connectionId=synthetic-cal&limit=20")
    ).json();
    // The spending perspective omits the fixture's one billed line.
    expect(all.data).toHaveLength(20);
    expect(all).toMatchObject({ hasMore: false, nextCursor: null });
    for (const cursor of ["not-a-cursor", "%00", "b2Zmc2V0OjAx"]) {
      expect(
        (
          await request(
            `/v1/transactions?connectionId=synthetic-cal&cursor=${cursor}`,
          )
        ).status,
      ).toBe(400);
    }
    const events = await (
      await request("/v1/events?connectionId=synthetic-cal&limit=1")
    ).json();
    // A cursor from another list is invalid input, not a silently reinterpreted offset.
    expect(
      (
        await request(
          `/v1/transactions?connectionId=synthetic-cal&cursor=${events.nextCursor}`,
        )
      ).status,
    ).toBe(400);
    const status = await (
      await request("/v1/connections/synthetic-cal/sync-runs")
    ).json();
    expect(status).toMatchObject({ hasMore: false, nextCursor: null });
    expect(status.data[0]).toMatchObject({
      id: "run-1",
      connectionId: "synthetic-cal",
      status: "completed",
      finishedAt: expect.any(String),
    });
    expect(JSON.stringify(status)).not.toContain("responseText");
    expect(JSON.stringify(status)).not.toContain("snapshot");
  });

  it("reads cards and accounts by service ID with safe metadata and pagination", async () => {
    const cardKey = "synthetic/card:with spaces?&א";
    await db.recordCardDiscovery("synthetic-cal", {
      observedAt: "2040-08-03T00:00:00Z",
      cards: [
        {
          cardKey,
          last4: "0012",
          displayName: "Synthetic debit",
          billingAccount: { providerKey: "private-account-key", mask: "0042" },
        },
      ],
    });
    const expected = (
      await db.listCards({ connectionId: "synthetic-cal", limit: 200 })
    ).cards.map(
      ({ providerKey: _providerKey, attributes: _attributes, ...card }) => card,
    );
    const seen: unknown[] = [];
    let cursor: string | null = "";
    while (cursor !== null) {
      const response = await request(
        `/v1/cards?connectionId=synthetic-cal&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page.data.length).toBeLessThanOrEqual(1);
      seen.push(...page.data);
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expected);
    const [account] = (await db.listAccounts({ connectionId: "synthetic-cal" }))
      .accounts;
    const discovered = expected.find(
      (card) => card.displayName === "Synthetic debit",
    )!;
    expect(discovered.billingAccountId).toBe(account!.id);
    const response = await request(
      `/v1/cards/${encodeURIComponent(discovered.id)}`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ card: discovered });
    expect(text).not.toContain(cardKey);
    const stub = expected.find((card) => card.id !== discovered.id)!;
    expect(stub).toMatchObject({
      billingAccountId: null,
      last4: null,
      displayName: null,
      lastSeenAt: null,
    });
    const accounts = await request("/v1/accounts?connectionId=synthetic-cal");
    const accountText = await accounts.text();
    expect(JSON.parse(accountText)).toEqual({
      data: [
        {
          id: account!.id,
          connectionId: "synthetic-cal",
          type: "depository",
          institutionName: null,
          mask: "0042",
          displayName: null,
          createdAt: expect.any(String),
          lastSeenAt: "2040-08-03T00:00:00Z",
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(accountText).not.toContain("private-account-key");
    expect(await (await request(`/v1/accounts/${account!.id}`)).json()).toEqual(
      { account: JSON.parse(accountText).data[0] },
    );
    const transactions = await (
      await request(
        `/v1/transactions?connectionId=synthetic-cal&billingAccountId=${account!.id}`,
      )
    ).json();
    expect(transactions.data).toEqual([]);
    const byCard = await (
      await request(
        `/v1/transactions?connectionId=synthetic-cal&cardId=${encodeURIComponent(stub.id)}&limit=200`,
      )
    ).json();
    expect(byCard.data.length).toBeGreaterThan(0);
    expect(
      byCard.data.every(
        (row: { cardId: string | null }) => row.cardId === stub.id,
      ),
    ).toBe(true);
    expect(JSON.stringify(byCard)).not.toMatch(/accountKey|cardKey/);
    await db.ensureConnection({ id: "synthetic-other", provider: "cal" });
    for (const query of [
      `connectionId=synthetic-other&cardId=${encodeURIComponent(stub.id)}`,
      `connectionId=synthetic-other&billingAccountId=${account!.id}`,
      "connectionId=synthetic-cal&cardId=missing",
      "connectionId=synthetic-cal&accountKey=account",
    ]) {
      for (const path of ["/v1/transactions", "/v1/transactions/totals"]) {
        const invalid = await request(`${path}?${query}`);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({
          error: { code: "invalid_input" },
        });
      }
    }
    expect(
      (await request("/v1/cards?connectionId=synthetic-cal&offset=100")).status,
    ).toBe(400);
    for (const path of [
      "/v1/cards?connectionId=missing",
      "/v1/accounts?connectionId=missing",
      "/v1/cards/missing",
      "/v1/accounts/missing",
      `/v1/cards/${encodeURIComponent(cardKey)}`,
      "/v1/connections/synthetic-cal/cards",
    ]) {
      expect((await request(path)).status).toBe(404);
    }
    for (const query of [
      "",
      "connectionId=synthetic-cal&limit=201",
      "connectionId=synthetic-cal&limit=01",
      "connectionId=synthetic-cal&limit=1&limit=2",
      "connectionId=synthetic-cal&password=do-not-echo-this",
    ]) {
      for (const path of ["/v1/cards", "/v1/accounts"]) {
        const invalid = await request(`${path}?${query}`);
        expect(invalid.status).toBe(400);
        expect(await invalid.text()).not.toContain("do-not-echo-this");
      }
    }
    expect((await request("/v1/cards/%00")).status).toBe(400);
    for (const query of ["cardId=missing", "connectionId=synthetic-cal"]) {
      expect(
        (await request(`/v1/cards/${discovered.id}?${query}`)).status,
      ).toBe(400);
    }
    {
      const card = {
        id: "synthetic-card",
        connectionId: "synthetic-application-contract",
        providerKey: "private-provider-sentinel",
        billingAccountId: null,
        last4: "0012",
        displayName: "Synthetic card",
        attributes: { cardStatus: "private-attribute-sentinel" },
        createdAt: "2040-08-01T00:00:00Z",
        lastSeenAt: null,
      };
      const account = {
        id: "synthetic-account",
        connectionId: "synthetic-application-contract",
        providerKey: "private-provider-sentinel",
        type: "depository" as const,
        institutionName: null,
        mask: "0042",
        displayName: null,
        createdAt: "2040-08-01T00:00:00Z",
        lastSeenAt: "2040-08-01T00:00:00Z",
      };
      const { providerKey: _providerKey, ...expected } = account;

      await service.close();
      service = createHttpService(
        createApplication({
          ...db,
          getCard: async (id) => (id === card.id ? card : undefined),
          listAccounts: async () => ({ accounts: [account], hasMore: false }),
          getAccount: async (id) => (id === account.id ? account : undefined),
        }),
        { token },
      );
      const published = await request(`/v1/cards/synthetic-card`);
      expect(published.status).toBe(200);
      const text = await published.text();
      expect(text).not.toMatch(/private-(provider|attribute)-sentinel/);
      expect(JSON.parse(text)).toEqual({
        card: {
          id: "synthetic-card",
          connectionId: "synthetic-application-contract",
          billingAccountId: null,
          last4: "0012",
          displayName: "Synthetic card",
          createdAt: "2040-08-01T00:00:00Z",
          lastSeenAt: null,
        },
      });
      expect((await request(`/v1/cards/missing`)).status).toBe(404);
      const list = await request(
        `/v1/accounts?connectionId=synthetic-application-contract`,
      );
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({
        data: [expected],
        hasMore: false,
        nextCursor: null,
      });
      const read = await request(`/v1/accounts/synthetic-account`);
      expect(await read.json()).toEqual({ account: expected });
      expect((await request(`/v1/accounts/missing`)).status).toBe(404);
      expect((await request(`/v1/accounts`)).status).toBe(400);
    }
  });

  it("uses current versions for edits, persists one audit, and returns safe conflicts", async () => {
    const page = await (
      await request("/v1/transactions?connectionId=synthetic-cal&limit=1")
    ).json();
    const row = page.data[0];
    const body = {
      expectedVersion: 0,
      notes: "Synthetic note",
      category: "travel",
      tags: [],
    };
    const update = () =>
      request(`/v1/transactions/${row.id}/annotation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const [a, b] = await Promise.all([update(), update()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const conflict = await request(`/v1/transactions/${row.id}/annotation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        notes: "Synthetic async note",
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "conflict" },
    });
    const current = await (await request(`/v1/transactions/${row.id}`)).json();
    expect(current.transaction.annotation).toMatchObject({
      version: 1,
      notes: body.notes,
      category: body.category,
      tags: body.tags,
    });
    const changes = await (
      await request("/v1/events?connectionId=synthetic-cal&limit=200")
    ).json();
    expect(
      changes.data.filter(
        (change: { type: string }) => change.type === "annotation.updated",
      ),
    ).toHaveLength(1);
    expect(changes.hasMore).toBe(false);
    const resumed = await (
      await request(
        `/v1/events?connectionId=synthetic-cal&cursor=${changes.nextCursor}`,
      )
    ).json();
    // The final page's cursor is a checkpoint: resuming returns it unchanged.
    expect(resumed).toEqual({
      data: [],
      hasMore: false,
      nextCursor: changes.nextCursor,
    });
    const bad = await request(`/v1/transactions/${row.id}/annotation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, actor: "forged" }),
    });
    expect(bad.status).toBe(400);
  });

  it("sees independent collection without triggering collection on reads", async () => {
    const before = await (
      await request("/v1/transactions?connectionId=synthetic-cal")
    ).json();
    expect(before.data).toHaveLength(20);
    await ingest(2);
    const after = await (
      await request("/v1/transactions?connectionId=synthetic-cal")
    ).json();
    expect(after.data).toHaveLength(22);
    expect(
      (await request("/v1/transactions/totals?connectionId=synthetic-cal"))
        .status,
    ).toBe(200);
    const status = await (
      await request("/v1/connections/synthetic-cal/sync-runs")
    ).json();
    expect(status.data).toHaveLength(2);
    expect((await request("/v1/collect", { method: "POST" })).status).toBe(404);
  });

  it("rejects malformed, oversized and ambiguous input before mutation", async () => {
    for (const path of [
      "/v1/transactions?connectionId=synthetic-cal&limit=201",
      "/v1/transactions?connectionId=synthetic-cal&limit=-1",
      "/v1/transactions?connectionId=synthetic-cal&limit=1&limit=2",
      "/v1/transactions?connectionId=synthetic-cal&includeSuperseded=1",
      "/v1/connections?password=do-not-echo-this",
    ]) {
      const r = await request(path);
      expect(r.status).toBe(400);
      expect(await r.text()).not.toContain("do-not-echo-this");
    }
    expect((await request("/v1/transactions/missing")).status).toBe(404);
    expect(
      (await request("/v1/transactions/totals?connectionId=missing")).status,
    ).toBe(404);
    for (const body of ["{", "null", "[]"]) {
      expect(
        (
          await request("/v1/annotations/undo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request("/v1/annotations/undo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: " ".repeat(65537),
        })
      ).status,
    ).toBe(413);
  });

  it.each(["operation throw", "storage rejection"])(
    "never exposes database or unexpected error text from %s",
    async (failure) => {
      await service.close();
      const application = createApplication(
        failure === "storage rejection"
          ? {
              ...db,
              listConnections: async () => {
                throw new Error("SQL contains synthetic-sensitive-payload");
              },
            }
          : db,
      );
      if (failure === "operation throw") {
        application.operations.find(
          (op) => op.name === "list_connections",
        )!.execute = () => {
          throw new Error("SQL includes synthetic-sensitive-response");
        };
      }
      service = createHttpService(application, { token });
      const response = await request("/v1/connections");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: "internal_error", message: "Operation failed." },
      });
    },
  );
});
