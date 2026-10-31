import "../helpers/application-loading-differential.js";

import { describe, expect, it } from "vitest";

import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { authorization, postingHarness } from "../helpers/posting.js";
import {
  backends,
  fixture,
  insertTransactionFixture,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`${backend} owner-retained evidence`, () => {
    it("rejects an adapter missing its retention declaration before writing canonical records", async () => {
      const db = await open(backend);
      try {
        await db.ensureConnection({ id: "undeclared", provider: "cal" });
        const input = row("purchase");
        input.details.provider = {
          cal: { unknown: { nested: "undeclared source value" } },
        };
        const undeclared = {
          ...synthetic,
          retainProviderEvidence: undefined,
        } as unknown as SourceAdapter;
        await expect(
          db.ingestRun(
            {
              connectionId: "undeclared",
              runId: "undeclared-source",
              responses: [
                {
                  accountKey: "account",
                  endpoint: "synthetic",
                  capturedAt: "2040-07-01T00:00:00.000Z",
                  responseText: JSON.stringify([input]),
                },
              ],
            },
            undeclared,
          ),
        ).rejects.toThrow();
        const [stored] = await db.raw(
          "SELECT count(*) AS count FROM transactions",
        );
        expect(Number(stored!.count)).toBe(0);
        const [receipts] = await db.raw(
          "SELECT count(*) AS count FROM sync_runs",
        );
        expect(Number(receipts!.count)).toBe(0);
        expect(await db.listEvents()).toEqual([]);
      } finally {
        await db.close();
      }
    });
    it.each(["pending", "posted"] as const)(
      "keeps missing legacy %s source evidence independent across owner link and unlink",
      async (legacySide) => {
        const db = await open(backend);
        try {
          const harness = postingHarness(db);
          await db.ensureConnection({
            id: harness.connectionId,
            provider: "cal",
          });
          await harness.capture(1, [authorization(), row("posted")]);
          const pending = await harness.byKey("pending");
          const posted = await harness.byKey("posted");
          const legacy = legacySide === "pending" ? pending : posted;
          await insertTransactionFixture(
            db,
            [{ ...legacy, sourceEvidence: undefined }],
            "update",
          );
          const expectedPending =
            legacySide === "pending" ? undefined : pending.sourceEvidence;
          const expectedPosted =
            legacySide === "posted" ? undefined : posted.sourceEvidence;
          await db.linkPendingTransaction(
            await harness.command(pending.id, posted.id),
          );
          const linked = (await db.getTransaction(pending.id))!;
          expect(linked.sourceEvidence).toEqual(expectedPosted);
          expect(linked.details.postingLink!.pending.sourceEvidence).toEqual(
            expectedPending,
          );
          await db.unlinkPendingTransaction(
            await harness.command(pending.id, posted.id),
          );
          expect((await db.getTransaction(pending.id))!.sourceEvidence).toEqual(
            expectedPending,
          );
          expect((await db.getTransaction(posted.id))!.sourceEvidence).toEqual(
            expectedPosted,
          );
        } finally {
          await db.close();
        }
      },
    );

    it("keeps canonical provider lists after linking so the same posted reread writes observations only", async () => {
      const db = await open(backend);
      try {
        await db.ensureConnection({ id: "owner-evidence", provider: "cal" });
        const source = JSON.parse(fixture("recent-01")) as {
          result: { transactions: Record<string, unknown>[] };
        };
        const posted = {
          ...source.result.transactions[0],
          cardUniqueId: "SYNTHETIC-CARD",
          trnIntId: "SYNTHETIC-POSTED",
          merchantName: "Synthetic shop",
          trnPurchaseDate: "2040-06-11T12:00:00",
          amountForDisplay: 10,
          trnAmt: 10,
          transCardPresentInd: false,
          comments: [{ key: "A posted note", value: "one" }],
          paymentsMade: [
            { date: "2040-07-02", num: "P2", amount: 2, currency: "ILS" },
          ],
        };
        const pending = {
          cardUniqueID: "SYNTHETIC-CARD",
          transactionID: "SYNTHETIC-PENDING",
          merchantName: "Synthetic shop",
          trnPurchaseDate: "2040-06-11T12:00:00",
          trnAmt: 10,
          trnCurrencySymbol: "₪",
          trnTypeCode: 5,
          trnType: "רגילה",
          internationalBranchID: "5411",
          transCardPresentInd: false,
          walletTranInd: 0,
          numberOfPayments: 0,
          comments: [{ key: "Z pending note", value: "two" }],
          paymentsMade: [
            { date: "2040-07-01", num: "P1", amount: 1, currency: "ILS" },
          ],
        };
        const ingest = (
          day: number,
          includePosted: boolean,
          includePending: boolean,
        ) =>
          db.ingestRun(
            {
              connectionId: "owner-evidence",
              runId: `owner-evidence-${day}`,
              responses: [
                {
                  accountKey: "account",
                  endpoint: "synthetic:cal/recent",
                  capturedAt: `2040-06-${11 + day}T12:00:00.000Z`,
                  responseText: JSON.stringify({
                    statusCode: 1,
                    result: {
                      transactions: includePosted ? [posted] : [],
                      clearanceRequests: includePending ? [pending] : [],
                    },
                  }),
                },
              ],
            },
            calAdapter,
          );
        await ingest(1, false, true);
        await ingest(2, true, true);
        const authorization = (
          await db.listTransactions({ status: "pending" })
        )[0]!;
        const purchase = (await db.listTransactions({ status: "posted" }))[0]!;
        const annotation = await db.editAnnotation({
          transactionId: authorization.id,
          expectedVersion: 0,
          notes: "Retain this owner note",
        });
        await db.linkPendingTransaction({
          pendingId: authorization.id,
          postedId: purchase.id,
          expectedPendingVersion: authorization.version,
          expectedPostedVersion: purchase.version,
          expectedPendingAnnotationVersion: annotation.version,
          expectedPostedAnnotationVersion: 0,
          reason: "Owner confirmed the posting",
        });
        const linked = (await db.getTransaction(authorization.id))!;
        expect(
          (linked.details.provider.cal!.retained as { comments: unknown[] })
            .comments,
        ).toEqual([
          { key: "A posted note", value: "one" },
          { key: "Z pending note", value: "two" },
        ]);
        expect(linked.sourceEvidence).toEqual(purchase.sourceEvidence);
        expect(linked.details.postingLink!.pending.sourceEvidence).toEqual(
          authorization.sourceEvidence,
        );
        // The first omission changes the component restored by unlink. Only
        // subsequent identical captures are observation-only rereads.
        expect(await ingest(3, true, false)).toMatchObject({
          created: 0,
          updated: 1,
          unlisted: 0,
        });
        const absent = (await db.getTransaction(authorization.id))!;
        expect(absent).toMatchObject({
          version: linked.version + 1,
          details: {
            postingLink: {
              pending: {
                presence: "not_returned",
                sourceAbsence: { runId: "owner-evidence-3" },
              },
            },
          },
        });
        const before = await db.raw("SELECT * FROM transactions ORDER BY id");
        const cursor = await db.latestEventId();
        if (backend === "postgres") {
          await db.raw(
            "CREATE FUNCTION reject_canonical_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected canonical transaction write'; END $$",
          );
          await db.raw(
            "CREATE TRIGGER reject_canonical_write BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION reject_canonical_write()",
          );
        } else {
          await db.raw(
            "CREATE TRIGGER reject_canonical_write BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT, 'unexpected canonical transaction write'); END",
          );
        }
        expect(await ingest(4, true, false)).toMatchObject({
          created: 0,
          updated: 0,
          unlisted: 0,
        });
        expect(await db.raw("SELECT * FROM transactions ORDER BY id")).toEqual(
          before,
        );
        expect(await db.getTransaction(authorization.id)).toMatchObject({
          status: "posted",
          version: absent.version,
          amountMinor: linked.amountMinor,
          annotation,
          lastSeenRunId: "owner-evidence-4",
        });
        expect(
          (await db.listEvents({ after: cursor })).filter((event) =>
            event.type.startsWith("transaction."),
          ),
        ).toEqual([]);
      } finally {
        await db.close();
      }
    });
  });
}
