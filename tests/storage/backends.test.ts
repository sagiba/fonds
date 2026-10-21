import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeliveryConflictError } from "../../src/application/change-delivery.js";
import { collectFromStore } from "../../src/application/collection.js";
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from "../../src/domain/errors.js";
import { emptyDetails } from "../../src/domain/model.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  createEmbeddedScheduler,
  parseCollectionSchedule,
} from "../../src/runtime/collection-schedule.js";
import { postgresMigrations } from "../../src/storage/postgres/migration.js";
import { sqliteMigrations } from "../../src/storage/sqlite/migration.js";
import {
  backends,
  fixture,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`storage contract: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    let seq = 0;
    const nextRun = () => `${connectionId}-${seq++}`;
    const capture = async (
      responseText: string,
      adapter = synthetic,
      runId = nextRun(),
      capturedAt = "2040-08-01T00:00:00Z",
    ) =>
      db.ingestRun(
        {
          debugArchiveDays: 2,
          runId,
          connectionId,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:cal/recent",
              capturedAt,
              responseText,
            },
          ],
        },
        adapter,
      );
    const all = async () =>
      (await db.listTransactionPage({
        connectionId,
        includeSuperseded: true,
        limit: 200,
      }))!.transactions;
    /** Cards are addressed by service ID; tests find them by provider key. */
    const cardByKey = async (providerKey: string) =>
      (await db.listCards({ connectionId, limit: 200 })).cards.find(
        (card) => card.providerKey === providerKey,
      );
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `synthetic-${randomUUID()}`;
      seq = 0;
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(async () => {
      await db?.close();
    });
    it("allows only one concurrent creator of a new connection name", async () => {
      const id = `${connectionId}-new`;
      const results = await Promise.allSettled([
        db.ensureConnection({ id, provider: "cal" }, { requireNew: true }),
        db.ensureConnection({ id, provider: "isracard" }, { requireNew: true }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(ConflictError);
      const created = results.find((result) => result.status === "fulfilled")!;
      expect(await db.getConnection(id)).toMatchObject({
        provider: created.value.provider,
      });
      await expect(
        db.ensureConnection({ id, provider: "cal" }, { requireNew: true }),
      ).rejects.toThrow(ConflictError);
    });
    it("persists card discovery before failed financial reads without ledger changes", async () => {
      const card = {
        cardKey: "card",
        last4: "0012",
        displayName: "Synthetic Earlier",
      };
      const observedAt = "2040-01-01T00:00:00.000Z";
      const before = await db.ledgerRevision(connectionId);
      const summary = await collectFromStore(
        db,
        { connectionId },
        {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          async *collect() {
            yield {
              type: "card_discovery",
              discovery: { observedAt, cards: [card] },
            };
            expect(await cardByKey(card.cardKey)).toMatchObject({
              providerKey: card.cardKey,
              last4: card.last4,
              displayName: card.displayName,
              connectionId,
              lastSeenAt: observedAt,
            });
            yield {
              type: "card_discovery",
              discovery: { observedAt: "2040-02-01T00:00:00Z", cards: [] },
            };
            expect(await db.ledgerRevision(connectionId)).toBe(before);
            yield {
              type: "failure",
              failure: {
                accountKey: "account",
                endpoint: "synthetic/recent",
                code: "network_error",
              },
              fatal: true,
            };
          },
        },
        calAdapter,
      );
      expect(summary).toMatchObject({
        status: "failed",
        captures: 0,
        failures: 1,
        created: 0,
        updated: 0,
      });
      const retained = (await db.listCards({ connectionId })).cards;
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({
        providerKey: card.cardKey,
        last4: card.last4,
        displayName: card.displayName,
        connectionId,
        lastSeenAt: observedAt,
      });
      expect(retained[0]?.createdAt).toMatch(/^\d{4}-/);
      expect(await db.getConnection(connectionId)).not.toHaveProperty("cards");
      expect(
        (await db.getStoredConnection(connectionId))?.config,
      ).not.toHaveProperty("cardDirectory");
      expect(
        (await db.listEvents({ connectionId })).filter(
          (change) => change.transactionId !== null,
        ),
      ).toEqual([]);
    });

    it("retains more than 1000 lifetime cards and paginates deterministically", async () => {
      const observedAt = "2040-01-01T00:00:00Z";
      await db.recordCardDiscovery(connectionId, {
        observedAt,
        cards: Array.from({ length: 1000 }, (_, index) => ({
          cardKey: `card-${String(index).padStart(4, "0")}`,
          last4: "0012",
        })),
      });
      await db.recordCardDiscovery(connectionId, {
        observedAt,
        cards: [{ cardKey: "new-card", last4: "3456" }],
      });
      const keys: string[] = [];
      const order: string[] = [];
      let after: { createdAt: string; id: string } | undefined;
      let hasMore = true;
      while (hasMore) {
        const page = await db.listCards({ connectionId, after, limit: 200 });
        keys.push(...page.cards.map((card) => card.providerKey));
        order.push(
          ...page.cards.map((card) =>
            JSON.stringify([card.createdAt, card.id]),
          ),
        );
        const last = page.cards.at(-1);
        after = last && { createdAt: last.createdAt, id: last.id };
        hasMore = page.hasMore;
      }
      expect(keys).toHaveLength(1001);
      expect(new Set(keys).size).toBe(1001);
      // Catalog order: creation time, then service ID.
      expect(order).toEqual([...order].sort());
      expect(await db.listEvents({ connectionId })).toEqual([]);
    });

    it("creates identity-only cards for offline transaction references and enriches them through discovery", async () => {
      await capture(
        JSON.stringify([
          row("card-reference", { cardKey: "retained-card" }),
          row("bank-row", { cardKey: null }),
        ]),
      );
      const stub = await cardByKey("retained-card");
      expect(stub).toEqual({
        id: expect.any(String),
        connectionId,
        providerKey: "retained-card",
        billingAccountId: null,
        last4: null,
        displayName: null,
        attributes: null,
        createdAt: expect.any(String),
        lastSeenAt: null,
      });
      expect(await db.getCard(stub!.id)).toEqual(stub);
      expect(
        (await all()).map(({ sourceKey, cardId }) => [sourceKey, cardId]),
      ).toEqual(
        expect.arrayContaining([
          ["card-reference", stub!.id],
          ["bank-row", null],
        ]),
      );
      expect((await db.listCards({ connectionId })).cards).toHaveLength(1);
      const revision = await db.ledgerRevision(connectionId);
      await db.recordCardDiscovery(connectionId, {
        observedAt: "2040-01-01T00:00:00Z",
        cards: [
          {
            cardKey: "retained-card",
            last4: "0012",
            displayName: "Synthetic Card",
          },
        ],
      });
      const enriched = await db.getCard(stub!.id);
      expect(enriched).toEqual({
        ...stub,
        last4: "0012",
        displayName: "Synthetic Card",
        lastSeenAt: "2040-01-01T00:00:00Z",
      });
      await capture(
        JSON.stringify([row("card-reference", { cardKey: "retained-card" })]),
        synthetic,
        nextRun(),
        "2040-08-02T00:00:00Z",
      );
      expect(await db.getCard(stub!.id)).toEqual(enriched);
      await db.recordCardDiscovery(connectionId, {
        observedAt: "2039-01-01T00:00:00Z",
        cards: [
          { cardKey: "retained-card", last4: "9999", displayName: "Stale" },
        ],
      });
      expect(await db.getCard(stub!.id)).toEqual(enriched);
      expect(revision).toMatch(/^\d+:2$/);
      const financial = (await all())[0]!;
      await expect(
        db.raw("UPDATE transactions SET card_id = ? WHERE id = ?", [
          "missing-card",
          financial.id,
        ]),
      ).rejects.toThrow();
    });

    it("merges serialized discovery observations without losing known metadata", async () => {
      const observations = [
        {
          observedAt: "2040-03-01T00:00:00Z",
          cards: [
            { cardKey: "card", last4: "0012", displayName: "Synthetic Newer" },
          ],
        },
        {
          observedAt: "2040-01-01T00:00:00Z",
          cards: [
            { cardKey: "card", last4: "9999", displayName: "Synthetic Older" },
          ],
        },
      ];
      const results = await Promise.allSettled(
        observations.map((discovery) =>
          db.recordCardDiscovery(connectionId, discovery),
        ),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          // Single-client libSQL and guarded D1 surface concurrent writers for retry.
          await db.recordCardDiscovery(connectionId, observations[index]!);
        }
      }
      await db.recordCardDiscovery(connectionId, {
        observedAt: "2040-04-01T00:00:00Z",
        cards: [{ cardKey: "card", last4: null }],
      });
      expect(await cardByKey("card")).toMatchObject({
        last4: "0012",
        displayName: "Synthetic Newer",
        lastSeenAt: "2040-04-01T00:00:00Z",
      });
      await expect(
        db.recordCardDiscovery(connectionId, {
          observedAt: "2040-05-01T00:00:00Z",
          cards: [{ cardKey: "card", last4: "unsafe" }],
        }),
      ).rejects.toThrow();
      expect((await cardByKey("card"))?.last4).toBe("0012");
    });

    it("resolves billing accounts from discovery and scopes transactions by account and card", async () => {
      const billingAccount = { providerKey: "bank-account", mask: "0042" };
      await db.recordCardDiscovery(connectionId, {
        observedAt: "2040-01-01T00:00:00Z",
        cards: [
          { cardKey: "card", last4: "0012", billingAccount },
          { cardKey: "second-card", last4: "3456", billingAccount },
          { cardKey: "unbilled-card", last4: "7890" },
        ],
      });
      await capture(
        JSON.stringify([
          row("first", { cardKey: "card" }),
          row("second", { cardKey: "second-card" }),
          row("unbilled", { cardKey: "unbilled-card" }),
        ]),
      );
      const accounts = (await db.listAccounts({ connectionId })).accounts;
      expect(accounts).toEqual([
        {
          id: expect.any(String),
          connectionId,
          providerKey: "bank-account",
          type: "depository",
          institutionName: null,
          mask: "0042",
          displayName: null,
          createdAt: expect.any(String),
          lastSeenAt: "2040-01-01T00:00:00Z",
        },
      ]);
      const account = accounts[0]!;
      expect(await db.getAccount(account.id)).toEqual(account);
      const card = (await cardByKey("card"))!;
      expect(card.billingAccountId).toBe(account.id);
      expect((await cardByKey("second-card"))?.billingAccountId).toBe(
        account.id,
      );
      expect((await cardByKey("unbilled-card"))?.billingAccountId).toBeNull();
      const billed = await db.listTransactionPage({
        connectionId,
        billingAccountId: account.id,
        limit: 50,
      });
      expect(billed.transactions.map((row) => row.sourceKey).sort()).toEqual([
        "first",
        "second",
      ]);
      expect(
        (await db.getTotals({ connectionId, billingAccountId: account.id }))
          .includedCount,
      ).toBe(2);
      expect(
        (
          await db.listTransactionPage({
            connectionId,
            cardId: card.id,
            billingAccountId: account.id,
            limit: 50,
          })
        ).transactions.map((row) => row.sourceKey),
      ).toEqual(["first"]);
      const other = `${connectionId}-other`;
      await db.ensureConnection({ id: other, provider: "cal" });
      for (const filters of [
        { connectionId: other, billingAccountId: account.id },
        { connectionId: other, cardId: card.id },
        { connectionId, cardId: "missing-card" },
        { connectionId, billingAccountId: "missing-account" },
      ]) {
        await expect(
          db.listTransactionPage({ ...filters, limit: 50 }),
        ).rejects.toThrow(InvalidInputError);
        await expect(db.getTotals(filters)).rejects.toThrow(InvalidInputError);
      }
      expect(
        (await db.listEvents({ connectionId })).every(
          (event) => event.connectionId === connectionId,
        ),
      ).toBe(true);
      expect(await db.listEvents({ connectionId: other })).toEqual([]);
    });

    it("replays an archive without discovery: reference-only cards, no accounts, quiet re-apply", async () => {
      const runId = nextRun();
      await capture(
        JSON.stringify([row("replayed", { cardKey: "card" })]),
        synthetic,
        runId,
      );
      expect((await db.listAccounts({ connectionId })).accounts).toEqual([]);
      const card = (await cardByKey("card"))!;
      expect(card).toMatchObject({
        billingAccountId: null,
        last4: null,
        displayName: null,
        lastSeenAt: null,
      });
      const [transaction] = await all();
      expect(transaction).toMatchObject({
        sourceScope: "account",
        cardId: card.id,
      });
      const events = await db.listEvents({ connectionId });
      expect(await db.applyRun(runId, synthetic)).toMatchObject({
        replayed: true,
      });
      expect(await db.listEvents({ connectionId })).toEqual(events);
      expect((await db.listCards({ connectionId })).cards).toEqual([card]);
      await db.recordCardDiscovery(connectionId, {
        observedAt: "2040-01-01T00:00:00Z",
        cards: [
          {
            cardKey: "card",
            last4: "0012",
            billingAccount: { providerKey: "bank-account" },
          },
        ],
      });
      const [account] = (await db.listAccounts({ connectionId })).accounts;
      expect(await db.getCard(card.id)).toMatchObject({
        id: card.id,
        billingAccountId: account!.id,
        last4: "0012",
      });
      expect((await all())[0]?.cardId).toBe(card.id);
      expect(await db.listEvents({ connectionId })).toEqual(events);
    });

    it("rejects duplicate discovery keys before changing any retained or unrelated card", async () => {
      await db.recordCardDiscovery(connectionId, {
        observedAt: "2040-01-01T00:00:00Z",
        cards: [
          {
            cardKey: "retained",
            last4: "0012",
            displayName: "Synthetic Original",
          },
        ],
      });
      const before = await db.listCards({ connectionId });
      const revision = await db.ledgerRevision(connectionId);
      await expect(
        db.recordCardDiscovery(connectionId, {
          observedAt: "2040-02-01T00:00:00Z",
          cards: [
            { cardKey: "unrelated-new", last4: "5555" },
            {
              cardKey: "retained",
              last4: "3456",
              displayName: "Conflicting One",
            },
            {
              cardKey: "retained",
              last4: "7890",
              displayName: "Conflicting Two",
            },
          ],
        }),
      ).rejects.toThrow("each card key once");
      expect(await db.listCards({ connectionId })).toEqual(before);
      expect(await cardByKey("unrelated-new")).toBeUndefined();
      expect(await db.ledgerRevision(connectionId)).toBe(revision);
    });

    it("enforces canonical four-digit MCCs in SQL while preserving leading zeros and unknown values", async () => {
      await capture(
        JSON.stringify([row("mcc", { merchantCategoryCode: "0123" })]),
      );
      const transaction = (await all())[0]!;
      for (const invalid of ["123", "12345", "12A4", "１２３４", "5411\n"]) {
        await expect(
          db.raw(
            "UPDATE transactions SET merchant_category_code = ? WHERE id = ?",
            [invalid, transaction.id],
          ),
        ).rejects.toThrow();
      }
      expect(
        (await db.getTransaction(transaction.id))?.merchantCategoryCode,
      ).toBe("0123");
      await db.raw(
        "UPDATE transactions SET merchant_category_code = ? WHERE id = ?",
        [null, transaction.id],
      );
      expect(
        (await db.getTransaction(transaction.id))?.merchantCategoryCode,
      ).toBeNull();
    });

    it("preserves fixture evidence, annotations, correction staleness, replay and exact totals", async () => {
      const runId = nextRun();
      expect(
        await capture(fixture("recent-01"), calAdapter, runId),
      ).toMatchObject({ created: 21, replayed: false });
      const before = (await all()).find((t) =>
        t.sourceKey.includes('"SYNTHETIC-TXN-CORRECTED"'),
      )!;
      const annotation = await db.editAnnotation({
        transactionId: before.id,
        expectedVersion: 0,
        expectedTransactionVersion: before.version,
        notes: "retained",
        category: "example",
        review: { status: "approved" },
      });
      expect(
        (await capture(fixture("recent-02"), calAdapter)).updated,
      ).toBeGreaterThan(0);
      expect(await db.getTransaction(before.id)).toMatchObject({
        amountMinor: -7560,
        reviewStale: true,
        annotation,
      });
      await expect(
        Promise.resolve().then(() =>
          db.editAnnotation({ transactionId: before.id, expectedVersion: 0 }),
        ),
      ).rejects.toThrow(ConflictError);
      const throwing = {
        ...calAdapter,
        parserVersion: "later-version",
        extract: () => {
          throw new Error("must not execute applied parser");
        },
      };
      expect(await db.applyRun(runId, throwing)).toMatchObject({
        replayed: true,
      });
      const stored = await db.raw(
        "SELECT snapshot_json FROM sync_run_bodies WHERE run_id = ?",
        [runId],
      );
      expect(
        JSON.parse(String(stored[0]!.snapshot_json)).responses[0].responseText,
      ).toBe(fixture("recent-01"));
      const totals = await db.getTotals({ connectionId });
      expect(totals.includedCount).toBeGreaterThan(0);
      expect(
        totals.totals.every((t) => Number.isSafeInteger(t.amountMinor)),
      ).toBe(true);
    });
    it("rejects missing connections and provider mismatches before retaining evidence", async () => {
      const input = {
        connectionId: "missing",
        runId: nextRun(),
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:missing-connection",
            capturedAt: "2040-08-01T00:00:00Z",
            responseText: "[]",
          },
        ],
      };
      await expect(
        Promise.resolve().then(() => db.ingestRun(input, synthetic)),
      ).rejects.toThrow(NotFoundError);
      await expect(
        Promise.resolve().then(() =>
          db.ingestRun(
            {
              debugArchiveDays: 2,
              ...input,
              connectionId,
            },
            {
              ...synthetic,
              provider: "other-provider",
            },
          ),
        ),
      ).rejects.toThrow("Connection provider mismatch");
      expect(
        await db.raw("SELECT id FROM sync_runs WHERE id = ?", [input.runId]),
      ).toEqual([]);
    });
    it("checks immutable same-ID evidence and concurrent no-op ingestion", async () => {
      const runId = nextRun();
      const text = JSON.stringify([row("one")]);
      // Native SQLite and local libSQL have a single in-process connection; remote contenders use server transactions.
      // Local D1 interleaves statements and rejects a stale write batch.
      if (
        backend === "postgres" ||
        backend === "libsql-http" ||
        backend === "d1-local"
      ) {
        const results = await Promise.allSettled([
          capture(text, synthetic, runId),
          capture(text, synthetic, runId),
        ]);
        if (backend === "postgres") {
          expect(results.every((r) => r.status === "fulfilled")).toBe(true);
          expect(
            results.filter((r) => r.status === "fulfilled" && r.value.replayed),
          ).toHaveLength(1);
        } else if (backend === "d1-local") {
          for (const result of results) {
            if (result.status === "rejected") {
              expect(result.reason).toBeInstanceOf(ConflictError);
            }
          }
          expect(results.some((r) => r.status === "fulfilled")).toBe(true);
        } else {
          for (const result of results) {
            if (result.status === "rejected") {
              expect(driverCode(result.reason)).toMatch(/^SQLITE_BUSY/);
            }
          }
          expect(results.some((r) => r.status === "fulfilled")).toBe(true);
        }
        expect(await capture(text, synthetic, runId)).toMatchObject({
          replayed: true,
        });
      } else {
        await capture(text, synthetic, runId);
        expect(await capture(text, synthetic, runId)).toMatchObject({
          replayed: true,
        });
      }
      await expect(
        capture(JSON.stringify([row("different")]), synthetic, runId),
      ).rejects.toThrow("different evidence");
      expect(await all()).toHaveLength(1);
      expect(
        (await db.listEvents({ connectionId })).filter(
          (c) => c.type === "sync.baseline",
        ),
      ).toHaveLength(1);
      const other = `other-${randomUUID()}`;
      await db.ensureConnection({ id: other, provider: "cal" });
      await expect(
        Promise.resolve().then(() =>
          db.ingestRun(
            {
              debugArchiveDays: 2,
              runId,
              connectionId: other,
              responses: [
                {
                  accountKey: "account",
                  endpoint: "synthetic:cal/recent",
                  capturedAt: "2040-08-01T00:00:00Z",
                  responseText: text,
                },
              ],
            },
            synthetic,
          ),
        ),
      ).rejects.toThrow("different evidence");
    });
    it("edits and undoes only the current annotation version including NUL JSON", async () => {
      await capture(JSON.stringify([row("one")]));
      const transaction = (await all())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: transaction.id,
        expectedVersion: 0,
        notes: "actual\u0000nul",
        metadata: { literal: "\\u0000", actual: "\u0000" },
      });
      const change = (await db.listEvents({ connectionId })).find(
        (c) => c.type === "annotation.updated",
      )!;
      expect((await db.getTransaction(transaction.id))?.annotation).toEqual(
        annotation,
      );
      const undone = await db.undoAnnotation({
        eventId: change.id,
        expectedVersion: 1,
      });
      expect(undone.data.notes).toBeNull();
      await expect(
        Promise.resolve().then(() =>
          db.undoAnnotation({ eventId: change.id, expectedVersion: 1 }),
        ),
      ).rejects.toThrow(ConflictError);
    });
    it("retains exact arbitrary source strings including actual NUL versus literal escape", async () => {
      const adapter = {
        ...synthetic,
        extract: () => ({
          transactions: [],
          partitions: [],
          warnings: [],
          historical: false,
        }),
      };
      const runId = nextRun();
      const text = "actual\u0000literal\\u0000 astral 🚀";
      await capture(text, adapter, runId);
      const stored = await db.raw(
        "SELECT snapshot_json FROM sync_run_bodies WHERE run_id = ?",
        [runId],
      );
      expect(
        JSON.parse(String(stored[0]!.snapshot_json)).responses[0].responseText,
      ).toBe(text);
    });
    it("keeps explicit posting/removal candidate references atomic", async () => {
      const pending = row("pending", {
        status: "pending",
        amountBasis: "authorization",
        details: {
          ...emptyDetails(),
          issues: ["possible_pending_posted_match"],
        },
      });
      await capture(JSON.stringify([pending, row("posted"), row("third")]));
      let rows = await all();
      const p = rows.find((r) => r.sourceKey === "pending")!;
      const posted = rows.find((r) => r.sourceKey === "posted")!;
      await db.linkPendingTransaction({
        pendingId: p.id,
        postedId: posted.id,
        expectedPendingVersion: p.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "synthetic confirmation",
      });
      expect(await db.getTransaction(posted.id)).toMatchObject({
        supersededById: p.id,
      });
      expect(await db.getTransaction(p.id)).toMatchObject({ status: "posted" });
      rows = await all();
      const third = rows.find((r) => r.sourceKey === "third")!;
      await db.confirmRemoval({
        transactionId: third.id,
        expectedVersion: third.version,
        reason: "synthetic removal",
      });
      expect(await db.getTransaction(third.id)).toMatchObject({
        presence: "removed",
      });
    });
    it("rejects cross-account and missing posting targets without writing either row", async () => {
      await capture(
        JSON.stringify([
          row("pending", { status: "pending", amountBasis: "authorization" }),
          row("posted"),
        ]),
      );
      const rows = await all();
      const pending = rows.find((value) => value.sourceKey === "pending")!;
      const posted = rows.find((value) => value.sourceKey === "posted")!;
      await db.raw("UPDATE transactions SET source_scope = ? WHERE id = ?", [
        "other-account",
        posted.id,
      ]);
      const before = await all();
      const changes = await db.listEvents({ connectionId });
      const command = {
        pendingId: pending.id,
        postedId: posted.id,
        expectedPendingVersion: pending.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "synthetic invalid target",
      };
      await expect(
        Promise.resolve().then(() => db.linkPendingTransaction(command)),
      ).rejects.toThrow(ConflictError);
      await expect(
        Promise.resolve().then(() =>
          db.linkPendingTransaction({ ...command, postedId: "missing" }),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(await all()).toEqual(before);
      expect(await db.listEvents({ connectionId })).toEqual(changes);
    });
    it("keeps a connection's provider immutable", async () => {
      await expect(
        Promise.resolve().then(() =>
          db.ensureConnection({ id: connectionId, provider: "other-provider" }),
        ),
      ).rejects.toThrow("Connection provider cannot change");
      expect((await db.getConnection(connectionId))?.provider).toBe("cal");
    });
    it("rejects an inconsistent applied run still marked started", async () => {
      const runId = nextRun();
      await capture(JSON.stringify([row("one")]), synthetic, runId);
      await db.raw("UPDATE sync_runs SET status = 'started' WHERE id = ?", [
        runId,
      ]);
      await expect(
        Promise.resolve().then(() => db.applyRun(runId, synthetic)),
      ).rejects.toThrow("Applied run has invalid status");
    });
    if (
      backend === "postgres" ||
      backend === "libsql-http" ||
      backend === "d1-local"
    ) {
      it("commits one of two competing annotation edits with one audit event", async () => {
        await capture(JSON.stringify([row("one")]));
        const transaction = (await all())[0]!;
        const results = await Promise.allSettled(
          ["first", "second"].map((notes) =>
            db.editAnnotation({
              transactionId: transaction.id,
              expectedVersion: 0,
              notes,
            }),
          ),
        );
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        for (const result of results) {
          if (result.status === "rejected") {
            if (
              backend === "libsql-http" &&
              driverCode(result.reason)?.startsWith("SQLITE_BUSY")
            ) {
              continue;
            }
            expect(result.reason).toBeInstanceOf(ConflictError);
          }
        }
        expect(
          (await db.getTransaction(transaction.id))?.annotation?.version,
        ).toBe(1);
        expect(
          (await db.listEvents({ connectionId })).filter(
            (change) => change.type === "annotation.updated",
          ),
        ).toHaveLength(1);
      });
    }
    it("bounds pages and gives Unicode/null ordering equal to SQLite", async () => {
      await capture(
        JSON.stringify([
          row("null", { transactionDate: null }),
          row("astral", { merchantName: "🚀" }),
          row("highbmp", { merchantName: "\uE000" }),
        ]),
      );
      const rows = await all();
      const nonnull = rows.filter((r) => r.transactionDate !== null);
      expect(rows.at(-1)?.sourceKey).toBe("null");
      const page = await db.listTransactionPage({ connectionId, limit: 1 });
      expect(page.transactions).toHaveLength(1);
      expect(page.hasMore).toBe(true);
      const next = await db.listTransactionPage({
        connectionId,
        limit: 1,
        after: {
          transactionDate: page.transactions[0]!.transactionDate,
          id: page.transactions[0]!.id,
        },
      });
      expect(next.transactions[0]?.id).toBe(rows[1]?.id);
      expect(nonnull).toHaveLength(2);
      await expect(
        Promise.resolve().then(() =>
          db.listTransactionPage({ connectionId, limit: 201 }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve().then(() =>
          db.listEvents({ connectionId, limit: 1001 }),
        ),
      ).rejects.toThrow();
    });
    it("preserves concurrent config fields and consumer cursors with conflicts", async () => {
      await db.updateConfig(connectionId, (config) => ({
        ...config,
        setting: "kept",
      }));
      // All config reads/writes use their transaction's handle, including pools with max=1.
      const calls = [
        () =>
          db.updateConfig(connectionId, (config) => ({
            ...config,
            another: "also kept",
          })),
        () => db.acknowledgeCursor(connectionId, "a", 0, 1),
        () => db.acknowledgeCursor(connectionId, "b", 0, 2),
      ];
      if (backend === "libsql-local") {
        for (const call of calls) {
          await call();
        }
      }
      const results =
        backend === "libsql-local"
          ? []
          : await Promise.allSettled(calls.map((call) => call()));
      for (const result of results) {
        if (result.status === "rejected") {
          if (backend === "d1-local") {
            expect(result.reason).toBeInstanceOf(ConflictError);
            continue;
          }
          expect(backend).toBe("libsql-http");
          expect(driverCode(result.reason)).toMatch(/^SQLITE_BUSY/);
        }
      }
      // A driver may report confirmed lock contention or a stale D1 batch; retry only those known rejections.
      if (results[0]?.status === "rejected") {
        await db.updateConfig(connectionId, (config) => ({
          ...config,
          another: "also kept",
        }));
      }
      if (results[1]?.status === "rejected") {
        await db.acknowledgeCursor(connectionId, "a", 0, 1);
      }
      if (results[2]?.status === "rejected") {
        await db.acknowledgeCursor(connectionId, "b", 0, 2);
      }
      expect(
        (await db.getStoredConnection(connectionId))?.config,
      ).toMatchObject({
        setting: "kept",
        another: "also kept",
        changeCursors: { a: 1, b: 2 },
      });
      await db.acknowledgeCursor(connectionId, "__proto__", 0, 3);
      expect(await db.getDeliveryCursor(connectionId, "__proto__")).toBe(3);
      await expect(
        Promise.resolve().then(() =>
          db.acknowledgeCursor(connectionId, "a", 0, 4),
        ),
      ).rejects.toThrow(DeliveryConflictError);
    });
    // Run remote integration files serially: transient trigger declarations share
    // the dedicated HTTP server with strict migration-lineage validation.
    it("retains evidence but rolls back a failed canonical and audit commit", async () => {
      const runId = nextRun();
      const trigger = `synthetic_fail_${randomUUID().replaceAll("-", "")}`;
      if (backend === "postgres") {
        await db.raw(
          `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$`,
        );
        await db.raw(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        );
      } else {
        await db.raw(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON events WHEN NEW.run_id = '${runId}' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`,
        );
      }
      try {
        await expect(
          capture(JSON.stringify([row("one")]), synthetic, runId),
        ).rejects.toThrow();
        expect(await all()).toHaveLength(0);
        expect(await db.listEvents({ connectionId })).toHaveLength(0);
        expect(
          (
            await db.raw("SELECT applied_at FROM sync_runs WHERE id = ?", [
              runId,
            ])
          )[0]?.applied_at,
        ).toBeNull();
      } finally {
        await db.raw(
          `DROP TRIGGER ${trigger}${backend === "postgres" ? " ON events" : ""}`,
        );
      }
      await expect(
        Promise.resolve().then(() =>
          db.applyRun(runId, { ...synthetic, parserVersion: "different" }),
        ),
      ).rejects.toThrow("parser version");
      expect(await db.applyRun(runId, synthetic)).toMatchObject({
        replayed: false,
        created: 1,
      });
    });

    describe("scheduled collection occurrences", () => {
      const occurrence = (iso: string) => ({
        key: `scheduled-${iso.slice(0, 16)}Z`,
        at: Date.parse(iso),
      });
      const first = occurrence("2026-10-20T03:17:00Z");
      const second = occurrence("2026-10-21T03:17:00Z");
      const now = Date.parse("2026-10-21T04:00:00Z");
      const rows = () =>
        db.raw(
          "SELECT occurrence, status FROM scheduled_collections ORDER BY scheduled_at",
        );

      it("claims each occurrence once, in order", async () => {
        const claim = await db.claimOccurrence(first, now);
        expect(claim).toEqual(expect.any(String));
        // Running under a live lease, then finished: never claimed again.
        expect(await db.claimOccurrence(first, now)).toBeUndefined();
        await db.finishOccurrence(first, claim!);
        expect(await db.claimOccurrence(first, now)).toBeUndefined();
        expect(await db.claimOccurrence(second, now)).toBeDefined();
        // An earlier occurrence never runs after a later one.
        expect(
          await db.claimOccurrence(occurrence("2026-10-20T12:00:00Z"), now),
        ).toBeUndefined();
        expect(await rows()).toEqual([
          { occurrence: first.key, status: "finished" },
          { occurrence: second.key, status: "running" },
        ]);
      });

      it("lets one of several concurrent claimers win", async () => {
        const won = await Promise.all(
          Array.from({ length: 5 }, () => db.claimOccurrence(first, now)),
        );
        expect(won.filter(Boolean)).toHaveLength(1);
      });

      it("retakes a released or lapsed claim, never a finished one", async () => {
        const released = await db.claimOccurrence(first, now);
        await db.releaseOccurrence(first, released!);
        const lapsed = await db.claimOccurrence(first, now);
        expect(lapsed).toBeDefined();
        // A holder that vanished: its 15-minute lease ends.
        expect(
          await db.claimOccurrence(first, now + 14 * 60_000),
        ).toBeUndefined();
        const current = await db.claimOccurrence(first, now + 16 * 60_000);
        expect(current).toBeDefined();
        // The vanished holder can neither release nor finish the new claim.
        await db.releaseOccurrence(first, lapsed!);
        await db.finishOccurrence(first, lapsed!);
        expect(
          await db.claimOccurrence(first, now + 17 * 60_000),
        ).toBeUndefined();
        expect((await rows())[0]).toMatchObject({ status: "running" });
        await db.finishOccurrence(first, current!);
        await db.releaseOccurrence(first, current!);
        expect(
          await db.claimOccurrence(first, now + 60 * 60_000),
        ).toBeUndefined();
      });

      it("prunes runs older than the retention window", async () => {
        const old = occurrence("2026-01-01T00:00:00Z");
        expect(await db.claimOccurrence(old, old.at)).toBeDefined();
        expect(await db.claimOccurrence(second, now)).toBeDefined();
        expect((await rows()).map((stored) => stored.occurrence)).toEqual([
          second.key,
        ]);
      });

      it("keeps a generated setting once and returns it on every start", async () => {
        expect(await db.ensureSetting("collection_time", () => "03:17")).toBe(
          "03:17",
        );
        const generate = vi.fn(() => "11:11");
        expect(await db.ensureSetting("collection_time", generate)).toBe(
          "03:17",
        );
        expect(generate).not.toHaveBeenCalled();
        const concurrent = await Promise.all(
          ["01:01", "02:02", "03:03"].map((value) =>
            db.ensureSetting("other_setting", () => value),
          ),
        );
        expect(new Set(concurrent).size).toBe(1);
      });

      it("runs a due occurrence once across schedulers sharing the database", async () => {
        const schedule = parseCollectionSchedule(
          {
            FONDS_REFRESH_SCHEDULE: "hourly",
            FONDS_REFRESH_TIME: "00:05",
          },
          "unused",
        );
        const runs: string[] = [];
        const scheduler = (at: string) =>
          createEmbeddedScheduler({
            schedule,
            claims: db,
            collect: async (occurrence) => {
              runs.push(occurrence.key);
              return [];
            },
            deliver: async () => {},
            now: () => Date.parse(at),
            maxJitterMs: 0,
            log: () => {},
          });
        const schedulers = Array.from({ length: 3 }, () =>
          scheduler("2026-10-20T10:30:00Z"),
        );
        for (const each of schedulers) {
          each.start();
        }
        await expect.poll(() => runs.length).toBe(1);
        for (const each of schedulers) {
          each.stop();
        }
        await Promise.all(schedulers.map((each) => each.settled()));
        // A restarted scheduler finds it recorded and runs nothing.
        const restarted = scheduler("2026-10-20T10:45:00Z");
        restarted.start();
        await new Promise((resolve) => setTimeout(resolve, 100));
        restarted.stop();
        await restarted.settled();
        expect(runs).toEqual(["scheduled-2026-10-20T10:05Z"]);
        expect((await rows())[0]).toMatchObject({ status: "finished" });
      });
    });
  });
}

it.each([
  ["migrations/", sqliteMigrations],
  ["migrations/postgres/", postgresMigrations],
] as const)(
  "embeds every numbered migration in %s byte-identical and in order",
  (directory, migrations) => {
    const root = new URL(`../../${directory}`, import.meta.url);
    const files = readdirSync(root)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(
      migrations.map(({ version, name }) => ({ version, file: `${name}.sql` })),
    ).toEqual(files.map((file, index) => ({ version: index + 1, file })));
    for (const migration of migrations) {
      expect(migration.sql).toBe(
        readFileSync(new URL(`${migration.name}.sql`, root), "utf8"),
      );
    }
  },
);

function driverCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "cause" in error ? driverCode(error.cause) : undefined;
}
