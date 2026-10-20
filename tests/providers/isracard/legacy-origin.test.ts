import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../../src/domain/model.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCaptureContext,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";
import { updateTransaction } from "../../helpers/sqlite-transactions.js";

function legacyJson(value: unknown): JsonValue {
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(legacyJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, legacyJson(item)]),
    );
  }
  return value as null | string | boolean;
}

describe("legacy Isracard source origins", () => {
  it.each(["digital", "legacy"] as const)(
    "keeps %s evidence and annotations quiet after unknown opposite-family fields were archived",
    async (origin) => {
      const capture = JSON.parse(
        readFileSync(
          new URL("./fixtures/card-month.json", import.meta.url),
          "utf8",
        ),
      ) as IsracardCapture;
      const digital = JSON.parse(capture.responses.digital!) as {
        data: {
          israelAbroadVouchers: {
            vouchers: { israelAbroadVouchersList: JsonObject[] };
          };
        };
      };
      const legacy = JSON.parse(capture.responses.legacy!) as {
        CardsTransactionsListBean: {
          Index0: { CurrentCardTransactions: { txnIsrael: JsonObject[] }[] };
        };
      };
      const digitalRow =
        digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0]!;
      const legacyRow =
        legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!
          .txnIsrael[0]!;
      if (origin === "digital") {
        digitalRow.voucherNumberRatz = "UNDECLARED-SOURCE-NOISE";
      } else {
        legacyRow.seqVoucherNumber = "UNDECLARED-SOURCE-NOISE";
      }
      capture.responses.digital = JSON.stringify(digital);
      capture.responses.legacy = JSON.stringify(legacy);
      const responseText = serializeIsracardCapture(capture);
      const db = await openDatabase(":memory:");
      try {
        await db.ensureConnection({ id: "synthetic", provider: "isracard" });
        const ingest = (day: number) =>
          db.ingestRun(
            {
              connectionId: "synthetic",
              runId: `origin-${day}`,
              responses: [
                {
                  ...isracardCaptureContext(responseText),
                  responseText,
                  capturedAt: `2040-08-0${day}T00:00:00.000Z`,
                },
              ],
            },
            isracardAdapter,
          );
        await ingest(1);
        const original = (await db.listTransactions()).find(
          (row) => row.merchantName === "Synthetic merchant",
        )!;
        expect(original).toMatchObject({
          kind: "purchase",
          amountMinor: -8640,
          currency: "ILS",
        });
        const namespace = original.details.provider.isracard!;
        const originalEvidence = namespace.rows;
        const annotation = await db.editAnnotation({
          transactionId: original.id,
          expectedVersion: 0,
          notes: "Preserve the synthetic owner note",
        });
        const { currentRows: _selector, ...identity } =
          namespace.identity as JsonObject;
        const digitalCopy = legacyJson(digitalRow);
        const legacyCopy = legacyJson(legacyRow);
        await updateTransaction(db.orm, original.id, {
          details: {
            ...original.details,
            provider: {
              isracard: {
                ...namespace,
                identity,
                rows: [digitalCopy, legacyCopy],
                observations: [
                  {
                    generation: "legacy",
                    path: "synthetic-legacy-origin",
                    row: legacyCopy,
                  },
                  {
                    generation: "digital",
                    path: "synthetic-digital-origin",
                    row: digitalCopy,
                  },
                ],
              },
            },
          },
        });
        const cursor = await db.latestEventId();
        for (const day of [2, 3]) {
          expect(await ingest(day)).toMatchObject({
            created: 0,
            updated: 0,
            unchanged: 2,
          });
          const current = (await db.getTransaction(original.id))!;
          expect(current).toMatchObject({
            id: original.id,
            version: original.version,
            kind: "purchase",
            amountMinor: -8640,
            currency: "ILS",
            annotation,
          });
          expect(current.details.provider.isracard!.rows).toEqual(
            originalEvidence,
          );
          expect(
            JSON.stringify(current.details.provider.isracard),
          ).not.toContain("UNDECLARED-SOURCE-NOISE");
        }
        expect(await db.listEvents({ after: cursor })).toEqual([]);
      } finally {
        await db.close();
      }
    },
  );
});
