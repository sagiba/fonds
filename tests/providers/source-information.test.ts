import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { calAdapter } from "../../src/providers/cal/adapter.js";
import { extractCal } from "../../src/providers/cal/extract.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
} from "../../src/providers/isracard/capture.js";
import { extractIsracard } from "../../src/providers/isracard/extract.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { retained } from "../helpers/provider-evidence.js";

type Row = Record<string, unknown>;

function fixture(path: string): string {
  return readFileSync(new URL(`./${path}.json`, import.meta.url), "utf8");
}

function calResponse(message: string | null) {
  const response = JSON.parse(fixture("cal/fixtures/recent-01")) as {
    result: { transactions: Row[]; clearanceRequests: Row[] };
  };
  response.result.transactions = [response.result.transactions[0]!];
  response.result.clearanceRequests = [];
  const row = response.result.transactions[0]!;
  for (const key of [
    "comments",
    "linkedComments",
    "immediateComments",
    "transTypeCommentDetails",
  ]) {
    row[key] = [];
  }
  row.comments = message === null ? [] : [{ value: message }];
  return response;
}

function isracardCapture(message: unknown): IsracardCapture {
  const capture = JSON.parse(
    fixture("isracard/fixtures/card-month"),
  ) as IsracardCapture;
  const digital = JSON.parse(capture.responses.digital!);
  digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0].moreInfo =
    message;
  capture.responses.digital = JSON.stringify(digital);
  return capture;
}

describe("source explanatory information", () => {
  it("projects only known CAL comment slots, preserving source whitespace and markup without assigning roles", () => {
    const source = calResponse(null);
    const row = source.result.transactions[0]!;
    row.comments = [
      {
        key: "Synthetic purpose label",
        value: "  <b>Invented transfer purpose</b>  ",
        opaque: "RAW ONLY",
      },
      { key: "  Synthetic standalone label  ", value: " " },
      { value: "Synthetic fee waiver explanation" },
      { value: "Synthetic discount notice" },
      { value: "Synthetic internet/contactless explanation" },
      { value: "   " },
      { value: 5 },
      "Opaque unverified shape",
    ];
    row.linkedComments = [{ text: "Synthetic linked note", value: "RAW ONLY" }];
    row.immediateComments = [
      { comment: "Synthetic immediate note", other: "RAW ONLY" },
    ];
    row.transTypeCommentDetails = [
      { text: "Unverified text slot remains raw" },
    ];
    const result = extractCal(JSON.stringify(source), {
      accountKey: "SYNTHETIC-CAL-ACCOUNT",
      runId: "synthetic-run",
    });
    const transaction = result.transactions[0]!;
    expect(transaction.details.additionalInformation).toEqual([
      "Synthetic purpose label:   <b>Invented transfer purpose</b>  ",
      "  Synthetic standalone label  ",
      "Synthetic fee waiver explanation",
      "Synthetic discount notice",
      "Synthetic internet/contactless explanation",
      "Synthetic linked note",
      "Synthetic immediate note",
    ]);
    expect(retained(transaction.details, "comments")).toContainEqual({
      text: "Unverified text slot remains raw",
    });
    expect(transaction.counterpartyName).toBeNull();
    expect(transaction.details).not.toHaveProperty("fees");
  });

  it("projects CAL transaction-type details and the ongoing-transaction comment as text, keeping the raw rows exact", () => {
    const source = calResponse(null);
    const row = source.result.transactions[0]!;
    row.transTypeCommentDetails = [
      "\u200fSynthetic amount - \u200e$9.99\u200f",
      "Synthetic installment note",
      "  ",
      { text: "Unverified object shape remains raw" },
    ];
    row.onGoingTransactionsComment = "Synthetic ongoing note";
    const transaction = extractCal(JSON.stringify(source), {
      accountKey: "SYNTHETIC-CAL-ACCOUNT",
      runId: "synthetic-run",
    }).transactions[0]!;
    expect(transaction.details.additionalInformation).toEqual([
      "\u200fSynthetic amount - \u200e$9.99\u200f",
      "Synthetic installment note",
      "Synthetic ongoing note",
    ]);
    expect(transaction.details.provider.cal).toMatchObject({
      rows: [
        {
          transTypeCommentDetails: row.transTypeCommentDetails,
          onGoingTransactionsComment: "Synthetic ongoing note",
        },
      ],
    });
  });

  it("projects DigitalV3 same-row moreInfo without flattening arbitrary payloads or optional detail text", () => {
    for (const moreInfo of [
      "  <b>Synthetic source explanation</b>  ",
      null,
      { text: "Opaque" },
      "  ",
    ]) {
      const capture = isracardCapture(moreInfo);
      const detail = JSON.parse(capture.responses.details![0]!.responseText);
      detail.PirteyIska_204Bean.moreInfo = "Voucher-only text remains raw";
      capture.responses.details![0]!.responseText = JSON.stringify(detail);
      const result = extractIsracard(JSON.stringify(capture), {
        accountKey: isracardCardKey(capture.card),
        runId: "synthetic-run",
        scope: {
          kind: capture.mode,
          month: capture.billingMonth,
          cardKey: isracardCardKey(capture.card),
        },
      });
      const transaction = result.transactions.find(
        (item) => item.transactionDate === "2040-06-11",
      )!;
      expect(transaction.details.additionalInformation).toEqual(
        typeof moreInfo === "string" && moreInfo.trim() ? [moreInfo] : [],
      );
      expect(transaction.details.provider.isracard!.detail).toMatchObject({
        moreInfo: "Voucher-only text remains raw",
      });
    }
  });

  it.each(["cal", "isracard"] as const)(
    "replaces and clears %s typed prose on correction while historical observations cannot replace current information",
    async (provider) => {
      const db = await openDatabase(":memory:");
      try {
        await db.ensureConnection({ id: "synthetic-information", provider });
        const messages = [
          "Synthetic first message",
          "Synthetic corrected message",
          "Synthetic historical message",
          null,
        ];
        let transactionId: string | undefined;
        for (const [index, message] of messages.entries()) {
          const capture = isracardCapture(message);
          capture.mode = index === 2 ? "history" : "recent";
          const accountKey =
            provider === "cal"
              ? "SYNTHETIC-CAL-ACCOUNT"
              : isracardCardKey(capture.card);
          await db.ingestRun(
            {
              connectionId: "synthetic-information",
              runId: `synthetic-run-${index}`,
              responses: [
                {
                  accountKey,
                  endpoint: `${provider}:synthetic`,
                  capturedAt: `2040-08-0${index + 1}T00:00:00Z`,
                  responseText:
                    provider === "cal"
                      ? JSON.stringify(calResponse(message))
                      : JSON.stringify(capture),
                  scope: {
                    kind: index === 2 ? "history" : "recent",
                    ...(provider === "isracard"
                      ? { month: capture.billingMonth, cardKey: accountKey }
                      : {}),
                  },
                },
              ],
            },
            provider === "cal" ? calAdapter : isracardAdapter,
          );
          const rows = await db.listTransactions();
          const row =
            provider === "cal"
              ? rows[0]!
              : rows.find((item) => item.transactionDate === "2040-06-11")!;
          transactionId ??= row.id;
          expect(row.id).toBe(transactionId);
          expect(row.details.additionalInformation).toEqual(
            index === 3 ? [] : [index === 2 ? messages[1] : message],
          );
          if (provider === "cal" && index > 0) {
            expect(retained(row.details, "comments")).toContainEqual({
              value: messages[0],
            });
          }
        }
      } finally {
        await db.close();
      }
    },
  );
});
