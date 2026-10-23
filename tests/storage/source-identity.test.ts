import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  presentWireEvent,
  presentWireTransaction,
} from "../../src/application/wire-output.js";
import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import { evidenceObject } from "../../src/domain/provider-evidence.js";
import type { TransactionView } from "../../src/domain/read-model.js";
import type { CollectionScope } from "../../src/domain/records.js";
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

const sourceRowsAdapter: SourceAdapter = {
  ...synthetic,
  retainProviderEvidence: (value) =>
    evidenceObject(value, {
      rows: [{ witness: "scalar", amount: "scalar", currency: "scalar" }],
    }),
};

function evidencedRow(
  key: string,
  fields: Partial<TransactionInput> = {},
): TransactionInput {
  const input = row(key, { identityStrength: "ambiguous", ...fields });
  return {
    ...input,
    details: {
      ...input.details,
      provider: {
        cal: {
          identity: { baseKey: "legacy-evidenced-group" },
          rows: [{ witness: key, amount: input.amountMinor, currency: "ILS" }],
        },
      },
    },
  };
}

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

  async function capture(
    body: unknown,
    adapter: SourceAdapter = synthetic,
    scope?: CollectionScope,
  ) {
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
            ...(scope === undefined ? {} : { scope }),
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

  async function forgetComparisons(ids: string[]) {
    for (const id of ids) {
      await db.raw(
        "UPDATE transaction_reconciliation SET source_evidence_json = NULL WHERE transaction_id = ?",
        [id],
      );
    }
  }

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

    const same = [
      parent(),
      line("line-a"),
      line("line-b", { identityStrength: "native", amountMinor: -2400 }),
    ].map((input) => ({
      ...input,
      details: {
        ...input.details,
        provider: {
          cal: {
            rows: [
              {
                witness: input.sourceKey,
                amount: input.amountMinor,
                currency: input.currency,
              },
            ],
          },
        },
      },
    }));
    await capture(same, sourceRowsAdapter);
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
    expect(held.details.provider.cal!.rows).toHaveLength(1);
    expect(await capture(same, sourceRowsAdapter)).toMatchObject({
      created: 0,
      unlisted: 0,
    });
    expect(await db.getTransaction(held.id)).toMatchObject({
      amountMinor: null,
      annotation: note,
      presence: "seen",
      sourceIssues: expect.arrayContaining(["unverified_legacy_identity"]),
    });
    expect(
      (await db.getTransaction(held.id))!.sourceEvidence?.identity,
    ).toBeUndefined();
    expect(await rows()).toHaveLength(3);
    await quiet(same, sourceRowsAdapter);
  });

  it.each(["weak", "ambiguous"] as const)(
    "defers an ordinary legacy %s row without a proof instead of replacing it",
    async (identityStrength) => {
      const input = row("legacy-ordinary", {
        identityStrength,
        amountMinor: -12345,
      });
      await capture([input]);
      const original = (await rows())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Ordinary legacy owner note.",
      });
      await forgetComparisons([original.id]);
      const totals = await db.getTotals();
      const cursor = await db.latestEventId();
      expect(await capture([input])).toMatchObject({
        created: 0,
        updated: 1,
        unlisted: 0,
      });
      expect(await db.listTransactions({ presence: "current" })).toHaveLength(
        1,
      );
      expect(await db.getTransaction(original.id)).toMatchObject({
        identityStrength,
        amountMinor: -12345,
        presence: "seen",
        lastSeenAt: original.lastSeenAt,
        annotation,
        reviewRequired: true,
        sourceIssues: ["unverified_legacy_identity"],
      });
      expect(
        (await db.getTransaction(original.id))!.sourceEvidence,
      ).toBeUndefined();
      expect(await db.getTotals()).toEqual(totals);
      expect(
        (await db.listEvents({ after: cursor })).map((event) => event.type),
      ).not.toContain("transaction.created");
      await quiet([input]);
      const deferred = await db.raw(
        "SELECT reason, first_seen_run_id, last_seen_run_id FROM deferred_evidence",
      );
      expect(deferred).toEqual([
        {
          reason: "unverified_legacy_identity",
          first_seen_run_id: "source-2",
          last_seen_run_id: "source-4",
        },
      ]);
    },
  );

  it.each(["ordinary ambiguous posting", "weak pending authorization"])(
    "bootstraps a legacy CAL %s from exact retained source evidence",
    async (scenario) => {
      const document = JSON.parse(fixture("recent-01"));
      const pending = scenario === "weak pending authorization";
      const source = pending
        ? document.result.clearanceRequests[1]
        : document.result.transactions.find(
            (item: { trnIntId: string }) =>
              item.trnIntId === "SYNTHETIC-TXN-REGULAR",
          );
      delete source[pending ? "transactionID" : "trnIntId"];
      const body = {
        statusCode: 1,
        result: {
          transactions: pending ? [] : [source],
          clearanceRequests: pending ? [source] : [],
        },
      };
      await capture(body, calAdapter);
      const original = (await rows())[0]!;
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "CAL legacy owner note.",
      });
      await forgetComparisons([original.id]);
      const before = semantic(await rows());
      const events = await db.listEvents();
      expect(await capture(body, calAdapter)).toMatchObject({
        created: 0,
        updated: 0,
        unlisted: 0,
      });
      expect(semantic(await rows())).toEqual(before);
      expect(await db.listTransactions({ presence: "current" })).toHaveLength(
        1,
      );
      expect(
        (await db.getTransaction(original.id))!.sourceEvidence?.identity,
      ).toMatchObject({
        runId: "source-2",
        retiredFromMatching: false,
      });
      expect(await db.listEvents()).toEqual(events);
      await quiet(body, calAdapter);
    },
  );

  it("bootstraps a uniquely proved reordered legacy group without moving its notes", async () => {
    const first = evidencedRow("a", { amountMinor: -100 });
    const second = evidencedRow("b", { amountMinor: -200 });
    await capture([first, second], sourceRowsAdapter);
    const original = (await rows()).find((item) => item.sourceKey === "a")!;
    await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Note stays on a.",
    });
    await forgetComparisons((await rows()).map((item) => item.id));
    const before = semantic(await rows());
    const events = await db.listEvents();
    expect(await capture([second, first], sourceRowsAdapter)).toMatchObject({
      created: 0,
      updated: 0,
      unlisted: 0,
    });
    expect(semantic(await rows())).toEqual(before);
    expect(await db.listEvents()).toEqual(events);
    await quiet([first, second], sourceRowsAdapter);
  });

  it.each(["first upgrade", "previously deferred"] as const)(
    "admits a new charge after accounting for every legacy member: %s",
    async (upgrade) => {
      const first = evidencedRow("existing-a", {
        identityStrength: "weak",
        amountMinor: -100,
      });
      const second = evidencedRow("existing-b", {
        identityStrength: "weak",
        amountMinor: -200,
      });
      const added = evidencedRow("new-charge", {
        identityStrength: "weak",
        amountMinor: -300,
      });
      await capture([first, second], sourceRowsAdapter);
      const originals = await rows();
      const noted = originals.find((item) => item.sourceKey === "existing-a")!;
      const annotation = await db.editAnnotation({
        transactionId: noted.id,
        expectedVersion: 0,
        notes: "Keep this note on the original charge.",
      });
      await forgetComparisons(originals.map((item) => item.id));
      if (upgrade === "previously deferred") {
        expect(
          await capture(
            [
              evidencedRow("existing-a", {
                identityStrength: "weak",
                amountMinor: -150,
              }),
              second,
            ],
            sourceRowsAdapter,
          ),
        ).toMatchObject({ created: 0, unlisted: 0 });
        expect(await db.getTransaction(noted.id)).toMatchObject({
          amountMinor: -100,
          sourceIssues: ["unverified_legacy_identity"],
          annotation,
        });
      }
      const cursor = await db.latestEventId();
      const expanded = [added, second, first];
      expect(await capture(expanded, sourceRowsAdapter)).toMatchObject({
        created: 1,
        unlisted: 0,
      });
      const current = await rows();
      expect(current).toHaveLength(3);
      for (const original of originals) {
        expect(await db.getTransaction(original.id)).toMatchObject({
          sourceKey: original.sourceKey,
          amountMinor: original.amountMinor,
          presence: "seen",
          sourceIssues: [],
          sourceEvidence: { identity: { retiredFromMatching: false } },
        });
      }
      expect(await db.getTransaction(noted.id)).toMatchObject({ annotation });
      const admitted = current.find((item) => item.sourceKey === "new-charge")!;
      expect(admitted).toMatchObject({ amountMinor: -300, annotation: null });
      expect(await db.getTotals()).toMatchObject({
        includedCount: 3,
        totals: [
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -600,
          },
        ],
      });
      expect(
        (await db.listEvents({ after: cursor }))
          .filter((event) => event.type === "transaction.created")
          .map((event) => event.transactionId),
      ).toEqual([admitted.id]);
      await quiet([first, added, second], sourceRowsAdapter);
    },
  );

  it.each(["missing member", "duplicate proof", "partial capture"] as const)(
    "keeps an expanded legacy group deferred without a complete unique proof: %s",
    async (reason) => {
      const first = evidencedRow("proof-a", {
        identityStrength: "weak",
        amountMinor: -100,
      });
      const second = evidencedRow("proof-b", {
        identityStrength: "weak",
        amountMinor: -200,
      });
      const added = evidencedRow("proof-new", {
        identityStrength: "weak",
        amountMinor: -300,
      });
      await capture([first, second], sourceRowsAdapter);
      const originals = await rows();
      await forgetComparisons(originals.map((item) => item.id));
      const inputs =
        reason === "missing member"
          ? [first, added]
          : reason === "duplicate proof"
            ? [first, { ...first, sourceKey: "proof-copy" }, second, added]
            : [first, second, added];
      const adapter: SourceAdapter =
        reason === "partial capture"
          ? {
              ...sourceRowsAdapter,
              extract(text, context) {
                const result = sourceRowsAdapter.extract(text, context);
                return {
                  ...result,
                  partitions: result.partitions.map((partition) => ({
                    ...partition,
                    comparable: false,
                  })),
                };
              },
            }
          : sourceRowsAdapter;
      expect(await capture(inputs, adapter)).toMatchObject({
        created: 0,
        unlisted: 0,
      });
      expect(await rows()).toHaveLength(2);
      for (const original of originals) {
        expect(await db.getTransaction(original.id)).toMatchObject({
          amountMinor: original.amountMinor,
          presence: "seen",
          sourceIssues: ["unverified_legacy_identity"],
        });
      }
      await quiet(inputs, adapter);
    },
  );

  it.each(["ambiguous", "native"] as const)(
    "admits independent groups without guessing a new %s member of an unprovable legacy group",
    async (identityStrength) => {
      const legacy = evidencedRow("unproved-old", {
        identityStrength: "weak",
        amountMinor: -100,
      });
      delete legacy.details.provider.cal!.rows;
      await capture([legacy], sourceRowsAdapter);
      const original = (await rows())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Unproved attribution must remain here.",
      });
      await forgetComparisons([original.id]);
      const sameGroup = evidencedRow("possibly-new", {
        identityStrength,
        amountMinor: -200,
      });
      const independent = row("independent-new", { amountMinor: -300 });
      const inputs = [sameGroup, independent, legacy];
      expect(await capture(inputs, sourceRowsAdapter)).toMatchObject({
        created: 1,
        unlisted: 0,
      });
      expect(await rows()).toHaveLength(2);
      expect(await db.getTransaction(original.id)).toMatchObject({
        amountMinor: -100,
        presence: "seen",
        annotation,
        sourceIssues: ["unverified_legacy_identity"],
      });
      expect(
        (await db.getTransaction(original.id))!.sourceEvidence,
      ).toBeUndefined();
      expect(
        (await rows()).find((item) => item.sourceKey === "independent-new"),
      ).toMatchObject({ amountMinor: -300, annotation: null });
      expect(await db.getTotals()).toMatchObject({
        includedCount: 2,
        totals: [
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -400,
          },
        ],
      });
      await quiet(inputs, sourceRowsAdapter);
    },
  );

  it.each([
    "partial capture",
    "omitted transfer name",
    "original money",
    "FX fee",
    "FX rate",
  ] as const)(
    "defers a legacy comparison without complete pristine proof: %s",
    async (reason) => {
      const input = evidencedRow("guarded", {
        ...(reason === "omitted transfer name"
          ? { kind: "transfer" as const }
          : {}),
        ...(reason === "partial capture"
          ? { details: { ...emptyDetails(), issues: ["ambiguous_identity"] } }
          : {}),
      });
      await capture([input], sourceRowsAdapter);
      const original = (await rows())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Guarded legacy annotation.",
      });
      await forgetComparisons([original.id]);
      const incoming = structuredClone(input);
      if (reason === "omitted transfer name") {
        delete incoming.counterpartyName;
      } else if (reason === "original money") {
        incoming.originalAmountMinor = -300;
        incoming.originalCurrency = "USD";
      } else if (reason === "FX fee") {
        incoming.fxFeeMinor = 125;
        incoming.fxFeeCurrency = "ILS";
      } else if (reason === "FX rate") {
        incoming.details.currencyExchange = [
          {
            sourceCurrency: "USD",
            targetCurrency: "ILS",
            unitCurrency: "USD",
            exchangeRate: "3.2",
            quotationDate: "2040-07-01",
          },
        ];
      }
      const adapter: SourceAdapter =
        reason === "partial capture"
          ? {
              ...sourceRowsAdapter,
              extract(text, context) {
                const result = sourceRowsAdapter.extract(text, context);
                return {
                  ...result,
                  partitions: result.partitions.map((partition) => ({
                    ...partition,
                    comparable: false,
                  })),
                };
              },
            }
          : sourceRowsAdapter;
      expect(await capture([incoming], adapter)).toMatchObject({
        created: 0,
        updated: 1,
        unlisted: 0,
      });
      const retained = (await db.getTransaction(original.id))!;
      expect(retained).toMatchObject({
        amountMinor: original.amountMinor,
        originalAmountMinor: original.originalAmountMinor,
        originalCurrency: original.originalCurrency,
        fxFeeMinor: original.fxFeeMinor,
        fxFeeCurrency: original.fxFeeCurrency,
        counterpartyName: original.counterpartyName,
        identityStrength: original.identityStrength,
        presence: "seen",
        annotation,
        sourceIssues:
          reason === "partial capture"
            ? ["ambiguous_identity", "unverified_legacy_identity"]
            : ["unverified_legacy_identity"],
      });
      expect(retained.details.currencyExchange).toEqual(
        original.details.currencyExchange,
      );
      expect(retained.sourceEvidence).toBeUndefined();
      await quiet([incoming], adapter);
      // A later timestamp alone did not clear review. The complete original
      // statement supplies the actual unique proof, including explicit null.
      expect(await capture([input], sourceRowsAdapter)).toMatchObject({
        created: 0,
        updated: 1,
        unlisted: 0,
      });
      expect(await db.getTransaction(original.id)).toMatchObject({
        amountMinor: original.amountMinor,
        annotation,
        sourceIssues:
          reason === "partial capture" ? ["ambiguous_identity"] : [],
        sourceEvidence: {
          identity: { retiredFromMatching: false, runId: "source-5" },
        },
      });
      await quiet([input], sourceRowsAdapter);
    },
  );

  it("defers indistinguishable legacy evidence rather than guessing an annotation's row", async () => {
    const first = evidencedRow("a");
    const second = { ...first, sourceKey: "b" };
    await capture([first, second], sourceRowsAdapter);
    const original = (await rows()).find((item) => item.sourceKey === "a")!;
    const annotation = await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Do not guess this note's attribution.",
    });
    await forgetComparisons((await rows()).map((item) => item.id));
    expect(await capture([second, first], sourceRowsAdapter)).toMatchObject({
      created: 0,
      unlisted: 0,
    });
    expect(await rows()).toHaveLength(2);
    expect(await db.getTransaction(original.id)).toMatchObject({
      annotation,
      sourceIssues: ["unverified_legacy_identity"],
    });
    expect(
      (await rows()).every((item) => item.sourceEvidence === undefined),
    ).toBe(true);
    await quiet([first, second], sourceRowsAdapter);
  });

  it.each(["weak", "ambiguous"] as const)(
    "admits a fresh generation after the owner removes all indistinguishable legacy %s twins",
    async (identityStrength) => {
      const first = evidencedRow("removed-twin-a", {
        amountMinor: -1250,
        identityStrength,
      });
      const second = { ...first, sourceKey: "removed-twin-b" };
      await capture([first, second], sourceRowsAdapter);
      const originals = await rows();
      const annotations = new Map<string, unknown>();
      for (const original of originals) {
        annotations.set(
          original.id,
          await db.editAnnotation({
            transactionId: original.id,
            expectedVersion: 0,
            notes: `Historical note for ${original.sourceKey}.`,
          }),
        );
      }
      await forgetComparisons(originals.map((item) => item.id));
      expect(await capture([second, first], sourceRowsAdapter)).toMatchObject({
        created: 0,
        unlisted: 0,
      });
      for (const original of originals) {
        const deferred = (await db.getTransaction(original.id))!;
        expect(deferred).toMatchObject({
          presence: "seen",
          sourceIssues: ["unverified_legacy_identity"],
          annotation: annotations.get(original.id),
        });
        await db.confirmRemoval({
          transactionId: original.id,
          expectedVersion: deferred.version,
          reason:
            "Invented owner reconciliation of the disputed legacy population.",
        });
      }
      expect(await db.listTransactions({ presence: "current" })).toHaveLength(
        0,
      );
      const cursor = await db.latestEventId();
      expect(await capture([first, second], sourceRowsAdapter)).toMatchObject({
        created: 2,
        unlisted: 0,
      });
      const current = await db.listTransactions({ presence: "current" });
      expect(current).toHaveLength(2);
      const originalIds = new Set(originals.map((item) => item.id));
      for (const item of current) {
        expect(originalIds.has(item.id)).toBe(false);
        expect(item).toMatchObject({
          amountMinor: -1250,
          presence: "seen",
          annotation: null,
        });
        expect(item.sourceIssues).not.toContain("unverified_legacy_identity");
      }
      for (const original of originals) {
        expect(await db.getTransaction(original.id)).toMatchObject({
          id: original.id,
          presence: "removed",
          amountMinor: -1250,
          annotation: annotations.get(original.id),
        });
      }
      expect(await rows()).toHaveLength(4);
      expect(await db.getTotals()).toMatchObject({
        includedCount: identityStrength === "weak" ? 2 : 0,
        excluded: { unresolved: identityStrength === "ambiguous" ? 2 : 0 },
        totals:
          identityStrength === "weak"
            ? [
                {
                  currency: "ILS",
                  amountBasis: "purchase_commitment",
                  amountMinor: -2500,
                },
              ]
            : [],
      });
      const created = (await db.listEvents({ after: cursor })).filter(
        (event) => event.type === "transaction.created",
      );
      expect(created).toHaveLength(2);
      expect(new Set(created.map((event) => event.transactionId))).toEqual(
        new Set(current.map((item) => item.id)),
      );
      await quiet([first, second], sourceRowsAdapter);
    },
  );

  it.each(["history-only", "confirmed absent", "owner removed"] as const)(
    "distinguishes unknown legacy membership from an intentionally separate weak reappearance: %s",
    async (membership) => {
      const input = evidencedRow("membership", {
        identityStrength: "weak",
        amountMinor: -12345,
      });
      const historical: SourceAdapter = {
        ...sourceRowsAdapter,
        extract(text, context) {
          return {
            ...sourceRowsAdapter.extract(text, context),
            historical: true,
          };
        },
      };
      await capture(
        [input],
        membership === "history-only" ? historical : sourceRowsAdapter,
        membership === "history-only"
          ? { kind: "history", from: "2040-07-01", to: "2040-07-01" }
          : undefined,
      );
      const original = (await rows())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Original membership annotation.",
      });
      await forgetComparisons([original.id]);
      if (membership === "confirmed absent") {
        await capture([], sourceRowsAdapter);
        expect(
          (await db.getTransaction(original.id))!.sourceAbsence,
        ).toBeDefined();
      } else if (membership === "owner removed") {
        await db.confirmRemoval({
          transactionId: original.id,
          expectedVersion: original.version,
          reason: "Invented owner decision.",
        });
      } else {
        expect(original.presence).toBe("not_returned");
        expect(original.sourceAbsence).toBeUndefined();
      }
      expect(await capture([input], sourceRowsAdapter)).toMatchObject({
        created: membership === "history-only" ? 0 : 1,
      });
      const current = await db.listTransactions({ presence: "current" });
      expect(current).toHaveLength(1);
      expect(await db.getTotals()).toMatchObject({
        includedCount: 1,
        totals: [
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -12345,
          },
        ],
      });
      expect(await db.getTransaction(original.id)).toMatchObject({
        annotation,
      });
      if (membership === "history-only") {
        expect(current[0]).toMatchObject({
          id: original.id,
          presence: "not_returned",
          identityStrength: "weak",
          sourceIssues: ["unverified_legacy_identity"],
        });
        expect(current[0]!.sourceEvidence).toBeUndefined();
        expect(await rows()).toHaveLength(1);
      } else {
        expect(current[0]!.id).not.toBe(original.id);
        expect(current[0]!.annotation).toBeNull();
        expect(await rows()).toHaveLength(2);
      }
      if (membership === "confirmed absent") {
        const before = semantic(await rows());
        const events = await db.listEvents();
        for (let repeat = 0; repeat < 2; repeat++) {
          expect(await capture([input], sourceRowsAdapter)).toMatchObject({
            created: 0,
            updated: 0,
            unlisted: 0,
          });
          const receipt = {
            runId: `source-${day}`,
            capturedAt: `2040-07-${String(day).padStart(2, "0")}T12:00:00.000Z`,
          };
          expect((await db.getTransaction(original.id))!.sourceAbsence).toEqual(
            receipt,
          );
          // Only the independently validated continuing-absence watermark moves.
          before.find((item) => item.id === original.id)!.sourceAbsence =
            receipt;
          expect(semantic(await rows())).toEqual(before);
          expect(await db.listEvents()).toEqual(events);
        }
      } else {
        await quiet([input], sourceRowsAdapter);
      }
    },
  );

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
