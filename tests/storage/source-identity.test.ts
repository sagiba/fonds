import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  presentWireEvent,
  presentWireTransaction,
} from "../../src/application/wire-output.js";
import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import type { TransactionView } from "../../src/domain/read-model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  backends,
  fixture,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const parent = () => row("plan", { amountMinor: -10000, installmentCount: 4 });
const line = (key = "line", overrides: Partial<TransactionInput> = {}) =>
  row(key, {
    identityStrength: "weak",
    amountMinor: -2500,
    amountBasis: "booked_entry",
    installmentNumber: 1,
    installmentCount: 4,
    purchaseKey: "plan",
    ...overrides,
  });
const shared = {
  ...emptyDetails(),
  provider: { cal: { identity: { baseKey: "synthetic-shared" } } },
};
const restated = () => ({ ...parent(), installmentCount: 1, details: shared });

function semantic(rows: TransactionView[]) {
  return rows
    .map(
      ({
        lastSeenAt: _seen,
        lastSeenRunId: _run,
        sourceEvidence: _private,
        details,
        ...facts
      }) => {
        const { sourceRefs: _references, ...retained } = details;
        const provider = structuredClone(retained.provider);
        for (const namespace of Object.values(provider)) {
          const identity = namespace.identity;
          if (
            identity &&
            typeof identity === "object" &&
            !Array.isArray(identity)
          ) {
            delete identity.currentRows;
          }
        }
        return { ...facts, details: { ...retained, provider } };
      },
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

const scenarios = [
  {
    name: "held weak duplicate ordinal",
    noteKey: "line-a",
    phases: [
      [
        parent(),
        line("line-a"),
        line("line-b", { identityStrength: "native", amountMinor: -2400 }),
      ],
    ],
    expectedRows: 3,
  },
  {
    name: "restated plan joined by a weak identity",
    noteKey: "plan",
    phases: [
      [
        { ...parent(), details: shared },
        line("line", { identityStrength: "native" }),
      ],
      [restated(), line("line", { identityStrength: "native" })],
      [
        restated(),
        row("weak", {
          identityStrength: "weak",
          amountMinor: -900,
          details: shared,
        }),
        line("line", { identityStrength: "native" }),
      ],
    ],
    expectedRows: 3,
  },
  {
    name: "weak billed line observed before its purchase",
    noteKey: "line",
    phases: [[line()], [parent(), line()]],
    expectedRows: 2,
  },
];

describe.each(backends)("%s captured source identity", (backend) => {
  let db: Harness;
  let day: number;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    day = 0;
  });
  afterEach(() => db.close());

  async function capture(body: unknown, adapter: SourceAdapter = synthetic) {
    day++;
    return db.ingestRun(
      {
        connectionId: "synthetic",
        runId: `source-${day}`,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:source-identity",
            capturedAt: `2040-07-${String(day).padStart(2, "0")}T12:00:00Z`,
            responseText: JSON.stringify(body),
          },
        ],
      },
      adapter,
    );
  }

  const rows = () =>
    db.listTransactions({
      perspective: "all",
      presence: "all",
      includeSuperseded: true,
    });

  async function quiet(body: unknown, adapter: SourceAdapter = synthetic) {
    const before = semantic(await rows());
    const events = await db.listEvents();
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await capture(body, adapter)).toMatchObject({
        created: 0,
        updated: 0,
        unlisted: 0,
      });
      expect(semantic(await rows())).toEqual(before);
      expect(await db.listEvents()).toEqual(events);
    }
  }

  it.each(scenarios)(
    "keeps $name stable over two fresh replays",
    async ({ name, phases, noteKey, expectedRows }) => {
      await capture(phases[0]);
      const noted = (await rows()).find((item) => item.sourceKey === noteKey)!;
      const note = await db.editAnnotation({
        transactionId: noted.id,
        expectedVersion: 0,
        notes: "Invented note stays with its original identity.",
      });
      for (const phase of phases.slice(1)) {
        await capture(phase);
      }
      const current = await rows();
      expect(current).toHaveLength(expectedRows);
      expect((await db.getTransaction(noted.id))!.annotation).toEqual(note);
      const plan = current.find((item) => item.sourceKey === "plan")!;
      for (const item of current.filter(
        (candidate) => candidate.installmentNumber !== null,
      )) {
        expect(item.purchaseId).toBe(plan.id);
      }
      if (name === "held weak duplicate ordinal") {
        expect(
          current
            .filter((item) => item.installmentNumber === 1)
            .map((item) => item.amountMinor),
        ).toEqual([null, null]);
      } else if (name === "restated plan joined by a weak identity") {
        expect(plan.id).toBe(noted.id);
        expect(plan.installmentCount).toBe(4);
        expect(plan.sourceIssues).toContain(
          "conflicting_installment_restatement",
        );
        expect(plan.sourceEvidence!.identity!.financialFingerprint).toContain(
          '"installmentCount":1',
        );
      } else {
        expect(current.find((item) => item.sourceKey === "line")!.id).toBe(
          noted.id,
        );
        expect(await db.getTotals()).toMatchObject({
          includedCount: 1,
          totals: [
            {
              currency: "ILS",
              amountBasis: "purchase_commitment",
              amountMinor: -10000,
            },
          ],
        });
      }
      await quiet([...phases.at(-1)!].reverse());
      expect((await db.getTransaction(noted.id))!.annotation).toEqual(note);
    },
  );

  it("retires replaced CAL ordinal generations for matching without fabricating billed-line absence", async () => {
    const document = JSON.parse(fixture("installment-plans"));
    const original = document.result.transactions.find(
      (item: { trnIntId: string; curPaymentNum: number }) =>
        item.trnIntId === "SYNTHETIC-TXN-PLAN-ROUNDING" &&
        item.curPaymentNum === 2,
    );
    const body = (transactions: unknown[]) => ({
      statusCode: 1,
      result: { transactions, clearanceRequests: [] },
    });
    await capture(body([original]), calAdapter);
    const previous = (await rows()).find(
      (item) => item.installmentNumber === 2,
    )!;
    const note = await db.editAnnotation({
      transactionId: previous.id,
      expectedVersion: 0,
      notes: "Original billed-line evidence.",
    });
    const duplicate = body([
      original,
      { ...original, amtBeforeConvAndIndex: 33.32 },
    ]);
    await capture(duplicate, calAdapter);
    expect(await rows()).toHaveLength(4);
    expect(await db.getTransaction(previous.id)).toMatchObject({
      amountMinor: -3333,
      presence: "seen",
      lastSeenAt: previous.lastSeenAt,
      sourceEvidence: { identity: { retiredFromMatching: true } },
      annotation: note,
    });
    expect(
      (await db.getTransaction(previous.id))!.sourceAbsence,
    ).toBeUndefined();
    await quiet(duplicate, calAdapter);

    const retained = (await db.getTransaction(previous.id))!;
    await db.confirmRemoval({
      transactionId: retained.id,
      expectedVersion: retained.version,
      reason: "Owner verified the earlier ambiguous generation.",
    });
    const partial: SourceAdapter = {
      ...calAdapter,
      extract(text, context) {
        const result = calAdapter.extract(text, context);
        return {
          ...result,
          partitions: result.partitions.map((part) => ({
            ...part,
            comparable: false,
          })),
        };
      },
    };
    expect(await capture(body([original]), partial)).toMatchObject({
      created: 0,
    });
    expect(await db.getTransaction(previous.id)).toMatchObject({
      presence: "removed",
      lastSeenAt: previous.lastSeenAt,
      sourceEvidence: { identity: { retiredFromMatching: true } },
      annotation: note,
    });
    expect(await rows()).toHaveLength(4);
    await capture(duplicate, calAdapter);
    await quiet(duplicate, calAdapter);
  });

  it("reports changed held source money once without changing accepted money or associations", async () => {
    const billed = line("line", { identityStrength: "native" });
    await capture([parent(), billed]);
    await capture([{ ...parent(), installmentCount: 1 }, billed]);
    const previous = (await rows()).find((item) => item.sourceKey === "plan")!;
    const note = await db.editAnnotation({
      transactionId: previous.id,
      expectedVersion: 0,
      notes: "Keep the accepted commitment.",
    });
    const cursor = await db.latestEventId();
    const changed = [
      { ...parent(), amountMinor: -12000, installmentCount: 1 },
      billed,
    ];
    expect(await capture(changed)).toMatchObject({ created: 0, updated: 1 });
    expect(await db.getTransaction(previous.id)).toMatchObject({
      amountMinor: -10000,
      installmentCount: 4,
      version: previous.version + 1,
      annotation: note,
    });
    expect(
      (await rows()).find((item) => item.sourceKey === "line")!.purchaseId,
    ).toBe(previous.id);
    const updates = (await db.listEvents({ after: cursor })).filter(
      (event) => event.type === "transaction.updated",
    );
    expect(updates).toHaveLength(1);
    expect(presentWireEvent(updates[0]!)).toMatchObject({
      changedFields: ["evidence"],
    });
    expect(JSON.stringify(presentWireEvent(updates[0]!))).not.toContain(
      "financialFingerprint",
    );
    await quiet(changed);
  });

  it("does not guess legacy comparisons from held projections and initializes unique native observations quietly", async () => {
    await capture([parent()]);
    const original = (await rows())[0]!;
    await db.raw(
      "UPDATE transaction_reconciliation SET source_evidence_json = NULL WHERE transaction_id = ?",
      [original.id],
    );
    const cursor = await db.latestEventId();
    expect(await capture([parent()])).toMatchObject({ created: 0, updated: 0 });
    expect(
      (await db.getTransaction(original.id))!.sourceEvidence?.identity,
    ).toMatchObject({ retiredFromMatching: false, runId: "source-2" });
    expect(await db.listEvents({ after: cursor })).toEqual([]);

    await capture([
      parent(),
      line("line-a"),
      line("line-b", { identityStrength: "native", amountMinor: -2400 }),
    ]);
    const held = (await rows()).find((item) => item.sourceKey === "line-a")!;
    const note = await db.editAnnotation({
      transactionId: held.id,
      expectedVersion: 0,
      notes: "Legacy held evidence.",
    });
    await db.raw(
      "UPDATE transaction_reconciliation SET source_evidence_json = NULL WHERE transaction_id = ?",
      [held.id],
    );
    const same = [
      parent(),
      line("line-a"),
      line("line-b", { identityStrength: "native", amountMinor: -2400 }),
    ];
    expect(await capture(same)).toMatchObject({ created: 1 });
    expect(await db.getTransaction(held.id)).toMatchObject({
      amountMinor: null,
      annotation: note,
      sourceEvidence: { identity: { retiredFromMatching: true } },
    });
    expect(
      (await db.getTransaction(held.id))!.sourceEvidence!.identity!
        .financialFingerprint,
    ).toBeUndefined();
    await quiet(same);
  });

  it.each(["original money", "FX fee", "FX rate"] as const)(
    "preserves uncertain identities distinguished by captured %s before projection",
    async (discriminator) => {
      const input = (key: string, value: number): TransactionInput => ({
        ...parent(),
        sourceKey: key,
        identityStrength: "ambiguous",
        ...(discriminator === "original money"
          ? { originalAmountMinor: value, originalCurrency: "USD" }
          : discriminator === "FX fee"
            ? { fxFeeMinor: value, fxFeeCurrency: "ILS" }
            : {}),
        details: {
          ...shared,
          ...(discriminator === "FX rate"
            ? {
                currencyExchange: [
                  {
                    sourceCurrency: "USD",
                    targetCurrency: "ILS",
                    unitCurrency: "USD",
                    exchangeRate: value === -100 ? "3.1" : "3.2",
                    quotationDate: "2040-07-01",
                  },
                ],
              }
            : {}),
        },
      });
      const first = input("a", -100);
      const second = input("b", -200);
      await capture([first, second]);
      const original = (await rows()).find((item) => item.sourceKey === "a")!;
      const note = await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Keep the captured financial identity.",
      });
      const before = semantic(await rows());
      const events = await db.listEvents();
      for (const replay of [
        [second, first],
        [first, second],
      ]) {
        expect(await capture(replay)).toMatchObject({ created: 0, updated: 0 });
        expect(semantic(await rows())).toEqual(before);
        expect(await db.listEvents()).toEqual(events);
        expect(await db.getTransaction(original.id)).toMatchObject({
          sourceKey: "a",
          annotation: note,
        });
      }
    },
  );

  it("ignores forged incoming engine state and keeps capture comparisons private on the wire", async () => {
    const input = {
      ...parent(),
      sourceEvidence: {
        identity: {
          financialFingerprint: "forged",
          runId: "forged",
          capturedAt: "2099-01-01T00:00:00Z",
          retiredFromMatching: true,
        },
        financial: { runId: "forged", capturedAt: "2099-01-01T00:00:00Z" },
      },
    };
    await capture([input]);
    const stored = (await rows())[0]!;
    expect(stored.sourceEvidence?.identity).toMatchObject({
      runId: "source-1",
      retiredFromMatching: false,
    });
    expect(stored.sourceEvidence?.identity?.financialFingerprint).not.toBe(
      "forged",
    );
    expect(JSON.stringify(presentWireTransaction(stored))).not.toContain(
      "sourceEvidence",
    );
    await quiet([input]);
  });
});
