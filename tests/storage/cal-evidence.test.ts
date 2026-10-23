import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { presentWireEvent } from "../../src/application/wire-output.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { backends, type Harness, open } from "../helpers/storage-harness.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
    "utf8",
  ),
);
const posted = fixture.result.transactions.find(
  (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
);
const pending = fixture.result.clearanceRequests[0];
const connectionId = "synthetic-cal-evidence";

describe.each(backends)("%s CAL semantic evidence", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(async () => db?.close());

  it.each(["posted", "pending"] as const)(
    "retains %s semantic evidence while ignored refresh metadata stays quiet",
    async (status) => {
      const facts = {
        branchCodeDesc: "Synthetic category",
        superBranchDesc: null,
        transSource: "SYNTHETIC-ORIGIN",
        transMahut: "SYNTHETIC-NATURE",
        crdExtIdNumTypeCode: "SYNTHETIC-TYPE",
        walletTokenInd: 1,
        foreignCurrencyWalletType: 0,
        isCashBackTransaction: false,
        isImmediateHHKInd: false,
        isSpreadPaymenstAbroadInd: false,
        firstPaymentAmount: 0,
        tpaApprovalAmount: null,
        transactionsOrigin: "SYNTHETIC-PENDING-ORIGIN",
        j5Indicator: "SYNTHETIC-AUTHORIZATION-MARKER",
      };
      const noise = (revision: number) => ({
        tokenNumber: `SYNTHETIC-TOKEN-${revision}`,
        tokenNumberPart4: String(9000 + revision),
        trnNumaretor: revision,
        isImmediateCommentInd: revision % 2 === 0,
        isMargaritaInd: revision % 2 === 0,
        requestTimestamp: `2040-07-0${revision}T12:00:00Z`,
        undeclared: { revision },
      });
      const ingest = (day: number, fields: Record<string, unknown>) =>
        db.ingestRun(
          {
            connectionId,
            runId: `synthetic-cal-evidence-${day}`,
            responses: [
              {
                accountKey: "synthetic-account",
                endpoint: "synthetic:cal/recent",
                capturedAt: `2040-07-${String(day).padStart(2, "0")}T12:00:00Z`,
                responseText: JSON.stringify({
                  statusCode: 1,
                  result: {
                    transactions:
                      status === "posted" ? [{ ...posted, ...fields }] : [],
                    clearanceRequests:
                      status === "pending" ? [{ ...pending, ...fields }] : [],
                  },
                }),
              },
            ],
          },
          calAdapter,
        );
      await ingest(1, { ...facts, ...noise(1) });
      const original = (await db.listTransactions({ perspective: "all" }))[0]!;
      const annotation = await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Synthetic retained annotation",
      });
      const cursor = await db.latestEventId();
      const stored = await db.raw("SELECT * FROM transactions WHERE id = ?", [
        original.id,
      ]);
      const evidence = JSON.parse(String(stored[0]!.provider_json)).cal.rows[0];
      expect(evidence).toMatchObject({
        ...facts,
        walletTokenInd: "1",
        foreignCurrencyWalletType: "0",
        firstPaymentAmount: "0",
      });
      for (const key of Object.keys(noise(1))) {
        expect(evidence).not.toHaveProperty(key);
      }
      expect(await db.raw("SELECT run_id FROM sync_run_bodies")).toEqual([]);
      for (const day of [2, 3]) {
        expect(await ingest(day, { ...facts, ...noise(day) })).toMatchObject({
          created: 0,
          updated: 0,
          unchanged: 1,
        });
        expect(
          await db.raw("SELECT * FROM transactions WHERE id = ?", [
            original.id,
          ]),
        ).toEqual(stored);
        expect(await db.listEvents({ after: cursor })).toEqual([]);
      }
      const corrected = { ...facts, transMahut: "SYNTHETIC-CORRECTED-NATURE" };
      expect(await ingest(4, { ...corrected, ...noise(4) })).toMatchObject({
        created: 0,
        updated: 1,
      });
      const current = (await db.getTransaction(original.id))!;
      expect(current).toMatchObject({
        id: original.id,
        status: original.status,
        kind: original.kind,
        amountMinor: original.amountMinor,
        currency: original.currency,
        version: original.version + 1,
        annotation,
      });
      expect(current.details.provider.cal!.rows).toEqual([
        expect.objectContaining({ transMahut: corrected.transMahut }),
      ]);
      const events = await db.listEvents({ after: cursor });
      expect(events).toHaveLength(1);
      expect(presentWireEvent(events[0]!)).toMatchObject({
        type: "transaction.updated",
        changedFields: ["evidence"],
      });
      expect(JSON.stringify(presentWireEvent(events[0]!))).not.toContain(
        corrected.transMahut,
      );
      const correctedStored = await db.raw(
        "SELECT * FROM transactions WHERE id = ?",
        [original.id],
      );
      for (const day of [5, 6]) {
        expect(
          await ingest(day, { ...corrected, ...noise(day) }),
        ).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
        expect(
          await db.raw("SELECT * FROM transactions WHERE id = ?", [
            original.id,
          ]),
        ).toEqual(correctedStored);
        expect(await db.listEvents({ after: cursor })).toEqual(events);
      }
    },
  );
});
