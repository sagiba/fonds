import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import {
  parsedLedgerFacts,
  storedPaymentContext,
  transactionInputSchema,
} from "../../src/domain/model.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import {
  cards,
  syncRunBodies,
  syncRuns,
} from "../../src/storage/sqlite/schema.js";
import { retained as retainedEvidence } from "../helpers/provider-evidence.js";
import { insertTransaction } from "../helpers/sqlite-transactions.js";

const connectionId = "synthetic-cal";
const accountKey = "synthetic-account";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../providers/cal/fixtures/${name}.json`, import.meta.url),
    "utf8",
  );
}

async function capture(
  db: Database,
  name: string,
  day = 1,
  runId = `${name}-${day}`,
  responseText = fixture(name),
  endpoint = "/synthetic-financial-response",
) {
  return await db.ingestRun(
    {
      debugArchiveDays: 2,
      runId,
      connectionId,
      responses: [
        {
          accountKey,
          endpoint,
          capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00Z`,
          responseText,
        },
      ],
    },
    calAdapter,
  );
}

async function transaction(
  db: Database,
  nativeId: string,
  cardKey = "SYNTHETIC-CARD-A",
) {
  const cardIds = (
    await db.orm.select().from(cards).where(eq(cards.providerKey, cardKey))
  ).map((card) => card.id);
  const row = (await db.listTransactions()).find(
    (row) =>
      row.cardId !== null &&
      cardIds.includes(row.cardId) &&
      row.installmentNumber === null &&
      row.sourceKey.includes(`"${nativeId}"`),
  );
  if (!row) {
    throw new Error(`Missing synthetic transaction ${nativeId}`);
  }
  return row;
}

