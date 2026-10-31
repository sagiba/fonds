import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`compact financial corrections: ${backend}`, () => {
    let db: Harness;

    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
    });

    afterEach(async () => db?.close());

    async function capture(input: TransactionInput, day: number) {
      return db.ingestRun(
        {
          debugArchiveDays: 2,
          connectionId: "synthetic",
          runId: `correction-${day}`,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:correction",
              capturedAt: `2040-08-0${day}T00:00:00Z`,
              responseText: JSON.stringify([input]),
            },
          ],
        },
        synthetic,
      );
    }

    it.each([
      ["description", "Corrected source description"],
      ["counterpartyName", "Corrected unknown-role counterparty"],
    ] as const)(
      "makes a %s correction discoverable without changing owner annotations",
      async (field, correctedValue) => {
        const input = row("stable", {
          cardKey: null,
          merchantName: null,
          counterpartyName: "Original unknown-role counterparty",
          kind: "fee",
          amountBasis: "booked_entry",
        });
        await capture(input, 1);
        const original = (await db.listTransactions())[0]!;
        const annotation = await db.editAnnotation({
          transactionId: original.id,
          expectedVersion: 0,
          expectedTransactionVersion: original.version,
          notes: "Independent owner note",
          category: "Owner category",
          review: { status: "approved" },
        });
        const cursor = await db.latestEventId();
        const correctedInput = { ...input, [field]: correctedValue };
        expect(await capture(correctedInput, 2)).toMatchObject({
          created: 0,
          updated: 1,
          unlisted: 0,
        });
        expect(await db.getTransaction(original.id)).toMatchObject({
          [field]: correctedValue,
          version: original.version + 1,
          annotation,
          reviewStale: false,
          reviewStatus: "approved",
        });
        const changes = await db.listEvents({ after: cursor });
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
          transactionId: original.id,
          runId: "correction-2",
          type: "transaction.updated",
          before: { [field]: input[field] },
          after: { [field]: correctedValue },
        });
        const archived = await db.raw(
          "SELECT snapshot_json FROM sync_run_bodies WHERE run_id = ?",
          ["correction-2"],
        );
        expect(
          JSON.parse(String(archived[0]!.snapshot_json)).responses[0]
            .responseText,
        ).toBe(JSON.stringify([correctedInput]));
        expect(await capture(correctedInput, 2)).toMatchObject({
          replayed: true,
          updated: 0,
        });
        expect(await capture(correctedInput, 3)).toMatchObject({
          replayed: false,
          updated: 0,
        });
        expect(await db.listEvents({ after: changes[0]!.id })).toEqual([]);

        const diagnosticInput = structuredClone(correctedInput);
        diagnosticInput.details.merchant.phone = "Synthetic corrected phone";
        // Mapped enrichment follows the same version and event rule as money.
        diagnosticInput.wallet = "apple_pay";
        diagnosticInput.authorizationMethod = "contactless";
        expect(await capture(diagnosticInput, 4)).toMatchObject({ updated: 1 });
        expect(await db.listEvents({ after: changes[0]!.id })).toMatchObject([
          {
            type: "transaction.updated",
            transactionId: original.id,
            before: {
              merchantPhone: null,
              wallet: null,
              authorizationMethod: null,
            },
            after: {
              merchantPhone: "Synthetic corrected phone",
              wallet: "apple_pay",
              authorizationMethod: "contactless",
            },
          },
        ]);
        expect(await db.getTransaction(original.id)).toMatchObject({
          version: original.version + 2,
          lastSeenRunId: "correction-4",
          annotation,
          wallet: "apple_pay",
          authorizationMethod: "contactless",
          details: {
            merchant: { phone: "Synthetic corrected phone" },
          },
        });
      },
    );
  });
}
