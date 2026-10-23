import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../src/providers/isracard/capture.js";
import { backends, type Harness, open } from "../helpers/storage-harness.js";

function complete(): IsracardCapture {
  return JSON.parse(
    readFileSync(
      new URL(
        "../providers/isracard/fixtures/card-month.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as IsracardCapture;
}

function partial(
  change?: (row: Record<string, unknown>) => void,
): IsracardCapture {
  const capture = complete();
  delete capture.responses.digital;
  if (change) {
    const legacy = JSON.parse(capture.responses.legacy!);
    change(
      legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]
        .txnIsrael[0],
    );
    capture.responses.legacy = JSON.stringify(legacy);
  }
  return capture;
}

describe.each(backends)("%s row financial authority", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({
      id: "synthetic-financial-authority",
      provider: "isracard",
    });
  });
  afterEach(() => db.close());

  function ingest(runId: string, day: number, capture = complete()) {
    const accountKey = isracardCardKey(capture.card);
    return db.ingestRun(
      {
        connectionId: "synthetic-financial-authority",
        runId,
        responses: [
          {
            accountKey,
            endpoint: "isracard:card-month",
            capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00Z`,
            responseText: serializeIsracardCapture(capture),
            scope: {
              kind: "recent",
              month: capture.billingMonth,
              cardKey: accountKey,
            },
          },
        ],
      },
      isracardAdapter,
    );
  }

  async function purchase() {
    const found = (await db.listTransactions()).find((row) =>
      row.sourceKey.includes("VOUCHER-1"),
    );
    expect(found).toBeDefined();
    return (await db.getTransaction(found!.id))!;
  }

  it("keeps a supported bundle and its older receipt through missing auxiliary evidence, then accepts a complete restoration", async () => {
    await ingest("supported", 1);
    const before = await purchase();
    expect(before.sourceEvidence?.financial).toMatchObject({
      runId: "supported",
      capturedAt: "2040-08-01T00:00:00.000Z",
    });
    const annotation = await db.editAnnotation({
      transactionId: before.id,
      expectedVersion: 0,
      notes: "Keep the owner's purchase note",
    });
    expect(await ingest("missing-auxiliary", 2, partial())).toMatchObject({
      status: "partial",
      created: 0,
    });
    const retained = await purchase();
    expect(retained).toMatchObject({
      id: before.id,
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
      currency: "ILS",
      originalAmountMinor: -8640,
      originalCurrency: "ILS",
      annotation,
      lastSeenAt: "2040-08-02T00:00:00.000Z",
    });
    expect(retained.sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
    expect(retained.details.issues).toContain("retained_financial_evidence");
    expect(await db.getTotals()).toMatchObject({ includedCount: 1 });
    const cursor = await db.latestEventId();
    await ingest("missing-again", 3, partial());
    const repeated = await purchase();
    expect(repeated.version).toBe(retained.version);
    expect(repeated.sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
    expect(
      (await db.listEvents({ after: cursor })).filter((event) =>
        event.type.startsWith("transaction."),
      ),
    ).toEqual([]);
    await ingest("restored", 4);
    const restored = await purchase();
    expect(restored.id).toBe(before.id);
    expect(restored.annotation).toEqual(annotation);
    expect(restored.sourceEvidence?.financial).toMatchObject({
      runId: "restored",
      capturedAt: "2040-08-04T00:00:00.000Z",
    });
    expect(restored.details.issues).not.toContain(
      "retained_financial_evidence",
    );
  });

  it.each([
    [
      "amount",
      (row: Record<string, unknown>) => {
        row.paymentSum = 99;
      },
    ],
    [
      "currency",
      (row: Record<string, unknown>) => {
        row.currencyId = "USD";
      },
    ],
    [
      "plan role",
      (row: Record<string, unknown>) => {
        row.moreInfo = "תשלום 1 מתוך 3";
      },
    ],
  ] as const)(
    "does not preserve accepted money after a partial %s contradiction or revive it on a later partial",
    async (_name, change) => {
      await ingest("supported", 1);
      const before = await purchase();
      await ingest("contradictory", 2, partial(change));
      const contradicted = await purchase();
      expect(contradicted.id).toBe(before.id);
      expect(contradicted.amountBasis).toBe("unknown");
      expect(contradicted.sourceEvidence?.financial).toBeUndefined();
      expect(await db.getTotals()).toMatchObject({ includedCount: 0 });
      await ingest("incomplete-again", 3, partial());
      const unresolved = await purchase();
      expect(unresolved.amountBasis).toBe("unknown");
      expect(unresolved.kind).toBe("unknown");
      expect(unresolved.sourceEvidence?.financial).toBeUndefined();
      expect(await db.getTotals()).toMatchObject({ includedCount: 0 });
    },
  );

  it("accepts independent recurrence and billing-date updates without treating them as changed financial support", async () => {
    await ingest("supported", 1);
    const before = await purchase();
    await ingest(
      "incomplete-with-context-update",
      2,
      partial((row) => {
        row.isHoraatKeva = true;
        row.fullPaymentDate = "11/07/2040";
      }),
    );
    const after = await purchase();
    expect(after).toMatchObject({
      id: before.id,
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
      recurring: true,
      billingDate: "2040-07-11",
    });
    expect(after.sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
  });

  it("keeps payment-context uncertainty independent of retained financial support", async () => {
    const supported = complete();
    const digital = JSON.parse(supported.responses.digital!);
    digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0].presentCard = true;
    supported.responses.digital = JSON.stringify(digital);
    const detail = JSON.parse(supported.responses.details![0]!.responseText);
    detail.PirteyIska_204Bean.clearingData = "לא הוצג";
    supported.responses.details![0]!.responseText = JSON.stringify(detail);
    await ingest("supported-context-conflict", 1, supported);
    const before = await purchase();
    expect(before.cardPresent).toBeNull();
    expect(before.details.issues).toContain("conflicting_payment_context");
    delete supported.responses.digital;
    await ingest("missing-digital-context-conflict", 2, supported);
    const after = await purchase();
    expect(after).toMatchObject({
      id: before.id,
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
      cardPresent: null,
    });
    expect(after.sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
    expect(after.details.issues).toContain("retained_financial_evidence");
    expect(after.details.issues).toContain("conflicting_payment_context");
  });

  it("keeps independent billing-date and unavailable-detail uncertainty out of the financial bundle", async () => {
    const supported = complete();
    const detail = JSON.parse(supported.responses.details![0]!.responseText);
    detail.PirteyIska_204Bean.moedChiuvFull = "11/07/2040";
    supported.responses.details![0]!.responseText = JSON.stringify(detail);
    await ingest("supported-date-conflict", 1, supported);
    const before = await purchase();
    expect(before.billingDate).toBeNull();
    expect(before.details.issues).toContain("conflicting_billing_date");
    delete supported.responses.digital;
    await ingest("missing-digital-date-conflict", 2, supported);
    expect((await purchase()).sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
    supported.responses.details!.push(
      structuredClone(supported.responses.details![0]!),
    );
    await ingest("ambiguous-optional-detail", 3, supported);
    const ambiguous = await purchase();
    expect(ambiguous).toMatchObject({
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
    });
    expect(ambiguous.details.issues).toContain("ambiguous_transaction_detail");
    expect(ambiguous.sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
    supported.responses.details!.pop();
    supported.responses.details![0]!.responseText = "{}";
    await ingest("invalid-optional-detail", 4, supported);
    const invalid = await purchase();
    expect(invalid).toMatchObject({
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
    });
    expect(invalid.details.issues).toContain("invalid_transaction_detail");
    expect(invalid.sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
  });

  it("does not treat an omitted optional financial detail as contradiction of the surviving component", async () => {
    const supported = complete();
    const detail = JSON.parse(supported.responses.details![0]!.responseText);
    detail.PirteyIska_204Bean.dealCode = "1";
    detail.PirteyIska_204Bean.dealSum = "86.40";
    supported.responses.details![0]!.responseText = JSON.stringify(detail);
    await ingest("supported-with-detail", 1, supported);
    const before = await purchase();
    const incomplete = partial();
    delete incomplete.responses.details;
    await ingest("missing-required-and-optional", 2, incomplete);
    const after = await purchase();
    expect(after).toMatchObject({
      id: before.id,
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
    });
    expect(after.sourceEvidence?.financial).toEqual(
      before.sourceEvidence?.financial,
    );
    expect(after.details.issues).toContain("retained_financial_evidence");
  });

  it.each([JSON.stringify({ isSuccess: false, data: null }), "not-json"])(
    "retains supported money when the required Digital feed is unusable (%s)",
    async (responseText) => {
      await ingest("supported", 1);
      const before = await purchase();
      const capture = complete();
      capture.responses.digital = responseText;
      await ingest("unusable-required-feed", 2, capture);
      const after = await purchase();
      expect(after).toMatchObject({
        id: before.id,
        amountBasis: "purchase_commitment",
        kind: "purchase",
        amountMinor: -8640,
      });
      expect(after.sourceEvidence?.financial).toEqual(
        before.sourceEvidence?.financial,
      );
      expect(after.details.issues).toContain("retained_financial_evidence");
    },
  );

  it("does not treat a successful Digital row's invalid money as absent support", async () => {
    await ingest("supported", 1);
    const capture = complete();
    const digital = JSON.parse(capture.responses.digital!);
    digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0].billingAmount =
      "not-an-amount";
    capture.responses.digital = JSON.stringify(digital);
    await ingest("invalid-current-money", 2, capture);
    const after = await purchase();
    expect(after.amountBasis).toBe("unknown");
    expect(after.sourceEvidence?.financial).toBeUndefined();
    expect(await db.getTotals()).toMatchObject({ includedCount: 0 });
  });

  it("does not retain money for an explicit unsupported code, even if the other required response is missing", async () => {
    await ingest("supported", 1);
    const capture = complete();
    const digital = JSON.parse(capture.responses.digital!);
    digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0].transactionCode = 999;
    capture.responses.digital = JSON.stringify(digital);
    delete capture.responses.legacy;
    await ingest("unsupported", 2, capture);
    expect(await purchase()).toMatchObject({
      kind: "unknown",
      amountBasis: "unknown",
    });
    expect((await purchase()).sourceEvidence?.financial).toBeUndefined();
    await ingest("incomplete-again", 3, partial());
    expect(await db.getTotals()).toMatchObject({ includedCount: 0 });
  });

  it("retains support for the current posted identity after an owner link, without treating its pending alias as renewed posted authority", async () => {
    const capture = complete();
    const approvalFixture = JSON.parse(
      readFileSync(
        new URL(
          "../providers/isracard/fixtures/card-month-approvals.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as IsracardCapture;
    const approval = JSON.parse(approvalFixture.responses.digital!).data
      .approvals.approvedTransactions[0];
    const digital = JSON.parse(capture.responses.digital!);
    digital.data.currentTransactionsList = null;
    digital.data.approvals = {
      approvedTransactions: [approval],
      totalEstimatedAmount: 86.4,
    };
    capture.isNextBillingDate = true;
    capture.responses.digital = JSON.stringify(digital);
    await ingest("supported-with-authorization", 1, capture);
    const posted = await purchase();
    const pending = (await db.listTransactions()).find(
      (row) => row.status === "pending",
    )!;
    expect(pending).toBeDefined();
    await db.linkPendingTransaction({
      pendingId: pending.id,
      postedId: posted.id,
      expectedPendingVersion: pending.version,
      expectedPostedVersion: posted.version,
      expectedPendingAnnotationVersion: 0,
      expectedPostedAnnotationVersion: 0,
      reason: "Owner verified these invented identities describe one purchase",
    });
    const linked = (await db.getTransaction(pending.id))!;
    await ingest("linked-incomplete", 2, partial());
    const retained = (await db.getTransaction(pending.id))!;
    expect(retained).toMatchObject({
      status: "posted",
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
      lastSeenRunId: "linked-incomplete",
    });
    expect(retained.sourceEvidence?.financial).toEqual(
      linked.sourceEvidence?.financial,
    );
    expect(retained.details.issues).toContain("retained_financial_evidence");

    digital.data.israelAbroadVouchers = null;
    digital.data.approvals.approvedTransactions[0].originalAmount = 99;
    digital.data.approvals.totalEstimatedAmount = 99;
    capture.responses.digital = JSON.stringify(digital);
    const legacy = JSON.parse(capture.responses.legacy!);
    legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0].txnIsrael =
      [];
    capture.responses.legacy = JSON.stringify(legacy);
    await ingest("pending-alias-only", 3, capture);
    const afterAlias = (await db.getTransaction(pending.id))!;
    expect(afterAlias).toMatchObject({
      status: "posted",
      amountMinor: -8640,
      amountBasis: "purchase_commitment",
      lastSeenRunId: "linked-incomplete",
    });
    expect(afterAlias.sourceEvidence?.financial).toEqual(
      linked.sourceEvidence?.financial,
    );
    expect(afterAlias.details.postingLink?.pending).toMatchObject({
      status: "pending",
      amountMinor: -9900,
      lastSeenRunId: "pending-alias-only",
    });
  });

  it("keeps a new incomplete identity unresolved", async () => {
    await ingest("incomplete-first", 1, partial());
    expect(await purchase()).toMatchObject({
      kind: "unknown",
      amountBasis: "unknown",
    });
    expect((await purchase()).sourceEvidence?.financial).toBeUndefined();
    expect(await db.getTotals()).toMatchObject({ includedCount: 0 });
  });

  it("does not let a stale partial overwrite newer complete financial evidence", async () => {
    await ingest("newer-supported", 3);
    const before = await purchase();
    await ingest(
      "stale-contradiction",
      2,
      partial((row) => {
        row.paymentSum = 99;
      }),
    );
    const after = await purchase();
    expect(after).toMatchObject({
      id: before.id,
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
      lastSeenAt: before.lastSeenAt,
      sourceEvidence: before.sourceEvidence,
    });
  });

  it("can retain a compatible legacy bundle without fabricating a financial receipt", async () => {
    await ingest("legacy-supported", 1);
    const before = await purchase();
    await db.raw(
      "UPDATE transaction_reconciliation SET source_evidence_json = NULL WHERE transaction_id = ?",
      [before.id],
    );
    await ingest("missing-auxiliary", 2, partial());
    const after = await purchase();
    expect(after).toMatchObject({
      id: before.id,
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
    });
    expect(after.sourceEvidence?.financial).toBeUndefined();
    expect(after.details.issues).toContain("retained_financial_evidence");
  });
});