describe("local SQLite service integration", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  it("retains CAL merchant/payment enrichment after explicit nulls and replaces it with later source values", async () => {
    const baseline = JSON.parse(fixture("recent-01"));
    const row = baseline.result.transactions.find(
      (entry: { trnIntId: string }) =>
        entry.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    Object.assign(row, {
      merchantAddress: "Initial synthetic address",
      merchantPhoneNo: "Initial synthetic phone",
      walletProviderDesc: "Apple Pay",
      walletProviderCode: 3,
      transCardPresentInd: false,
    });
    baseline.result.transactions = [row];
    baseline.result.clearanceRequests = [];
    await capture(db, "recent-01", 1, "cal-enriched", JSON.stringify(baseline));
    const initial = await transaction(db, "SYNTHETIC-TXN-REGULAR");
    await db.editAnnotation({
      transactionId: initial.id,
      expectedVersion: 0,
      notes: "Retain user note",
    });
    Object.assign(row, {
      merchantAddress: null,
      merchantPhoneNo: null,
      walletProviderDesc: null,
      transCardPresentInd: null,
      amountForDisplay: 0,
      trnAmt: 0,
    });
    await capture(
      db,
      "recent-01",
      2,
      "cal-null-enrichment",
      JSON.stringify(baseline),
    );
    const retained = await transaction(db, "SYNTHETIC-TXN-REGULAR");
    expect(retained.details.merchant).toEqual(initial.details.merchant);
    expect(initial).toMatchObject({ cardPresent: false, wallet: "apple_pay" });
    expect(retained).toMatchObject({ cardPresent: false, wallet: "apple_pay" });
    expect(retained.amountMinor).toBe(0);
    expect(retained.annotation?.data.notes).toBe("Retain user note");
    Object.assign(row, {
      merchantAddress: "New synthetic address",
      merchantPhoneNo: "New synthetic phone",
      walletProviderDesc: "Apple Pay",
      walletProviderCode: 3,
      transCardPresentInd: true,
    });
    await capture(
      db,
      "recent-01",
      3,
      "cal-new-enrichment",
      JSON.stringify(baseline),
    );
    const changed = await transaction(db, "SYNTHETIC-TXN-REGULAR");
    expect(changed.details).toMatchObject({
      merchant: {
        address: "New synthetic address",
        phone: "New synthetic phone",
      },
    });
    expect(changed).toMatchObject({ wallet: "apple_pay", cardPresent: true });
    expect(changed.annotation?.data.notes).toBe("Retain user note");
    expect(changed.details.sourceRefs.map((ref) => ref.runId)).toEqual([
      "cal-new-enrichment",
    ]);
  });

  it("keeps ordinary distinct native CAL IDs separate across noncomparable observations", async () => {
    const baseline = JSON.parse(fixture("recent-01"));
    const regular = baseline.result.transactions.find(
      (entry: { trnIntId: string }) =>
        entry.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    const adapter = {
      ...calAdapter,
      extract: (...args: Parameters<typeof calAdapter.extract>) => {
        const result = calAdapter.extract(...args);
        return {
          ...result,
          partitions: result.partitions.map((partition) => ({
            ...partition,
            comparable: false,
          })),
        };
      },
    };
    for (const [index, trnIntId] of [
      "SYNTHETIC-TXN-REGULAR",
      "SYNTHETIC-TXN-SEPARATE",
    ].entries()) {
      expect(
        await db.ingestRun(
          {
            debugArchiveDays: 2,
            connectionId,
            runId: `distinct-cal-${index}`,
            responses: [
              {
                accountKey,
                endpoint: "/synthetic-financial-response",
                capturedAt: `2040-08-0${index + 1}T00:00:00Z`,
                responseText: JSON.stringify({
                  statusCode: 1,
                  result: {
                    transactions: [{ ...regular, trnIntId }],
                    clearanceRequests: [],
                  },
                }),
              },
            ],
          },
          adapter,
        ),
      ).toMatchObject({ created: 1 });
    }
    const rows = await db.listTransactions();
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.identityStrength === "native" && row.amountMinor === -8640,
      ),
    ).toBe(true);
    expect(new Set(rows.map((row) => row.sourceKey)).size).toBe(2);
  });

  it("archives exact source text, imports a baseline, and keeps replay and unchanged captures quiet", async () => {
    const first = await capture(db, "recent-01");
    expect(first).toMatchObject({
      replayed: false,
      status: "completed",
      updated: 0,
    });
    // 19 purchases and pending rows, plus the installment row's billed line.
    expect(first.created).toBe(21);
    expect((await db.listEvents()).map((change) => change.type)).toEqual([
      ...Array<string>(21).fill("transaction.imported"),
      "sync.baseline",
    ]);
    const archived = (await db.orm.select().from(syncRunBodies).get())!;
    expect(archived.snapshot.responses[0]?.responseText).toBe(
      fixture("recent-01"),
    );
    const ids = (await db.listTransactions()).map((row) => row.id);
    expect(await capture(db, "recent-01")).toMatchObject({
      replayed: true,
      created: 0,
      updated: 0,
    });
    expect(await capture(db, "recent-01", 2)).toMatchObject({
      replayed: false,
      created: 0,
      updated: 0,
      unlisted: 0,
    });
    expect((await db.listTransactions()).map((row) => row.id).sort()).toEqual(
      ids.sort(),
    );
    expect((await db.listEvents()).map((change) => change.type)).toEqual([
      ...Array<string>(21).fill("transaction.imported"),
      "sync.baseline",
    ]);
    await expect(
      capture(db, "recent-01", 1, "recent-01-1", fixture("recent-02")),
    ).rejects.toThrow(/different evidence/);
  });

  it("retains note/category/metadata through corrections and reports financial staleness", async () => {
    await capture(db, "recent-01");
    const before = await transaction(db, "SYNTHETIC-TXN-CORRECTED");
    const annotation = await db.editAnnotation({
      transactionId: before.id,
      expectedVersion: 0,
      expectedTransactionVersion: before.version,
      notes: "Synthetic user note",
      category: "Example category",
      metadata: { businessUse: "uncertain" },
      review: { status: "approved" },
    });
    expect((await capture(db, "recent-02", 2)).updated).toBeGreaterThan(0);
    const after = (await db.getTransaction(before.id))!;
    expect(after).toMatchObject({
      amountMinor: -7560,
      version: 2,
      reviewStale: true,
      reviewRequired: true,
    });
    expect(after.annotation).toEqual(annotation);
    await expect(
      db.editAnnotation({ transactionId: before.id, expectedVersion: 0 }),
    ).rejects.toThrow(ConflictError);
    const noteOnly = await db.editAnnotation({
      transactionId: before.id,
      expectedVersion: 1,
      notes: "Follow up",
    });
    expect(noteOnly.data).toEqual({
      ...annotation.data,
      notes: "Follow up",
    });
    expect((await db.getTransaction(before.id))?.reviewStale).toBe(true);
    await expect(
      db.editAnnotation({
        transactionId: before.id,
        expectedVersion: 2,
        expectedTransactionVersion: 1,
        review: { status: "approved" },
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("versions flag/history changes while keeping installment component dates off purchases", async () => {
    await capture(db, "recent-01");
    const regular = await transaction(db, "SYNTHETIC-TXN-REGULAR");
    const history = await transaction(db, "SYNTHETIC-TXN-HISTORY");
    await db.editAnnotation({
      transactionId: regular.id,
      expectedVersion: 0,
      expectedTransactionVersion: 1,
      review: { status: "approved" },
    });
    expect(retainedEvidence(history.details, "paymentHistory")).toHaveLength(2);
    await capture(db, "recent-02", 2);
    expect(await db.getTransaction(regular.id)).toMatchObject({
      version: 2,
      reviewStale: false,
    });
    expect(await db.getTransaction(history.id)).toMatchObject({
      version: 2,
      billingDate: null,
    });
    expect(
      retainedEvidence(
        (await db.getTransaction(history.id))!.details,
        "paymentHistory",
      ),
    ).toHaveLength(3);
    expect(
      (await db.listEvents()).filter(
        (change) => change.transactionId === history.id,
      ),
    ).toMatchObject([
      {
        type: "transaction.imported",
      },
      {
        type: "transaction.updated",
        after: { providerEvidence: expect.any(Array) },
      },
    ]);
  });

  it("preserves distinct purchases and requires review for pending/posting similarity", async () => {
    await capture(db, "recent-01");
    const duplicateA = await transaction(db, "SYNTHETIC-TXN-DUPLICATE-A");
    const duplicateB = await transaction(db, "SYNTHETIC-TXN-DUPLICATE-B");
    expect(duplicateA.id).not.toBe(duplicateB.id);
    expect(duplicateA.amountMinor).toBe(duplicateB.amountMinor);
    const pending = await transaction(db, "SYNTHETIC-AUTH-PENDING-POSTED");
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Authorization note",
    });
    const weakBefore = (await db.listTransactions({ status: "pending" })).find(
      (row) => row.identityStrength === "weak",
    )!;
    await capture(db, "recent-02", 2);
    const posted = await transaction(db, "SYNTHETIC-TXN-PENDING-POSTED");
    expect(posted.id).not.toBe(pending.id);
    expect(posted.annotation).toBeNull();
    expect(posted.reviewRequired).toBe(true);
    expect(await db.getTransaction(pending.id)).toMatchObject({
      presence: "not_returned",
      supersededById: null,
      annotation: { data: { notes: "Authorization note" } },
    });
    expect(
      (await db.listTransactions({ status: "pending", presence: "seen" })).map(
        (row) => row.id,
      ),
    ).toContain(weakBefore.id);
  });

  it("retains spending and annotation while unlisted, then restores the same native ID", async () => {
    const recent = (name: string) =>
      fixture(name).replaceAll("2040-05-20", "2040-07-01");
    await capture(db, "recent-01", 1, "recent-01-1", recent("recent-01"));
    const vanished = await transaction(db, "SYNTHETIC-TXN-VANISH");
    await db.editAnnotation({
      transactionId: vanished.id,
      expectedVersion: 0,
      notes: "Keep this note",
    });
    await capture(db, "recent-02", 2, "recent-02-2", recent("recent-02"));
    expect(await db.getTransaction(vanished.id)).toMatchObject({
      presence: "not_returned",
      version: 2,
    });
    const totalsBeforeReturn = await db.getTotals();
    await capture(db, "recent-03", 3, "recent-03-3", recent("recent-03"));
    expect(await db.getTransaction(vanished.id)).toMatchObject({
      presence: "seen",
      version: 3,
      annotation: { data: { notes: "Keep this note" } },
    });
    expect(await db.getTotals()).toEqual(totalsBeforeReturn);
    expect(
      (await db.listEvents())
        .filter((change) => change.transactionId === vanished.id)
        .map((change) => change.type),
    ).toEqual([
      "transaction.imported",
      "annotation.updated",
      "transaction.unlisted",
      "transaction.restored",
    ]);
  });

  it("retains all prior pending listing state when its partition is malformed", async () => {
    await capture(db, "recent-01");
    const pendingIds = (await db.listTransactions({ status: "pending" })).map(
      (row) => row.id,
    );
    const partial = await capture(db, "malformed-pending", 2);
    expect(partial.status).toBe("partial");
    expect(
      (await db.listTransactions({ status: "pending", presence: "seen" }))
        .map((row) => row.id)
        .sort(),
    ).toEqual(pendingIds.sort());
    const archived = (await db.orm
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.id, partial.runId))
      .get())!;
    const body = (await db.orm
      .select()
      .from(syncRunBodies)
      .where(eq(syncRunBodies.runId, partial.runId))
      .get())!;
    expect(body.snapshot.responses[0]?.responseText).toBe(
      fixture("malformed-pending"),
    );
    expect(
      archived.coverage.find((partition) => partition.status === "pending")
        ?.success,
    ).toBe(false);
  });

  it("uses a baseline summary for the first import after an entirely failed extraction", async () => {
    expect(
      (await capture(db, "recent-01", 1, "failed-json", "{not-json")).status,
    ).toBe("failed");
    expect(await db.listTransactions()).toEqual([]);
    await capture(db, "recent-01", 2);
    expect((await db.listEvents()).map((change) => change.type)).toEqual([
      "sync.failed",
      ...Array<string>(21).fill("transaction.imported"),
      "sync.baseline",
      "sync.recovered",
    ]);
  });

  it("does not restore or change current state from an older capture", async () => {
    await capture(db, "recent-01", 1);
    await capture(db, "recent-02", 3);
    const current = await db.listTransactions();
    const changesBefore = await db.listEvents();
    await capture(db, "recent-01", 2, "older-capture");
    expect(await db.listTransactions()).toEqual(current);
    expect(await db.listEvents()).toEqual(changesBefore);
  });

  it("rolls back financial writes while retaining the archive and allows retry", async () => {
    await db.client.executeMultiple(
      "CREATE TRIGGER synthetic_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
    );
    await expect(capture(db, "recent-01")).rejects.toMatchObject({
      cause: { message: expect.stringContaining("synthetic failure") },
    });
    expect(await db.listTransactions()).toEqual([]);
    expect(await db.listEvents()).toEqual([]);
    expect(await db.orm.select().from(syncRuns).get()).toMatchObject({
      appliedAt: null,
    });
    expect(await db.orm.select().from(syncRunBodies).get()).toMatchObject({
      snapshot: { responses: [{ responseText: fixture("recent-01") }] },
    });
    await db.client.executeMultiple("DROP TRIGGER synthetic_failure");
    expect(await db.applyRun("recent-01-1", calAdapter)).toMatchObject({
      created: 21,
      status: "completed",
    });
  });

  it("undoes note edits through versioned history and paginates changes without gaps", async () => {
    await capture(db, "recent-01");
    const row = await transaction(db, "SYNTHETIC-TXN-REGULAR");
    await db.editAnnotation({
      transactionId: row.id,
      expectedVersion: 0,
      notes: "First note",
    });
    await db.editAnnotation({
      transactionId: row.id,
      expectedVersion: 1,
      notes: "Second note",
    });
    const edit = (await db.listEvents()).at(-1)!;
    expect(
      await db.undoAnnotation({ eventId: edit.id, expectedVersion: 2 }),
    ).toMatchObject({ version: 3, data: { notes: "First note" } });
    const received = [];
    let cursor = 0;
    for (;;) {
      const page = await db.listEvents({ after: cursor, limit: 2 });
      if (page.length === 0) {
        break;
      }
      received.push(...page);
      cursor = page.at(-1)!.id;
    }
    expect(received).toEqual(await db.listEvents());
  });

  it("backs up a live database and restores snapshots, financial data, annotations, and changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "financial-service-test-"));
    let restored: Database | undefined;
    try {
      await capture(db, "recent-01");
      const row = await transaction(db, "SYNTHETIC-TXN-CORRECTED");
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        notes: "Back up this note",
      });
      await capture(db, "recent-02", 2);
      await db.backup(join(directory, "backup.sqlite"));
      restored = await openDatabase(join(directory, "backup.sqlite"));
      expect(await restored.listTransactions()).toEqual(
        await db.listTransactions(),
      );
      expect(await restored.listEvents()).toEqual(await db.listEvents());
      expect(await restored.getTotals()).toEqual(await db.getTotals());
      expect(await restored.orm.select().from(syncRuns).all()).toEqual(
        await db.orm.select().from(syncRuns).all(),
      );
      expect(
        (await restored.applyRun("recent-02-2", calAdapter)).replayed,
      ).toBe(true);
    } finally {
      await restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores generic bank income, transfer and direct debit in the common table without card or merchant facts", async () => {
    await db.ensureConnection({
      id: "synthetic-bank",
      provider: "synthetic-bank",
    });
    await db.orm
      .insert(syncRuns)
      .values({
        id: "bank-run",
        connectionId: "synthetic-bank",
        startedAt: "2040-08-01T00:00:00Z",
        status: "completed",
        collectorVersion: "synthetic",
        parserVersion: "synthetic",
        snapshot: { schemaVersion: 1, responses: [] },
        coverage: [],
        warnings: [],
      })
      .run();
    const bank = JSON.parse(
      readFileSync(
        new URL("../fixtures/generic/bank-transactions.json", import.meta.url),
        "utf8",
      ),
    );
    for (const source of bank.transactions) {
      const { id, connection_id, presence, version, details_json, ...fields } =
        source;
      const input = transactionInputSchema.parse({
        ...Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key.replace(/_([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            ),
            value,
          ]),
        ),
        identityStrength: "native",
        details: details_json,
      });
      await insertTransaction(db.orm, {
        ...input,
        ...parsedLedgerFacts(input),
        ...storedPaymentContext(input, undefined),
        cardId: null,
        supersededById: null,
        purchaseId: null,
        id,
        connectionId: "synthetic-bank",
        presence,
        version,
        firstSeenAt: "2040-08-01T00:00:00Z",
        lastSeenAt: "2040-08-01T00:00:00Z",
        lastSeenRunId: "bank-run",
      });
    }
    const rows = await db.listTransactions({ connectionId: "synthetic-bank" });
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) =>
          row.cardId === null &&
          row.merchantName === null &&
          row.amountBasis === "booked_entry",
      ),
    ).toBe(true);
    expect(
      await db.getTotals({ connectionId: "synthetic-bank" }),
    ).toMatchObject({
      totals: [
        { currency: "USD", amountBasis: "booked_entry", amountMinor: -4200 },
      ],
      includedCount: 1,
      excluded: { transferOrIncome: 2 },
    });
    expect(
      (
        await db.editAnnotation({
          transactionId: rows[0]!.id,
          expectedVersion: 0,
          notes: "Bank note",
        })
      ).data.notes,
    ).toBe("Bank note");
  });

  it("keeps an unchanged ambiguous native collision set stable on repeat", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    envelope.result.transactions = [
      row,
      { ...row, amountForDisplay: 90, trnAmt: 90 },
    ];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      1,
      "collision-baseline",
      JSON.stringify(envelope),
    );
    const rows = await db.listTransactions();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.identityStrength === "ambiguous")).toBe(
      true,
    );
    expect(
      await capture(
        db,
        "recent-01",
        2,
        "collision-repeat",
        JSON.stringify(envelope),
      ),
    ).toMatchObject({ created: 0, updated: 0 });
    expect((await db.listTransactions()).map((row) => row.id).sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );
    expect(await db.getTotals()).toMatchObject({
      includedCount: 0,
      excluded: { unresolved: 2 },
    });
  });

  it("does not move annotations by ordinal when financially distinct colliding rows reorder", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    envelope.result.transactions = [
      row,
      { ...row, amountForDisplay: 90, trnAmt: 90 },
    ];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      1,
      "collision-baseline",
      JSON.stringify(envelope),
    );
    const annotated = (await db.listTransactions()).find(
      (row) => row.amountMinor === -8640,
    )!;
    await db.editAnnotation({
      transactionId: annotated.id,
      expectedVersion: 0,
      notes: "For the 86.40 purchase",
    });
    envelope.result.transactions.reverse();
    await capture(
      db,
      "recent-01",
      2,
      "collision-reordered",
      JSON.stringify(envelope),
    );
    expect(await db.getTransaction(annotated.id)).toMatchObject({
      amountMinor: -8640,
      version: 1,
      annotation: { data: { notes: "For the 86.40 purchase" } },
    });
  });

  it("excludes the former native record when its ID becomes a colliding source set", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    envelope.result.transactions = [row];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      1,
      "single-baseline",
      JSON.stringify(envelope),
    );
    expect((await db.getTotals()).includedCount).toBe(1);
    envelope.result.transactions.push({
      ...row,
      amountForDisplay: 90,
      trnAmt: 90,
    });
    await capture(
      db,
      "recent-01",
      2,
      "new-collision",
      JSON.stringify(envelope),
    );
    expect((await db.getTotals()).includedCount).toBe(0);
    expect((await db.getTotals()).totals).toEqual([]);
  });

  it("keeps identity uncertainty when a native collision shrinks and then repeats", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    row.trnPurchaseDate = "2040-07-01T14:30:00";
    envelope.result.transactions = [
      row,
      { ...row, amountForDisplay: 90, trnAmt: 90 },
    ];
    envelope.result.clearanceRequests = [];
    await capture(db, "recent-01", 1, "collision", JSON.stringify(envelope));
    envelope.result.transactions = [row];
    await capture(db, "recent-01", 2, "singleton", JSON.stringify(envelope));
    expect((await db.getTotals()).includedCount).toBe(0);
    const active = await db.listTransactions({ presence: "seen" });
    expect(active).toHaveLength(1);
    expect(active[0]?.identityStrength).toBe("ambiguous");
    expect(
      (
        await capture(
          db,
          "recent-01",
          3,
          "singleton-repeat",
          JSON.stringify(envelope),
        )
      ).created,
    ).toBe(0);
    expect((await db.getTransaction(active[0]!.id))?.identityStrength).toBe(
      "ambiguous",
    );
    expect((await db.getTotals()).includedCount).toBe(0);
  });

  it("keeps weak multiplicity changes separate and makes subsequent singleton repeats idempotent", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.clearanceRequests.find(
      (row: { transactionID?: string }) => row.transactionID === undefined,
    );
    envelope.result.transactions = [];
    envelope.result.clearanceRequests = [row];
    await capture(db, "recent-01", 1, "weak-single", JSON.stringify(envelope));
    const initial = (await db.listTransactions())[0]!;
    await db.editAnnotation({
      transactionId: initial.id,
      expectedVersion: 0,
      notes: "Original uncertain authorization",
    });
    envelope.result.clearanceRequests = [row, { ...row }];
    expect(
      (
        await capture(
          db,
          "recent-01",
          2,
          "weak-multiple",
          JSON.stringify(envelope),
        )
      ).created,
    ).toBe(2);
    const multiples = await db.listTransactions({ presence: "seen" });
    expect(multiples).toHaveLength(2);
    expect(multiples.every((row) => row.annotation === null)).toBe(true);
    envelope.result.clearanceRequests = [row];
    expect(
      (
        await capture(
          db,
          "recent-01",
          3,
          "weak-single-again",
          JSON.stringify(envelope),
        )
      ).created,
    ).toBe(1);
    const singleton = (await db.listTransactions({ presence: "seen" }))[0]!;
    expect(singleton.id).not.toBe(initial.id);
    expect(singleton.annotation).toBeNull();
    expect(singleton.identityStrength).toBe("ambiguous");
    expect(
      (
        await capture(
          db,
          "recent-01",
          4,
          "weak-repeat",
          JSON.stringify(envelope),
        )
      ).created,
    ).toBe(0);
    expect(await db.listTransactions()).toHaveLength(4);
    expect((await db.getTransaction(singleton.id))?.identityStrength).toBe(
      "ambiguous",
    );
    expect((await db.getTransaction(initial.id))?.annotation?.data.notes).toBe(
      "Original uncertain authorization",
    );
  });

  it.each([1, 2])(
    "does not mutate existing %i-row native identity groups from a later-imported legacy archive",
    async (count) => {
      const envelope = JSON.parse(fixture("recent-01"));
      const row = envelope.result.transactions.find(
        (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
      );
      envelope.result.transactions =
        count === 1
          ? [row]
          : [row, { ...row, amountForDisplay: 90, trnAmt: 90 }];
      envelope.result.clearanceRequests = [];
      await capture(db, "recent-01", 1, "current", JSON.stringify(envelope));
      const current = await db.listTransactions();
      const beforeChanges = await db.listEvents();
      const historicalText = JSON.stringify({
        ...envelope,
        result: {
          transArr:
            count === 1
              ? [row, { ...row, amountForDisplay: 90, trnAmt: 90 }]
              : [row],
        },
      });
      await capture(db, "recent-01", 2, "historical", historicalText);
      expect(await db.listTransactions()).toEqual(current);
      expect(await db.listEvents()).toEqual(beforeChanges);
      expect(
        (
          await db.orm
            .select()
            .from(syncRunBodies)
            .where(eq(syncRunBodies.runId, "historical"))
            .get()
        )?.snapshot.responses[0]?.responseText,
      ).toBe(historicalText);
    },
  );

  it("does not flag a current pending authorization from an unrelated historical purchase candidate", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const posted = envelope.result.transactions[0];
    const pending = envelope.result.clearanceRequests.find(
      (row: { transactionID?: string }) =>
        row.transactionID === "SYNTHETIC-AUTH-PENDING-POSTED",
    );
    envelope.result.transactions = [];
    envelope.result.clearanceRequests = [pending];
    await capture(db, "recent-01", 1, "pending-only", JSON.stringify(envelope));
    const current = (await db.listTransactions())[0]!;
    const historicalText = JSON.stringify({
      ...envelope,
      result: {
        transArr: [
          {
            ...posted,
            trnIntId: "SYNTHETIC-HISTORICAL-CANDIDATE",
            amountForDisplay: pending.trnAmt,
            trnAmt: pending.trnAmt,
            merchantName: pending.merchantName,
            trnPurchaseDate: pending.trnPurchaseDate,
          },
        ],
      },
    });
    await capture(db, "recent-01", 2, "legacy-candidate", historicalText);
    expect(await db.getTransaction(current.id)).toEqual(current);
    expect(
      (await db.listTransactions()).every(
        (row) => !row.details.issues.includes("possible_pending_posted_match"),
      ),
    ).toBe(true);
  });

  it("rejects undo of an older annotation edit even with the current annotation version", async () => {
    await capture(db, "recent-01");
    const row = await transaction(db, "SYNTHETIC-TXN-REGULAR");
    await db.editAnnotation({
      transactionId: row.id,
      expectedVersion: 0,
      notes: "First note",
    });
    const oldChange = (await db.listEvents()).at(-1)!;
    await db.editAnnotation({
      transactionId: row.id,
      expectedVersion: 1,
      notes: "First note",
      category: "Later category",
    });
    const current = await db.getTransaction(row.id);
    const history = await db.listEvents();
    await expect(
      db.undoAnnotation({ eventId: oldChange.id, expectedVersion: 2 }),
    ).rejects.toThrow(ConflictError);
    expect(await db.getTransaction(row.id)).toEqual(current);
    expect(await db.listEvents()).toEqual(history);
  });

  it.each(["weak", "ambiguous"])(
    "defers changing a %s identity set while its partition contains a malformed row",
    async (strength) => {
      const envelope = JSON.parse(fixture("recent-01"));
      const pending = envelope.result.clearanceRequests.find(
        (row: { transactionID?: string }) => row.transactionID === undefined,
      );
      const posted = envelope.result.transactions.find(
        (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
      );
      envelope.result.transactions =
        strength === "weak"
          ? []
          : [posted, { ...posted, amountForDisplay: 90, trnAmt: 90 }];
      envelope.result.clearanceRequests = strength === "weak" ? [pending] : [];
      await capture(
        db,
        "recent-01",
        1,
        "initial-set",
        JSON.stringify(envelope),
      );
      const prior = await db.listTransactions();
      await db.editAnnotation({
        transactionId: prior[0]!.id,
        expectedVersion: 0,
        notes: "Preserve identity review",
      });
      if (strength === "weak") {
        envelope.result.clearanceRequests = [pending, { ...pending }, null];
      } else {
        envelope.result.transactions = [posted, null];
      }
      const partialText = JSON.stringify(envelope);
      for (const day of [2, 3]) {
        expect(
          await capture(
            db,
            "recent-01",
            day,
            `partial-set-${day}`,
            partialText,
          ),
        ).toMatchObject({ status: "partial", created: 0 });
        const retained = await db.listTransactions();
        expect(retained).toHaveLength(prior.length);
        expect(retained.map((row) => row.id).sort()).toEqual(
          prior.map((row) => row.id).sort(),
        );
        expect(
          retained.every(
            (row) => row.presence === "seen" && row.reviewRequired,
          ),
        ).toBe(true);
        expect(
          (await db.getTransaction(prior[0]!.id))?.annotation?.data.notes,
        ).toBe("Preserve identity review");
      }
    },
  );

  it("keeps earlier billed lines, payment history, and references when later captures omit them", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const installment = envelope.result.transactions.find(
      (row: { trnIntId: string }) =>
        row.trnIntId === "SYNTHETIC-TXN-INSTALLMENTS",
    );
    const history = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-HISTORY",
    );
    const laterInstallment = {
      ...installment,
      curPaymentNum: 4,
      debCrdDate: "2040-07-10T00:00:00",
    };
    envelope.result.transactions = [installment, laterInstallment, history];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      1,
      "observations-first",
      JSON.stringify(envelope),
    );
    const originalInstallment = await transaction(
      db,
      "SYNTHETIC-TXN-INSTALLMENTS",
    );
    const originalHistory = await transaction(db, "SYNTHETIC-TXN-HISTORY");
    const linesOf = async (purchaseId: string) =>
      (await db.listTransactions())
        .filter((row) => row.purchaseId === purchaseId)
        .map((row) => [row.installmentNumber, row.presence, row.version])
        .sort();
    expect(await linesOf(originalInstallment.id)).toEqual([
      [3, "seen", 1],
      [4, "seen", 1],
    ]);
    expect(
      retainedEvidence(originalHistory.details, "paymentHistory"),
    ).toHaveLength(2);
    envelope.result.transactions = [
      laterInstallment,
      { ...history, paymentsMade: history.paymentsMade.slice(-1) },
    ];
    await capture(
      db,
      "recent-01",
      2,
      "observations-later",
      JSON.stringify(envelope),
    );
    const retainedInstallment = (await db.getTransaction(
      originalInstallment.id,
    ))!;
    const retainedHistory = (await db.getTransaction(originalHistory.id))!;
    // The omitted line is non-comparable for absence: it stays seen.
    expect(await linesOf(originalInstallment.id)).toEqual([
      [3, "seen", 1],
      [4, "seen", 1],
    ]);
    expect(retainedEvidence(retainedHistory.details, "paymentHistory")).toEqual(
      expect.arrayContaining(
        retainedEvidence(originalHistory.details, "paymentHistory"),
      ),
    );
    expect(
      retainedEvidence(retainedHistory.details, "paymentHistory"),
    ).toHaveLength(2);
    for (const current of [retainedInstallment, retainedHistory]) {
      expect(
        new Set(current.details.sourceRefs.map((reference) => reference.runId)),
      ).toEqual(new Set(["observations-later"]));
    }
    expect(retainedInstallment).toMatchObject({
      version: 1,
      billingDate: null,
    });
    expect(retainedHistory.version).toBe(2);
  });

  it("reports partial when valid rows apply from failed partitions and keeps the next import out of baseline mode", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    envelope.result.transactions = [row, null];
    envelope.result.clearanceRequests = null;
    expect(
      await capture(
        db,
        "recent-01",
        1,
        "partial-rows",
        JSON.stringify(envelope),
      ),
    ).toMatchObject({ status: "partial", created: 1 });
    expect((await db.listEvents()).map((change) => change.type)).toEqual([
      "transaction.imported",
      "sync.baseline",
      "sync.partial",
    ]);
    envelope.result.transactions = [
      row,
      { ...row, trnIntId: "SYNTHETIC-NEW-AFTER-PARTIAL" },
    ];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      2,
      "complete-rows",
      JSON.stringify(envelope),
    );
    expect((await db.listEvents()).map((change) => change.type)).toEqual([
      "transaction.imported",
      "sync.baseline",
      "sync.partial",
      "transaction.created",
      "sync.recovered",
    ]);
  });

  it("compares freshness and absence within the response endpoint", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    envelope.result.transactions = [row];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      1,
      "resource-a",
      JSON.stringify(envelope),
      "/resource-a",
    );
    const first = (await db.listTransactions())[0]!;
    const empty = JSON.stringify({
      ...envelope,
      result: { transactions: [], clearanceRequests: [] },
    });
    await capture(db, "recent-01", 3, "resource-b-newer", empty, "/resource-b");
    expect(await db.getTransaction(first.id)).toEqual(first);
    envelope.result.transactions = [
      { ...row, amountForDisplay: 90, trnAmt: 90 },
    ];
    expect(
      (
        await capture(
          db,
          "recent-01",
          2,
          "resource-a-middle",
          JSON.stringify(envelope),
          "/resource-a",
        )
      ).updated,
    ).toBe(1);
    expect(await db.getTransaction(first.id)).toMatchObject({
      amountMinor: -9000,
      presence: "seen",
      version: 2,
    });
  });

  it("retains previously unseen purchases from an older capture without listing them as current", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    envelope.result.transactions = [row];
    envelope.result.clearanceRequests = [];
    await capture(db, "recent-01", 3, "newer-first", JSON.stringify(envelope));
    const current = (await db.listTransactions())[0]!;
    envelope.result.transactions = [
      row,
      { ...row, trnIntId: "SYNTHETIC-OLDER-UNSEEN" },
    ];
    expect(
      (
        await capture(
          db,
          "recent-01",
          1,
          "older-second",
          JSON.stringify(envelope),
        )
      ).created,
    ).toBe(1);
    expect(await db.getTransaction(current.id)).toEqual(current);
    expect(await transaction(db, "SYNTHETIC-OLDER-UNSEEN")).toMatchObject({
      presence: "not_returned",
      amountMinor: -8640,
      lastSeenRunId: "older-second",
    });
    expect(await db.listTransactions({ presence: "seen" })).toHaveLength(1);
  });

  it("matches distinct full source timestamps within an ambiguous set despite equal financial facts", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    const date = row.trnPurchaseDate.slice(0, 10);
    envelope.result.transactions = [
      { ...row, trnPurchaseDate: `${date}T09:00:00` },
      { ...row, trnPurchaseDate: `${date}T10:00:00` },
    ];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      1,
      "different-times",
      JSON.stringify(envelope),
    );
    const morning = (await db.listTransactions()).find((row) =>
      JSON.stringify(row.details.provider.cal?.rows).includes("T09:00:00"),
    )!;
    await db.editAnnotation({
      transactionId: morning.id,
      expectedVersion: 0,
      notes: "Nine o'clock purchase",
    });
    envelope.result.transactions.reverse();
    expect(
      await capture(
        db,
        "recent-01",
        2,
        "times-reordered",
        JSON.stringify(envelope),
      ),
    ).toMatchObject({ created: 0, updated: 0 });
    const retained = (await db.getTransaction(morning.id))!;
    expect(retained.annotation?.data.notes).toBe("Nine o'clock purchase");
    expect(JSON.stringify(retained.details.provider.cal?.rows)).toContain(
      "T09:00:00",
    );
    expect(JSON.stringify(retained.details.provider.cal?.rows)).not.toContain(
      "T10:00:00",
    );
  });

  it("records an issuer type label correction without staling its unchanged approval basis", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
    );
    envelope.result.transactions = [row];
    envelope.result.clearanceRequests = [];
    await capture(db, "recent-01", 1, "label-first", JSON.stringify(envelope));
    const first = (await db.listTransactions())[0]!;
    const annotation = await db.editAnnotation({
      transactionId: first.id,
      expectedVersion: 0,
      expectedTransactionVersion: 1,
      review: { status: "approved" },
    });
    row.trnType = "Synthetic updated issuer label";
    expect(
      await capture(
        db,
        "recent-01",
        2,
        "label-later",
        JSON.stringify(envelope),
      ),
    ).toMatchObject({ updated: 1 });
    expect(await db.getTransaction(first.id)).toMatchObject({
      description: "Synthetic updated issuer label",
      version: first.version + 1,
      annotation,
      reviewStale: false,
      reviewStatus: "approved",
    });
    const changes = await db.listEvents();
    expect(changes.map((change) => change.type)).toEqual([
      "transaction.imported",
      "sync.baseline",
      "annotation.updated",
      "transaction.updated",
    ]);
    expect(changes.at(-1)).toMatchObject({
      transactionId: first.id,
      runId: "label-later",
      before: { description: first.description },
      after: { description: "Synthetic updated issuer label" },
    });
  });

  it("retains maximum observed multiplicity for identical payment-history entries", async () => {
    const envelope = JSON.parse(fixture("recent-01"));
    const row = envelope.result.transactions.find(
      (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-HISTORY",
    );
    const payment = row.paymentsMade[0];
    row.paymentsMade = [payment, { ...payment }];
    envelope.result.transactions = [row];
    envelope.result.clearanceRequests = [];
    await capture(
      db,
      "recent-01",
      1,
      "duplicate-history-first",
      JSON.stringify(envelope),
    );
    const first = (await db.listTransactions())[0]!;
    expect(retainedEvidence(first.details, "paymentHistory")).toHaveLength(2);
    row.paymentsMade = [payment];
    expect(
      (
        await capture(
          db,
          "recent-01",
          2,
          "duplicate-history-single",
          JSON.stringify(envelope),
        )
      ).updated,
    ).toBe(1);
    const retained = (await db.getTransaction(first.id))!;
    expect(retainedEvidence(retained.details, "paymentHistory")).toHaveLength(
      2,
    );
    expect(
      new Set(retained.details.sourceRefs.map((reference) => reference.runId)),
    ).toEqual(new Set(["duplicate-history-single"]));
    row.paymentsMade = [{ ...payment }, payment];
    expect(
      (
        await capture(
          db,
          "recent-01",
          3,
          "duplicate-history-repeat",
          JSON.stringify(envelope),
        )
      ).updated,
    ).toBe(1);
    expect(await db.getTransaction(first.id)).toMatchObject({ version: 3 });
    expect(
      retainedEvidence(
        (await db.getTransaction(first.id))!.details,
        "paymentHistory",
      ),
    ).toHaveLength(2);
    expect((await db.listEvents()).map((change) => change.type)).toEqual([
      "transaction.imported",
      "sync.baseline",
      "transaction.updated",
      "transaction.updated",
    ]);
  });

  it("enforces exact integer amounts and uppercase currency through direct SQLite writes", async () => {
    await capture(db, "recent-01");
    const row = await transaction(db, "SYNTHETIC-TXN-REGULAR");
    await expect(
      db.client.execute({
        sql: "UPDATE transactions SET amount_minor = ? WHERE id = ?",
        args: [1.5, row.id],
      }),
    ).rejects.toThrow();
    await expect(
      db.client.execute({
        sql: "UPDATE transactions SET currency = ? WHERE id = ?",
        args: ["ils", row.id],
      }),
    ).rejects.toThrow();
    await expect(
      db.client.execute({
        sql: "UPDATE transactions SET original_amount_minor = ? WHERE id = ?",
        args: [1.5, row.id],
      }),
    ).rejects.toThrow();
    await expect(
      db.client.execute({
        sql: "UPDATE transactions SET original_currency = ? WHERE id = ?",
        args: ["ils", row.id],
      }),
    ).rejects.toThrow();
    expect(await db.getTransaction(row.id)).toEqual(row);
  });
});
