import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialStore } from "../../src/application/financial-store.js";
import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import { decodeKeyset } from "../../src/application/query-inputs.js";
import { annotationSchema } from "../../src/domain/model.js";
import { reviewBasis } from "../../src/domain/plans/annotation.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { createHttpService } from "../../src/transport/http.js";

const token = "synthetic-async-application-token-0000000000";
const connectionId = "synthetic-application-contract";

function expectNoServiceWrapper(value: unknown): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const key of [
    "fonds",
    "authorizationAmount",
    "purchaseCommitmentAmount",
    "unclassifiedAmount",
  ]) {
    expect(value).not.toHaveProperty(key);
  }
  for (const child of Object.values(value)) {
    expectNoServiceWrapper(child);
  }
}

describe("asynchronous application storage contract", () => {
  let db: Database;
  let store: FinancialStore;
  let service: ReturnType<typeof createHttpService>;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: connectionId, provider: "cal" });
    await db.ingestRun(
      {
        runId: "synthetic-app-run",
        connectionId,
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
    store = db;
    service = createHttpService(createApplication(store), { token });
  });
  afterEach(async () => {
    await service.close();
    await db.close();
  });

  function request(path: string, body?: unknown) {
    return service.app.request(`http://localhost${path}`, {
      method:
        body === undefined
          ? "GET"
          : path.endsWith("/annotation")
            ? "PATCH"
            : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  it("awaits list/detail and versioned edits, then maps a rejected conflict safely", async () => {
    const page = await (
      await request(`/v1/transactions?connectionId=${connectionId}&limit=1`)
    ).json();
    expectNoServiceWrapper(page);
    expect(page).toMatchObject({ hasMore: true });
    const transactionId = page.data[0].id as string;
    expect(page.data[0]).toHaveProperty("version");
    expect(page.data[0]).not.toHaveProperty("transactionVersion");
    const input = { expectedVersion: 0, notes: "Synthetic async note" };
    const first = await request(
      `/v1/transactions/${transactionId}/annotation`,
      input,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      annotation: { transactionId, version: 1 },
    });
    const conflict = await request(
      `/v1/transactions/${transactionId}/annotation`,
      input,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "conflict" },
    });
    const detail = await (
      await request(`/v1/transactions/${transactionId}`)
    ).json();
    expectNoServiceWrapper(detail);
    expect(detail).toMatchObject({
      transaction: {
        annotation: { version: 1, notes: "Synthetic async note" },
      },
    });
    expect(detail.transaction.annotation).not.toHaveProperty(
      "annotationVersion",
    );
    expect(detail.transaction).not.toHaveProperty("annotationSummary");
  });

  it("maps authoritative missing-write outcomes without a redundant transaction read", async () => {
    await service.close();
    store.getTransaction = () => {
      throw new Error("Unexpected write pre-read");
    };
    service = createHttpService(createApplication(store), { token });
    const missing = await request("/v1/transactions/missing/annotation", {
      expectedVersion: 0,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "not_found",
        message: "Requested record was not found.",
      },
    });
  });

  it("round-trips annotation minor units independently of decimal transaction money", async () => {
    // Pick from the default (spending) list that is read back below, so the
    // row is always on it whatever IDs the run assigned.
    const listPath = `/v1/transactions?connectionId=${connectionId}&limit=200`;
    const row = (await (await request(listPath)).json()).data.find(
      (item: { status: string; kind: string; amount: unknown }) =>
        item.status === "posted" &&
        item.kind === "purchase" &&
        item.amount !== null,
    )!;
    const write = await request(`/v1/transactions/${row.id}/annotation`, {
      expectedVersion: 0,
      notes: "Synthetic purchase note",
      category: "Synthetic",
      tags: ["one", " two ", "one"],
      metadata: { split: { personal: 1, shared: [2, null] } },
    });
    expect(write.status).toBe(200);
    const detail = await (await request(`/v1/transactions/${row.id}`)).json();
    expectNoServiceWrapper(detail);
    expect(typeof detail.transaction.amount.amount).toBe("string");
    expect(detail.transaction.annotation).toMatchObject({
      version: 1,
      notes: "Synthetic purchase note",
      category: "Synthetic",
      tags: ["one", "two"],
      metadata: { split: { personal: 1, shared: [2, null] } },
      review: null,
    });
    expect(detail.transaction.annotation).not.toHaveProperty("allocations");
    const list = await (await request(listPath)).json();
    expect(
      list.data.find((item: { id: string }) => item.id === row.id).annotation,
    ).toEqual({
      version: 1,
      category: "Synthetic",
      tags: ["one", "two"],
      hasNotes: true,
      metadata: { split: { personal: 1, shared: [2, null] } },
    });
  });

  it("uses resource-specific public guards while retaining the exact review basis document", async () => {
    const row = (await db.listTransactions())[0]!;
    const first = await request(`/v1/transactions/${row.id}/annotation`, {
      expectedVersion: 0,
      expectedTransactionVersion: row.version,
      notes: "Original review",
      review: { status: "approved" },
    });
    expect(await first.json()).toEqual({
      annotation: { transactionId: row.id, version: 1 },
    });
    const second = await request(`/v1/transactions/${row.id}/annotation`, {
      expectedVersion: 1,
      expectedTransactionVersion: row.version,
      notes: "Later note",
    });
    expect(second.status).toBe(200);
    const change = (await db.listEvents())
      .filter(
        (item) =>
          item.transactionId === row.id && item.type === "annotation.updated",
      )
      .at(-1)!;
    const before = await db.getTransaction(row.id);
    const feed = await db.listEvents();
    const stale = await request("/v1/annotations/undo", {
      eventId: change.id,
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await db.getTransaction(row.id)).toEqual(before);
    expect(await db.listEvents()).toEqual(feed);
    const undone = await request("/v1/annotations/undo", {
      eventId: change.id,
      expectedVersion: 2,
    });
    expect(await undone.json()).toEqual({
      annotation: { transactionId: row.id, version: 3 },
    });
    const detail = (await (await request(`/v1/transactions/${row.id}`)).json())
      .transaction;
    expect(detail).toMatchObject({
      version: row.version,
      annotation: {
        version: 3,
        notes: "Original review",
        review: { status: "approved" },
      },
    });
    expect((await db.getTransaction(row.id))?.annotation).toMatchObject({
      version: 3,
      data: {
        notes: "Original review",
        review: {
          status: "approved",
          financialVersion: row.version,
          basis: reviewBasis(row),
        },
      },
    });
  });

  it("rejects obsolete public guard names before changing state", async () => {
    const row = (await db.listTransactions())[0]!;
    const before = await db.getTransaction(row.id);
    const feed = await db.listEvents();
    for (const [path, body] of [
      [
        `/v1/transactions/${row.id}/annotation`,
        { expectedAnnotationVersion: 0, data: {} },
      ],
      [
        `/v1/transactions/${row.id}/annotation`,
        { expectedVersion: 0, review: { status: "approved" } },
      ],
      ["/v1/annotations/undo", { changeId: 1, expectedAnnotationVersion: 0 }],
      ["/v1/annotations/undo", { eventId: 1, expectedAnnotationVersion: 0 }],
      [
        `/v1/transactions/${row.id}/removal`,
        { expectedVersion: row.version, reason: "Synthetic invalid old guard" },
      ],
      [
        `/v1/transactions/${row.id}/link-pending`,
        {
          postedId: "synthetic-posted",
          expectedPendingVersion: row.version,
          expectedPostedVersion: 1,
          expectedPendingAnnotationVersion: 0,
          expectedPostedAnnotationVersion: 0,
          reason: "Synthetic invalid old guards",
        },
      ],
    ] as const) {
      expect((await request(path, body)).status).toBe(400);
      expect(await db.getTransaction(row.id)).toEqual(before);
      expect(await db.listEvents()).toEqual(feed);
    }
  });

  it("rejects annotation bounds before writes and preserves versions and change feed", async () => {
    const row = (await db.listTransactions())[0]!;
    const before = await db.getTransaction(row.id);
    const changes = await db.listEvents();
    for (const fields of [
      { category: "c".repeat(101) },
      { tags: Array.from({ length: 51 }, (_, index) => `tag-${index}`) },
      { tags: ["t".repeat(101)] },
    ]) {
      const response = await request(`/v1/transactions/${row.id}/annotation`, {
        expectedVersion: 0,
        ...fields,
      });
      expect(response.status).toBe(400);
      expect(await db.getTransaction(row.id)).toEqual(before);
      expect(await db.listEvents()).toEqual(changes);
    }
    // The same envelope at the limits is accepted, so the rejections above are the bounds.
    const accepted = await request(`/v1/transactions/${row.id}/annotation`, {
      expectedVersion: 0,
      category: "c".repeat(100),
      tags: [
        "t".repeat(100),
        ...Array.from({ length: 49 }, (_, index) => `tag-${index}`),
      ],
    });
    expect(accepted.status).toBe(200);
  });

  it("returns small committed annotation receipts even if later reads fail", async () => {
    const row = (await db.listTransactions())[0]!;
    const write = await request(`/v1/transactions/${row.id}/annotation`, {
      expectedVersion: 0,
      notes: "Preserved annotation",
      metadata: { long: "x".repeat(20_000) },
    });
    expect(await write.json()).toEqual({
      annotation: { transactionId: row.id, version: 1 },
    });
    const annotated = (await db.listEvents()).find(
      (change) =>
        change.transactionId === row.id && change.type === "annotation.updated",
    )!;
    store.getTransaction = () => {
      throw new Error("Unexpected annotation write read");
    };
    const undone = await request("/v1/annotations/undo", {
      eventId: annotated.id,
      expectedVersion: 1,
    });
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({
      annotation: { transactionId: row.id, version: 2 },
    });
  });

  it("scopes list and totals only when a connection is given and keeps filters consistent with it", async () => {
    await db.ensureConnection({ id: "second-connection", provider: "cal" });
    const all = await (await request("/v1/transactions?limit=200")).json();
    const scoped = await (
      await request(`/v1/transactions?connectionId=${connectionId}&limit=200`)
    ).json();
    expect(all.data.length).toBeGreaterThan(0);
    expect(all.data).toEqual(scoped.data);
    const totals = await (await request("/v1/transactions/totals")).json();
    expect(totals).toEqual(
      await (
        await request(`/v1/transactions/totals?connectionId=${connectionId}`)
      ).json(),
    );
    const card = all.data.find((row: { cardId: string | null }) => row.cardId);
    expect(
      (await request(`/v1/transactions?cardId=${card.cardId}`)).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/v1/transactions?connectionId=second-connection&cardId=${card.cardId}`,
        )
      ).status,
    ).toBe(400);
    // Typed query filters: booleans parse, unknown values and names are rejected.
    expect(
      (await request("/v1/transactions?cardPresent=true&recurring=false"))
        .status,
    ).toBe(200);
    expect(
      (
        await request(
          "/v1/transactions?wallet=apple_pay&authorizationMethod=chip&merchantCategoryCode=5411&threeDSecureUsed=true",
        )
      ).status,
    ).toBe(200);
    for (const query of [
      "cardPresent=yes",
      "wallet=paypal",
      "merchantCategoryCode=54",
      "authorizationMethod=magic",
    ]) {
      expect((await request(`/v1/transactions?${query}`)).status).toBe(400);
    }
    expect(
      (await request("/v1/transactions/totals?wallet=apple_pay")).status,
    ).toBe(200);
  });

  it("keeps admitted connection identifiers readable through scoped operations", async () => {
    const longId = ` ${"c".repeat(1022)} `;
    await db.ensureConnection({ id: longId, provider: "cal" });
    expect(
      (
        await request(
          `/v1/transactions?connectionId=${encodeURIComponent(longId)}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(`/v1/events?connectionId=${encodeURIComponent(longId)}`))
        .status,
    ).toBe(200);
    await expect(
      db.ensureConnection({ id: "c".repeat(1025), provider: "cal" }),
    ).rejects.toThrow();
    expect((await request("/v1/connections")).status).toBe(200);
  });

  it("uses the scoped read's own missing outcome without a separate connection lookup", async () => {
    store.getConnection = () => {
      throw new Error("Unexpected connection pre-read");
    };
    expect(
      (await request(`/v1/transactions?connectionId=${connectionId}`)).status,
    ).toBe(200);
    for (const path of [
      "transactions?connectionId=synthetic-missing",
      "transactions/totals?connectionId=synthetic-missing",
      "events?connectionId=synthetic-missing",
      "connections/synthetic-missing/sync-runs",
    ]) {
      const response = await request(`/v1/${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "not_found" },
      });
    }
  });

  it("returns asynchronous validation failures and never exposes rejected storage errors", async () => {
    const application = createApplication(store);
    const operation = application.operations.find(
      (item) => item.name === "list_connections",
    )!;
    await expect(operation.execute({ unexpected: true })).rejects.toThrow();
    await service.close();
    store.listConnections = async () => {
      throw new Error("SQL contains synthetic-sensitive-payload");
    };
    service = createHttpService(createApplication(store), { token });
    const response = await request("/v1/connections");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Operation failed." },
    });
  });

  it("rejects oversized and invalid storage output with fixed public errors", async () => {
    store.listConnections = async () => [
      {
        id: connectionId,
        provider: "cal",
        displayName: "private-output-sentinel".repeat(20_000),
        createdAt: "2040-08-01T00:00:00Z",
        latestRefresh: null,
      },
    ];
    const oversized = await request("/v1/connections");
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: {
        code: "output_too_large",
        message:
          "Requested output exceeds the response limit. Narrow the request.",
      },
    });
    store.listConnections = async () => [
      {
        id: connectionId,
        provider: "cal",
        displayName: "Synthetic connection",
        createdAt: "2040-08-01T00:00:00Z",
        latestRefresh: null,
        config: { privateSetting: "private-output-sentinel" },
      },
    ];
    const invalid = await request("/v1/connections");
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toEqual({
      error: { code: "internal_error", message: "Operation failed." },
    });
  });

  it("returns byte-bounded prefixes without skipping valid large annotation summaries", async () => {
    const expected = (
      await db.listTransactionPage({ connectionId, limit: 200 })
    ).transactions.map((row) => row.id);
    for (const transactionId of expected) {
      const response = await request(
        `/v1/transactions/${transactionId}/annotation`,
        {
          expectedVersion: 0,
          category: "c".repeat(100),
          metadata: { large: "m".repeat(20_000) },
        },
      );
      expect(response.status).toBe(200);
    }
    const seen: string[] = [];
    let cursor: string | null = "";
    let pageCount = 0;
    while (cursor !== null && pageCount < 20) {
      const response = await request(
        `/v1/transactions?connectionId=${connectionId}${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
        256 * 1024,
      );
      const page = JSON.parse(text);
      expect(page.data.length).toBeGreaterThan(0);
      seen.push(...page.data.map((row: { id: string }) => row.id));
      expect(page.hasMore).toBe(page.nextCursor !== null);
      cursor = page.nextCursor;
      pageCount++;
    }
    expect(cursor).toBeNull();
    expect(pageCount).toBeGreaterThan(1);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  it("returns byte-bounded card prefixes with resumable cursors and no omissions", async () => {
    const cards = Array.from({ length: 200 }, (_, index) => ({
      id: `${index}:`.padEnd(1024, "א"),
      connectionId,
      providerKey: `provider-${index}`,
      billingAccountId: null,
      last4: "0012",
      displayName: "Synthetic retained card",
      attributes: null,
      createdAt: "2040-08-01T00:00:00Z",
      lastSeenAt: null,
    }));
    // Keyset fake: the cursor names the last returned card.
    store.listCards = async ({ after, limit = 50 }) => {
      const start = after
        ? cards.findIndex((card) => card.id === after.id) + 1
        : 0;
      return {
        cards: cards.slice(start, start + limit),
        hasMore: start + limit < cards.length,
      };
    };
    const seen: unknown[] = [];
    let cursor: string | null = "";
    let pageCount = 0;
    while (cursor !== null && pageCount < 10) {
      const response = await request(
        `/v1/cards?connectionId=${connectionId}&limit=200${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
        256 * 1024,
      );
      const page = JSON.parse(text);
      expect(page.data.length).toBeGreaterThan(0);
      seen.push(...page.data);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      cursor = page.nextCursor;
      pageCount++;
    }
    expect(cursor).toBeNull();
    expect(pageCount).toBeGreaterThan(1);
    expect(seen).toEqual(
      cards.map(
        ({ providerKey: _providerKey, attributes: _attributes, ...card }) =>
          card,
      ),
    );
  });

  it("rejects invalid card output, never publishes private card facts and fails explicitly when its first record exceeds the byte budget", async () => {
    const card = {
      id: "synthetic-card",
      connectionId,
      providerKey: "private-provider-sentinel",
      billingAccountId: null,
      last4: "0012",
      displayName: "Synthetic card",
      attributes: { cardStatus: "private-attribute-sentinel" },
      createdAt: "2040-08-01T00:00:00Z",
      lastSeenAt: null,
    };
    store.listCards = async () => ({
      cards: [{ ...card, id: "x".repeat(300_000) }],
      hasMore: false,
    });
    expect(
      (await request(`/v1/cards?connectionId=${connectionId}`)).status,
    ).toBe(413);
    store.getCard = async () => ({ ...card, last4: "12x4" });
    const invalid = await request(`/v1/cards/synthetic-card`);
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toEqual({
      error: { code: "internal_error", message: "Operation failed." },
    });
    store.getCard = async (id) => (id === card.id ? card : undefined);
    const published = await request(`/v1/cards/synthetic-card`);
    expect(published.status).toBe(200);
    const text = await published.text();
    expect(text).not.toMatch(/private-(provider|attribute)-sentinel/);
    expect(JSON.parse(text)).toEqual({
      card: {
        id: "synthetic-card",
        connectionId,
        billingAccountId: null,
        last4: "0012",
        displayName: "Synthetic card",
        createdAt: "2040-08-01T00:00:00Z",
        lastSeenAt: null,
      },
    });
    expect((await request(`/v1/cards/missing`)).status).toBe(404);
  });

  it("publishes accounts without their provider key", async () => {
    const account = {
      id: "synthetic-account",
      connectionId,
      providerKey: "private-provider-sentinel",
      type: "depository" as const,
      institutionName: null,
      mask: "0042",
      displayName: null,
      createdAt: "2040-08-01T00:00:00Z",
      lastSeenAt: "2040-08-01T00:00:00Z",
    };
    const { providerKey: _providerKey, ...expected } = account;
    store.listAccounts = async () => ({
      accounts: [account],
      hasMore: false,
    });
    store.getAccount = async (id) => (id === account.id ? account : undefined);
    const list = await request(`/v1/accounts?connectionId=${connectionId}`);
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
  });

  it("exposes actionable stored review context and current versions on the default detail read", async () => {
    const adapter = { ...calAdapter };
    delete adapter.automaticPosting;
    await db.ingestRun(
      {
        runId: "synthetic-review-candidates",
        connectionId,
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-08-02T00:00:00Z",
            responseText: readFileSync(
              new URL(
                "../providers/cal/fixtures/recent-02.json",
                import.meta.url,
              ),
              "utf8",
            ),
          },
        ],
      },
      adapter,
    );
    const rows = await db.listTransactions();
    const pending = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-AUTH-PENDING-POSTED"),
    )!;
    const posted = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-TXN-PENDING-POSTED"),
    )!;
    expect(
      (
        await request(`/v1/transactions/${pending.id}/annotation`, {
          expectedVersion: 0,
          expectedTransactionVersion: pending.version,
          review: { status: "needs_review" },
        })
      ).status,
    ).toBe(200);
    const response = await request(`/v1/transactions/${pending.id}`);
    expect(response.status).toBe(200);
    const value = (await response.json()).transaction;
    expect(value).toMatchObject({
      id: pending.id,
      version: pending.version,
      annotation: { version: 1 },
      review: {
        required: true,
        status: "needs_review",
        pendingPostingCandidateIds: [posted.id],
        reasons: expect.arrayContaining([
          "possible_pending_posted_match",
          "user_needs_review",
        ]),
        sourceIssues: expect.arrayContaining(["possible_pending_posted_match"]),
        truncated: false,
        counts: {
          pendingPostingCandidateIds: 1,
          reasons: 2,
          sourceIssues: 1,
        },
      },
    });
    expect(value).not.toHaveProperty("evidence");
    const candidate = (
      await (await request(`/v1/transactions/${posted.id}`)).json()
    ).transaction;
    expect(candidate).toMatchObject({
      id: posted.id,
      version: posted.version,
      annotation: null,
      review: { pendingPostingCandidateIds: [pending.id] },
    });
    expect(value.annotation.review.status).toBe("needs_review");
  });

  it("keeps full annotations, identity and continuation readable while diagnostic evidence is bounded", async () => {
    const original = (await db.listTransactions())[0]!;
    expect(
      (
        await request(`/v1/transactions/${original.id}/annotation`, {
          expectedVersion: 0,
          expectedTransactionVersion: original.version,
          notes: "Synthetic full annotation",
          category: "household",
          tags: ["shared"],
          metadata: { preserve: "user document" },
          review: { status: "approved" },
        })
      ).status,
    ).toBe(200);
    const row = (await db.getTransaction(original.id))!;
    const retained = {
      ...row,
      pendingPostingCandidates: [
        ...Array.from(
          { length: 101 },
          (_, index) => `synthetic-candidate-${index}`,
        ),
        "unrepresentable-candidate".repeat(100),
      ],
      reviewReasons: Array.from(
        { length: 101 },
        (_, index) => `diagnostic-reason-${index}`,
      ),
      sourceIssues: Array.from(
        { length: 101 },
        (_, index) => `diagnostic-issue-${index}`,
      ),
      details: {
        ...row.details,
        merchant: {
          ...row.details.merchant,
          address: "diagnostic-address".repeat(1000),
          city: `x${"😀".repeat(3000)}`,
        },
        postingLink: {
          schemaVersion: 1 as const,
          postedId: "synthetic-posted",
          automatic: false,
          policyVersion: "synthetic-policy",
          evidence: {
            runId: "synthetic-run",
            capturedAt: "2040-08-01T00:00:00Z",
          },
          pendingKeys: [],
          postedKeys: [],
          pending: {
            ...row,
            status: "pending" as const,
            supersededById: null,
            details: row.details,
          },
        },
        sourceRefs: [
          ...Array.from({ length: 101 }, (_, index) => ({
            runId: "synthetic-run",
            path: `/rows/${index}`,
          })),
          { runId: "synthetic-run", path: "unrepresentable-path".repeat(300) },
          {
            runId: "unrepresentable-run".repeat(100),
            path: "/rows/invalid-run",
          },
        ],
      },
    };
    store.getTransaction = async () => retained;
    const operational = await request(`/v1/transactions/${row.id}`);
    expect(operational.status).toBe(200);
    const operationalValue = (await operational.json()).transaction;
    for (const key of [
      "evidence",
      "diagnosticsTruncated",
      "diagnosticCounts",
      // The residual details bag appears only with diagnostic evidence.
      "details",
    ]) {
      expect(operationalValue).not.toHaveProperty(key);
    }
    const document = {
      notes: "Synthetic full annotation",
      category: "household",
      tags: ["shared"],
      metadata: { preserve: "user document" },
      review: { status: "approved" },
    };
    const data = document;
    expect(operationalValue).toMatchObject({
      id: row.id,
      source: { identityStrength: row.identityStrength },
      review: {
        truncated: true,
        counts: {
          pendingPostingCandidateIds: 102,
          reasons: 101,
          sourceIssues: 101,
        },
      },
      annotation: { version: 1, ...document },
      postingMatch: {
        supersededTransactionId: "synthetic-posted",
        automatic: false,
        unlinked: false,
      },
    });
    expect(operationalValue.review.pendingPostingCandidateIds).toHaveLength(
      100,
    );
    expect(operationalValue.review.reasons).toHaveLength(100);
    expect(operationalValue.review.sourceIssues).toHaveLength(100);
    expect(JSON.stringify(operationalValue)).not.toContain("unrepresentable");
    const compact = await request(`/v1/transactions/${row.id}?detail=false`);
    expect(compact.status).toBe(200);
    const value = await compact.json();
    expect(value.transaction).toMatchObject({
      annotation: {
        version: 1,
        category: data.category,
        tags: data.tags,
        hasNotes: true,
      },
    });
    expect(value.transaction).not.toHaveProperty("annotation.notes");
    const page = await request(`/v1/transactions?connectionId=${connectionId}`);
    expect(page.status).toBe(200);
    expect(
      (await page.json()).data.find(
        (entry: { id: string }) => entry.id === row.id,
      ),
    ).toMatchObject({
      annotation: { version: 1, category: data.category },
    });
    const detail = await request(
      `/v1/transactions/${row.id}?includeEvidence=true`,
    );
    expect(detail.status).toBe(200);
    const preview = (await detail.json()).transaction;
    expect(preview).toMatchObject({
      annotation: { version: 1, ...document },
      diagnosticsTruncated: true,
      diagnosticCounts: {
        evidence: 103,
      },
    });
    expect(preview.evidence).toHaveLength(100);
    expect(preview.evidence.at(-1).path).toBe("/rows/100");
    expect(preview.evidence[0].path).toBe("/rows/1");
    expect(preview.review.pendingPostingCandidateIds).toHaveLength(100);
    expect(preview.review.pendingPostingCandidateIds.at(-1)).toBe(
      "synthetic-candidate-100",
    );
    expect(preview.merchant.city.length).toBe(4095);
    expect(preview.merchant.city.endsWith("😀")).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("unrepresentable");
    expect(preview.merchant.addressLine.length).toBe(4096);
    expect(retained.details.merchant.address.length).toBeGreaterThan(4096);
    expect(
      (
        await request(
          `/v1/transactions/${row.id}?detail=false&includeEvidence=true`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await request(`/v1/transactions/${row.id}?includeEvidence=1`)).status,
    ).toBe(400);
  });

  it("reduces diagnostic previews to the total byte budget while preserving operational documents and source data", async () => {
    const row = (await db.listTransactions())[0]!;
    const data = annotationSchema.parse({
      category: "c".repeat(100),
      tags: Array.from({ length: 50 }, () => "t".repeat(100)),
      metadata: { large: "m".repeat(40_000) },
      notes: "n".repeat(1000),
    });
    const retained = {
      ...row,
      annotation: {
        transactionId: row.id,
        version: 1,
        data,
        updatedAt: "2040-08-01T00:00:00Z",
      },
      pendingPostingCandidates: Array.from({ length: 100 }, (_, index) =>
        `${index}:`.padEnd(1024, "c"),
      ),
      reviewReasons: Array.from({ length: 100 }, (_, index) =>
        `${index}:`.padEnd(4096, "r"),
      ),
      sourceIssues: Array.from({ length: 100 }, (_, index) =>
        `${index}:`.padEnd(4096, "s"),
      ),
      details: {
        ...row.details,
        sourceRefs: Array.from({ length: 100 }, (_, index) => ({
          runId: "synthetic-run",
          path: `${index}:`.padEnd(4096, "p"),
        })),
        merchant: {
          address: "a".repeat(10000),
          phone: "p".repeat(10000),
          city: "c".repeat(10000),
          countryCode: "FRA",
        },
      },
    };
    const before = structuredClone(retained);
    store.getTransaction = async () => retained;
    const operational = await request(`/v1/transactions/${row.id}`);
    expect(operational.status).toBe(200);
    const operationalText = await operational.text();
    expect(
      new TextEncoder().encode(operationalText).byteLength,
    ).toBeLessThanOrEqual(256 * 1024);
    const operationalValue = JSON.parse(operationalText).transaction;
    const { schemaVersion: _schemaVersion, ...document } = data;
    const annotation = {
      version: retained.annotation.version,
      ...document,
      updatedAt: retained.annotation.updatedAt,
    };
    expect(operationalValue).toMatchObject({
      annotation,
      review: {
        truncated: true,
        counts: {
          pendingPostingCandidateIds: 100,
          reasons: 100,
          sourceIssues: 100,
        },
      },
    });
    expect(operationalValue).not.toHaveProperty("evidence");
    expect(operationalValue).not.toHaveProperty("annotationSummary");
    const response = await request(
      `/v1/transactions/${row.id}?includeEvidence=true`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    );
    const preview = JSON.parse(text).transaction;
    expect(preview).not.toHaveProperty("annotationSummary");
    expect(preview).toMatchObject({
      id: row.id,
      version: row.version,
      source: { identityStrength: row.identityStrength },
      annotation,
      diagnosticsTruncated: true,
      diagnosticCounts: { evidence: 100 },
      review: {
        truncated: true,
        counts: {
          pendingPostingCandidateIds: 100,
          reasons: 100,
          sourceIssues: 100,
        },
      },
    });
    expect(
      preview.evidence.length +
        preview.review.reasons.length +
        preview.review.sourceIssues.length,
    ).toBeLessThan(300);
    for (const reference of preview.evidence) {
      expect(retained.details.sourceRefs).toContainEqual(reference);
    }
    expect(retained).toEqual(before);
  });

  it("preserves fixed output errors for compact and detailed read schemas", async () => {
    const row = (await db.listTransactions())[0]!;
    for (const query of ["", "?detail=false", "?includeEvidence=true"]) {
      store.getTransaction = async () => ({
        ...row,
        description: "x".repeat(4097),
      });
      const oversized = await request(`/v1/transactions/${row.id}${query}`);
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({
        error: { code: "output_too_large" },
      });
      store.getTransaction = async () => ({ ...row, version: -1 });
      const invalid = await request(`/v1/transactions/${row.id}${query}`);
      expect(invalid.status).toBe(500);
      expect(await invalid.json()).toEqual({
        error: { code: "internal_error", message: "Operation failed." },
      });
    }
  });

  it("fails explicitly if the first compact record cannot fit instead of skipping it", async () => {
    const row = (await db.listTransactions())[0]!;
    store.listTransactionPage = async () => ({
      transactions: [{ ...row, description: "x".repeat(300_000) }, row],
      hasMore: false,
    });
    const response = await request(
      `/v1/transactions?connectionId=${connectionId}`,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "output_too_large" },
    });
  });

  it("cuts a byte-limited page after the last row that fits and resumes from that row", async () => {
    const [first, second] = await db.listTransactions();
    const calls: unknown[] = [];
    store.listTransactionPage = async (input) => {
      calls.push(input?.after);
      return {
        transactions: [
          { ...first!, transactionDate: null },
          { ...second!, description: "x".repeat(300_000) },
        ],
        hasMore: false,
      };
    };
    const page = await (
      await request(`/v1/transactions?connectionId=${connectionId}`)
    ).json();
    expect(page.data.map((item: { id: string }) => item.id)).toEqual([
      first!.id,
    ]);
    expect(page.hasMore).toBe(true);
    expect(decodeKeyset("transactions", page.nextCursor)).toEqual([
      null,
      first!.id,
    ]);
    await request(
      `/v1/transactions?connectionId=${connectionId}&cursor=${page.nextCursor}`,
    );
    expect(calls).toEqual([
      undefined,
      { transactionDate: null, id: first!.id },
    ]);
  });

  it("exposes posting split through the shared HTTP operation with owner audit and version checks", async () => {
    await db.ingestRun(
      {
        runId: "synthetic-posted",
        connectionId,
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-08-02T00:00:00Z",
            responseText: readFileSync(
              new URL(
                "../providers/cal/fixtures/recent-02.json",
                import.meta.url,
              ),
              "utf8",
            ),
          },
        ],
      },
      calAdapter,
    );
    const rows = await db.listTransactions();
    const pending = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-AUTH-PENDING-POSTED"),
    )!;
    const posted = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-TXN-PENDING-POSTED"),
    )!;
    const body = {
      postedId: posted.id,
      expectedPendingTransactionVersion: pending.version,
      expectedPostedTransactionVersion: posted.version,
      expectedPendingAnnotationVersion: 0,
      expectedPostedAnnotationVersion: 0,
      reason: "Synthetic owner confirmation",
    };
    const getTransaction = store.getTransaction.bind(store);
    store.getTransaction = () => {
      throw new Error("Unexpected posting write read");
    };
    const confirmation = await request(
      `/v1/transactions/${pending.id}/link-pending`,
      body,
    );
    store.getTransaction = getTransaction;
    expect(confirmation.status).toBe(200);
    const confirmed = await confirmation.json();
    expectNoServiceWrapper(confirmed);
    expect(confirmed).toEqual({
      transaction: { id: pending.id, version: pending.version + 1 },
    });
    const detail = await (
      await request(`/v1/transactions/${confirmed.transaction.id}`)
    ).json();
    expectNoServiceWrapper(detail);
    expect(detail.transaction.postingMatch).toMatchObject({
      supersededTransactionId: posted.id,
      automatic: false,
      policyVersion: expect.any(String),
      unlinked: false,
    });
    expect(detail.transaction.postingMatch).not.toHaveProperty("pending");
    expect(JSON.stringify(detail)).not.toContain("sourceAliases");
    expect(JSON.stringify(detail)).not.toContain("providerPaymentHistory");
    const split = {
      ...body,
      expectedPendingTransactionVersion: pending.version + 1,
      expectedPostedTransactionVersion: posted.version + 1,
    };
    const unlinkPath = `/v1/transactions/${pending.id}/unlink-pending`;
    expect(
      (await request(unlinkPath, { ...split, actor: "system" })).status,
    ).toBe(400);
    expect(
      (await request(unlinkPath, { ...split, transactionId: pending.id }))
        .status,
    ).toBe(400);
    store.getTransaction = () => {
      throw new Error("Unexpected unlink write read");
    };
    const response = await request(unlinkPath, split);
    expect(response.status).toBe(200);
    const unlinked = await response.json();
    expectNoServiceWrapper(unlinked);
    expect(unlinked).toEqual({
      pending: { id: pending.id, version: pending.version + 2 },
      posted: { id: posted.id, version: posted.version + 2 },
    });
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.unlinked",
      ),
    ).toMatchObject([{ actor: "owner" }, { actor: "owner" }]);
    expect((await request(unlinkPath, split)).status).toBe(200);
    expect(
      (
        await request(unlinkPath, {
          ...split,
          expectedPendingTransactionVersion: 100,
        })
      ).status,
    ).toBe(409);
  });

  it("returns the committed removal receipt without rereading source-rich state", async () => {
    const row = (await db.listTransactions())[0]!;
    store.getTransaction = async () => ({
      ...row,
      version: row.version + 100,
      description: "Later state".repeat(50_000),
    });
    const response = await request(`/v1/transactions/${row.id}/removal`, {
      expectedTransactionVersion: row.version,
      reason: "Synthetic confirmed removal",
    });
    expect(response.status).toBe(200);
    const removed = await response.json();
    expectNoServiceWrapper(removed);
    expect(removed).toEqual({
      transaction: { id: row.id, version: row.version + 1 },
    });
  });
});

describe("follow-up after owner writes", () => {
  let db: Database;
  let afterWrite: ReturnType<typeof vi.fn<() => void>>;
  let invoke: (name: string, input: unknown) => Promise<unknown>;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: connectionId, provider: "cal" });
    await db.ingestRun(
      {
        runId: "synthetic-follow-up-run",
        connectionId,
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
    afterWrite = vi.fn<() => void>();
    const application = createApplication(db, {
      refreshes: { start: vi.fn(), startAll: async () => [] },
      afterWrite: () => afterWrite(),
    });
    invoke = inProcessInvoker(application).invoke;
  });
  afterEach(async () => {
    await db.close();
  });

  it("follows each committed write, and no read, refresh or failed write", async () => {
    const transaction = (await db.listTransactions())[0]!;
    for (const [name, input] of [
      ["list_connections", {}],
      ["get_connection", { connectionId }],
      ["list_cards", { connectionId }],
      ["list_accounts", { connectionId }],
      ["list_transactions", { connectionId }],
      ["get_transaction", { transactionId: transaction.id }],
      ["get_transaction_totals", { connectionId }],
      ["list_events", { connectionId }],
      ["list_sync_runs", { connectionId }],
      ["list_refreshes", { connectionId }],
    ] as const) {
      await invoke(name, input);
    }
    await expect(
      invoke("get_refresh", { refreshId: "missing" }),
    ).rejects.toThrow();
    expect(await invoke("refresh_connection", {})).toEqual({ refreshes: [] });
    expect(afterWrite).not.toHaveBeenCalled();

    const updated = (await invoke("update_annotation", {
      transactionId: transaction.id,
      expectedVersion: 0,
      notes: "Synthetic follow-up note",
    })) as { annotation: { version: number } };
    expect(afterWrite).toHaveBeenCalledTimes(1);
    // A stale version and invalid input commit nothing.
    await expect(
      invoke("update_annotation", {
        transactionId: transaction.id,
        expectedVersion: 0,
        notes: "Synthetic stale note",
      }),
    ).rejects.toThrow();
    await expect(
      invoke("update_annotation", { transactionId: transaction.id }),
    ).rejects.toThrow();
    expect(afterWrite).toHaveBeenCalledTimes(1);

    const [edit] = (
      await db.listEvents({ connectionId, after: 0, limit: 1000 })
    )
      .filter((event) => event.type === "annotation.updated")
      .slice(-1);
    await invoke("undo_annotation", {
      eventId: edit!.id,
      expectedVersion: updated.annotation.version,
    });
    expect(afterWrite).toHaveBeenCalledTimes(2);
    await invoke("confirm_removal", {
      transactionId: transaction.id,
      expectedTransactionVersion: transaction.version,
      reason: "Synthetic confirmed removal",
    });
    expect(afterWrite).toHaveBeenCalledTimes(3);
  });

  it("follows a pending-to-posted link and its unlink", async () => {
    await db.ingestRun(
      {
        runId: "synthetic-follow-up-posted",
        connectionId,
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-08-02T00:00:00Z",
            responseText: readFileSync(
              new URL(
                "../providers/cal/fixtures/recent-02.json",
                import.meta.url,
              ),
              "utf8",
            ),
          },
        ],
      },
      calAdapter,
    );
    const rows = await db.listTransactions();
    const pending = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-AUTH-PENDING-POSTED"),
    )!;
    const posted = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-TXN-PENDING-POSTED"),
    )!;
    const pair = {
      transactionId: pending.id,
      postedId: posted.id,
      expectedPendingAnnotationVersion: 0,
      expectedPostedAnnotationVersion: 0,
      reason: "Synthetic owner confirmation",
    };
    await invoke("link_pending_transaction", {
      ...pair,
      expectedPendingTransactionVersion: pending.version,
      expectedPostedTransactionVersion: posted.version,
    });
    expect(afterWrite).toHaveBeenCalledTimes(1);
    await invoke("unlink_pending_transaction", {
      ...pair,
      expectedPendingTransactionVersion: pending.version + 1,
      expectedPostedTransactionVersion: posted.version + 1,
    });
    expect(afterWrite).toHaveBeenCalledTimes(2);
  });

  it("returns the committed result when the follow-up throws", async () => {
    const transaction = (await db.listTransactions())[0]!;
    afterWrite.mockImplementation(() => {
      throw new Error("synthetic delivery failure");
    });
    const result = await invoke("update_annotation", {
      transactionId: transaction.id,
      expectedVersion: 0,
      notes: "Synthetic committed note",
    });
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      annotation: { transactionId: transaction.id, version: 1 },
    });
    expect(
      await invoke("get_transaction", { transactionId: transaction.id }),
    ).toMatchObject({
      transaction: {
        annotation: { version: 1, notes: "Synthetic committed note" },
      },
    });
  });
});
