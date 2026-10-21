import { describe, expect, it } from "vitest";

import { emptyDetails, type JsonObject } from "../../../src/domain/model.js";
import {
  currentSourceRowIndices,
  currentSourceRows,
  evidenceList,
} from "../../../src/domain/provider-evidence.js";
import { calAdapter } from "../../../src/providers/cal/adapter.js";
import {
  mergeCalEvidence,
  projectCalState,
  retainCalEvidence,
} from "../../../src/providers/cal/evidence.js";
import { calPostingEvidence } from "../../../src/providers/cal/posting-evidence.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";

const row: JsonObject = {
  cardUniqueID: "SYNTHETIC-CARD",
  transactionID: "SYNTHETIC-AUTH",
  merchantName: "Synthetic shop",
  internationalBranchID: "5411",
  trnTypeCode: "5",
  transCardPresentInd: false,
  walletTranInd: "0",
  numberOfPayments: "0",
  trnAmt: "10.00",
  trnCurrencySymbol: "₪",
  trnPurchaseDate: "2040-06-11T11:00:00",
};

describe("CAL retained evidence", () => {
  it("uses the current whole statement after partial evidence becomes complete and continues to posting", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      const pending: JsonObject = { ...row, trnAmt: 10 };
      const { internationalBranchID: _missingCategory, ...partial } = pending;
      const posted = {
        cardUniqueId: "SYNTHETIC-CARD",
        trnIntId: "SYNTHETIC-POSTED",
        merchantName: "Synthetic shop",
        internationalBranchID: "5411",
        trnPurchaseDate: "2040-06-11T11:00:00",
        amountForDisplay: 10,
        trnAmt: 10,
        transactionTypeCode: 5,
        trnType: "רגילה",
        refundInd: false,
        numOfPayments: 0,
        curPaymentNum: 0,
        transCardPresentInd: false,
        tokenInd: 0,
        debCrdCurrencyCode: 3,
        debCrdCurrencySymbol: "₪",
        currencyForDisplay: "₪",
        trnCurrencyIsoCode: "376",
        transOriginalCurrencyCode: 3,
        trnCurrencySymbol: "₪",
      };
      const capture = (
        day: number,
        transactions: unknown[],
        clearanceRequests: unknown[],
      ) =>
        db.ingestRun(
          {
            connectionId: "synthetic",
            runId: `synthetic-${day}`,
            responses: [
              {
                accountKey: "synthetic-account",
                endpoint: "synthetic:cal/recent",
                capturedAt: `2040-06-${11 + day}T12:00:00.000Z`,
                responseText: JSON.stringify({
                  statusCode: 1,
                  result: { transactions, clearanceRequests },
                }),
              },
            ],
          },
          calAdapter,
        );
      await capture(1, [], [partial]);
      const original = (await db.listTransactions())[0]!;
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Synthetic authorization note",
      });
      await capture(2, [], [pending]);
      const complete = (await db.getTransaction(original.id))!;
      expect(evidenceList(complete.details.provider.cal!.rows)).toHaveLength(2);
      expect(currentSourceRows(complete.details.provider.cal!)).toHaveLength(1);
      expect(calPostingEvidence(complete)).toMatchObject({
        categoryCode: "5411",
      });
      expect(await capture(3, [posted], [])).toMatchObject({ created: 0 });
      expect(await db.getTransaction(original.id)).toMatchObject({
        id: original.id,
        status: "posted",
        annotation: { data: { notes: "Synthetic authorization note" } },
        details: { postingLink: { automatic: true } },
      });
      expect(await db.listTransactions()).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it("never borrows matching fields from historical partial statements or ignores a current contradiction", () => {
    const { internationalBranchID: _category, ...partial } = row;
    const merged = mergeCalEvidence({ rows: [partial] }, { rows: [row] });
    const rows = evidenceList(merged.rows);
    const namespace = {
      ...merged,
      identity: { currentRows: currentSourceRowIndices(rows, [row]) },
    };
    const decode = (value: JsonObject) =>
      calPostingEvidence({
        details: { ...emptyDetails(), provider: { cal: value } },
      });
    expect(decode(namespace)).toMatchObject({ categoryCode: "5411" });
    expect(
      decode({
        ...namespace,
        identity: { currentRows: currentSourceRowIndices(rows, [partial]) },
      }),
    ).toBeNull();
    expect(
      decode({ ...namespace, identity: { currentRows: [999] } }),
    ).toBeNull();
    const contradictory = { ...row, transCardPresentInd: true };
    expect(
      decode({ rows: [row, contradictory], identity: { currentRows: [0, 1] } }),
    ).toBeNull();
  });
  it("keeps native and weak partial evidence stable across scope alternation without synthesizing matching facts", () => {
    const { internationalBranchID: _category, ...withoutCategory } = row;
    const { transCardPresentInd: _presence, ...withoutPresence } = row;
    for (const native of [true, false]) {
      const first = {
        rows: [
          {
            ...withoutCategory,
            transactionID: native ? row.transactionID! : null,
          },
        ],
      };
      const second = {
        rows: [
          {
            ...withoutPresence,
            transactionID: native ? row.transactionID! : null,
          },
        ],
      };
      const merged = mergeCalEvidence(first, second);
      expect(merged.rows).toHaveLength(2);
      expect(mergeCalEvidence(mergeCalEvidence(merged, first), second)).toEqual(
        merged,
      );
      expect(
        calPostingEvidence({
          details: { ...emptyDetails(), provider: { cal: merged } },
        }),
      ).toBeNull();
    }
  });

  it("canonicalizes nested comments and payment-history arrays without dropping duplicates", () => {
    const comments = [
      { key: "Synthetic A", value: null },
      { key: "Synthetic B", value: "note" },
      { key: "Synthetic A", value: null },
    ];
    const history = [
      { num: "1", amount: "10.00" },
      { num: "2", amount: "11.00" },
    ];
    const first = retainCalEvidence({
      rows: [{ ...row, comments, paymentsMade: history }],
    });
    const second = retainCalEvidence({
      rows: [
        {
          ...row,
          comments: [...comments].reverse(),
          paymentsMade: [...history].reverse(),
        },
      ],
    });
    expect(second).toEqual(first);
    expect((first.rows as JsonObject[])[0]!.comments as unknown[]).toHaveLength(
      3,
    );
  });
  it("keeps declared operational identity apart from source evidence", () => {
    expect(
      projectCalState({
        identity: {
          baseKey: "synthetic-base",
          occurrenceCount: 2,
          currentRows: [1, 0],
          noise: { nested: true },
        },
        currencyMapping: "derived",
        rows: [row],
        unknown: "discard",
      }),
    ).toEqual({
      identity: {
        baseKey: "synthetic-base",
        occurrenceCount: 2,
        currentRows: [1, 0],
      },
      currencyMapping: "derived",
    });
  });
  it("retains every posting decoder field and rejects malformed optional evidence after projection", () => {
    const decode = (provider: JsonObject) =>
      calPostingEvidence({
        details: {
          ...emptyDetails(),
          provider: { cal: retainCalEvidence(provider) },
        },
      });
    const source = {
      ...row,
      cardUniqueId: row.cardUniqueID!,
      transactionTypeCode: "5",
      tokenInd: "0",
      numOfPayments: "0",
      isAbroadApproval: false,
      isAbroadTransaction: false,
      merchantId: "SYNTHETIC-MERCHANT",
    };
    expect(decode({ rows: [source] })).toMatchObject({
      merchantName: "Synthetic shop",
      abroad: false,
      merchantProviderId: "SYNTHETIC-MERCHANT",
    });
    expect(
      decode({ rows: [{ ...source, isAbroadApproval: { noise: "discard" } }] }),
    ).toBeNull();
    expect(decode({ rows: [{ ...source, merchantId: ["noise"] }] })).toBeNull();
    expect(decode({ rows: [{ ...source, tokenInd: "1" }] })).toBeNull();
    expect(
      decode({
        rows: [source, { ...source, cardUniqueID: "SYNTHETIC-OTHER" }],
      }),
    ).toBeNull();
  });

  it("preserves duplicate retained comments across overlapping payment components", () => {
    const component = (num: string, amount: string) => ({
      cardUniqueId: "SYNTHETIC-CARD",
      trnIntId: "SYNTHETIC-PLAN",
      curPaymentNum: num,
      amtBeforeConvAndIndex: amount,
    });
    const first = {
      rows: [component("1", "10")],
      retained: {
        comments: [
          { key: "Synthetic", value: "note" },
          { key: "Synthetic", value: "note" },
        ],
      },
    };
    const second = {
      rows: [component("2", "11")],
      retained: { comments: [{ value: "note", key: "Synthetic" }] },
    };
    const merged = mergeCalEvidence(first, second);
    expect((merged.retained as JsonObject).comments).toHaveLength(2);
  });
});
