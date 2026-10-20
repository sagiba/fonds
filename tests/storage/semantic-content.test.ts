import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { presentWireEvent } from "../../src/application/wire-output.js";
import type { TransactionInput } from "../../src/domain/model.js";
import { evidenceObject } from "../../src/domain/provider-evidence.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const adapter = {
  ...synthetic,
  retainProviderEvidence: (value: Parameters<typeof evidenceObject>[0]) =>
    evidenceObject(value, {
      rows: [{ reference: "scalar", explanation: "scalar" }],
    }),
};

for (const backend of backends) {
  describe(`semantic transaction content: ${backend}`, () => {
    let db: Harness;
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
    });
    afterEach(async () => db?.close());

    function ingest(input: TransactionInput, day: number) {
      return db.ingestRun(
        {
          connectionId: "synthetic",
          runId: `semantic-${day}`,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:semantic",
              capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00Z`,
              responseText: JSON.stringify([input]),
            },
          ],
        },
        adapter,
      );
    }

    it("uses retained source content for both storage and events without leaking private values", async () => {
      const input = row("stable");
      input.details.provider = {
        cal: {
          rows: [
            {
              reference: "PRIVATE-SYNTHETIC",
              explanation: "First",
              nonce: "request-1",
            },
          ],
        },
      };
      await ingest(input, 1);
      const original = (await db.listTransactions())[0]!;
      const cursor = await db.latestEventId();
      input.details.provider.cal!.rows = [
        {
          reference: "PRIVATE-SYNTHETIC",
          explanation: "First",
          nonce: { nested: "request-2" },
        },
      ];
      expect(await ingest(input, 2)).toMatchObject({
        observed: 1,
        unchanged: 1,
        updated: 0,
      });
      const quiet = (await db.getTransaction(original.id))!;
      expect(quiet.version).toBe(original.version);
      expect(quiet.lastSeenRunId).toBe("semantic-2");
      expect(quiet.details.provider.cal).toEqual({
        rows: [{ reference: "PRIVATE-SYNTHETIC", explanation: "First" }],
      });
      expect(await db.listEvents({ after: cursor })).toEqual([]);

      input.details.provider.cal!.rows = [
        {
          reference: "PRIVATE-SYNTHETIC",
          explanation: "Corrected",
          nonce: "request-3",
        },
      ];
      expect(await ingest(input, 3)).toMatchObject({
        created: 0,
        updated: 1,
        unchanged: 0,
      });
      const current = (await db.getTransaction(original.id))!;
      expect(current.version).toBe(original.version + 1);
      const events = (await db.listEvents({ after: cursor })).filter(
        (event) => event.type === "transaction.updated",
      );
      expect(events).toHaveLength(1);
      expect(presentWireEvent(events[0]!)).toMatchObject({
        transactionId: original.id,
        changedFields: ["evidence"],
      });
      expect(JSON.stringify(presentWireEvent(events[0]!))).not.toContain(
        "PRIVATE-SYNTHETIC",
      );
      expect(JSON.stringify(events[0])).not.toContain("nonce");
      const stored = await db.raw(
        "SELECT provider_json FROM transactions WHERE id = ?",
        [original.id],
      );
      expect(JSON.parse(String(stored[0]!.provider_json))).toEqual({
        cal: {
          rows: [{ reference: "PRIVATE-SYNTHETIC", explanation: "Corrected" }],
        },
      });
      expect(await db.raw("SELECT run_id FROM sync_run_bodies")).toEqual([]);
    });

    it("versions normalized enrichment and dedicated lists while preserving annotations", async () => {
      const input = row("stable");
      await ingest(input, 1);
      const original = (await db.listTransactions())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Owner note",
      });
      const cursor = await db.latestEventId();
      input.details.merchant.phone = "Synthetic phone";
      input.details.additionalInformation = ["Meaningful explanation"];
      input.wallet = "apple_pay";
      expect(await ingest(input, 2)).toMatchObject({ updated: 1 });
      const current = (await db.getTransaction(original.id))!;
      expect(current).toMatchObject({
        version: original.version + 1,
        annotation,
        wallet: "apple_pay",
      });
      const event = (await db.listEvents({ after: cursor })).find(
        (entry) => entry.type === "transaction.updated",
      )!;
      expect(presentWireEvent(event).changedFields).toEqual(
        expect.arrayContaining([
          "merchant.phone",
          "additionalInformation",
          "wallet",
        ]),
      );
      const stored = (
        await db.raw(
          "SELECT merchant_phone, additional_information_json FROM transactions WHERE id = ?",
          [original.id],
        )
      )[0]!;
      expect(stored.merchant_phone).toBe("Synthetic phone");
      expect(JSON.parse(String(stored.additional_information_json))).toEqual([
        "Meaningful explanation",
      ]);
      expect(await ingest(input, 3)).toMatchObject({
        updated: 0,
        unchanged: 1,
      });
      expect((await db.getTransaction(original.id))!.version).toBe(
        current.version,
      );
      expect(await db.listEvents({ after: event.id })).toEqual([]);
    });

    it("ignores explanatory and issue list order without rewriting content", async () => {
      const input = row("stable");
      input.details.additionalInformation = ["Beta", "Alpha", "Alpha"];
      input.details.issues = [
        "source_derived_amount_direction",
        "unverified_amount_basis",
      ];
      await ingest(input, 1);
      const original = (await db.listTransactions())[0]!;
      const stored = await db.raw("SELECT * FROM transactions WHERE id = ?", [
        original.id,
      ]);
      const cursor = await db.latestEventId();
      input.details.additionalInformation.reverse();
      input.details.issues.reverse();
      expect(await ingest(input, 2)).toMatchObject({
        updated: 0,
        unchanged: 1,
      });
      expect(
        await db.raw("SELECT * FROM transactions WHERE id = ?", [original.id]),
      ).toEqual(stored);
      expect(
        (await db.getTransaction(original.id))!.details.additionalInformation,
      ).toEqual(["Alpha", "Alpha", "Beta"]);
      expect(await db.listEvents({ after: cursor })).toEqual([]);
    });

    it("versions a related transaction when an owner action resolves its source issue", async () => {
      const first = row("plan-a", {
        amountBasis: "purchase_commitment",
        installmentCount: 3,
        cardKey: "card",
      });
      const second = { ...structuredClone(first), sourceKey: "plan-b" };
      await db.ingestRun(
        {
          connectionId: "synthetic",
          runId: "duplicate-plans",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:semantic",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([first, second]),
            },
          ],
        },
        adapter,
      );
      const [removed, survivor] = await db.listTransactions();
      expect(survivor!.details.issues).toContain("possible_duplicate_plan");
      const annotation = await db.editAnnotation({
        transactionId: survivor!.id,
        expectedVersion: 0,
        notes: "Keep owner decision",
      });
      const cursor = await db.latestEventId();
      await db.confirmRemoval({
        transactionId: removed!.id,
        expectedVersion: removed!.version,
        reason: "Owner checked duplicate",
        actor: "owner",
      });
      const current = (await db.getTransaction(survivor!.id))!;
      expect(current.details.issues).not.toContain("possible_duplicate_plan");
      expect(current.version).toBe(survivor!.version + 1);
      expect(current.annotation).toEqual(annotation);
      const update = (await db.listEvents({ after: cursor })).find(
        (event) =>
          event.transactionId === survivor!.id &&
          event.type === "transaction.updated",
      );
      expect(update).toMatchObject({ actor: "owner", runId: null });
      expect(presentWireEvent(update!).changedFields).toEqual([
        "review.sourceIssues",
      ]);
    });

    it("keeps whole-run empty rejection free of deferred evidence from other responses", async () => {
      await ingest(row("known"), 1);
      const before = await db.listTransactions();
      const cursor = await db.latestEventId();
      const invalid = row("invalid", { amountMinor: 1.5 });
      invalid.details.provider = { cal: { rows: [{ reference: "declared" }] } };
      const result = await db.ingestRun(
        {
          runId: "reject-whole-run",
          connectionId: "synthetic",
          responses: [
            {
              accountKey: "other",
              endpoint: "synthetic",
              capturedAt: "2040-08-02T00:00:00Z",
              responseText: JSON.stringify([invalid]),
            },
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: "2040-08-02T00:00:00Z",
              responseText: "[]",
            },
          ],
        },
        { ...adapter, rejectEmptyRecentPosted: true },
      );
      expect(result).toMatchObject({
        status: "failed",
        failureCode: "implausible_empty",
      });
      expect(await db.raw("SELECT * FROM deferred_evidence")).toEqual([]);
      expect(await db.listTransactions()).toEqual(before);
      expect(await db.listEvents({ after: cursor })).toEqual([]);
    });

    it("retains declared rejected evidence once without keeping raw bodies", async () => {
      const input = row("invalid", {
        merchantName: "Invalid\u0000canonical text",
      });
      input.details.provider = {
        cal: {
          rows: [
            {
              reference: "Rejected source",
              explanation: "Known evidence",
              nonce: "discard",
            },
          ],
        },
      };
      expect(await ingest(input, 1)).toMatchObject({
        status: "partial",
        created: 0,
      });
      expect(await ingest(input, 2)).toMatchObject({
        status: "partial",
        created: 0,
      });
      expect(await db.listTransactions()).toEqual([]);
      const evidence = await db.raw(
        "SELECT content_json, first_seen_run_id, last_seen_run_id FROM deferred_evidence",
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        first_seen_run_id: "semantic-1",
        last_seen_run_id: "semantic-2",
      });
      expect(JSON.parse(String(evidence[0]!.content_json))).toEqual({
        providerEvidence: {
          rows: [
            { reference: "Rejected source", explanation: "Known evidence" },
          ],
        },
      });
      expect(await db.raw("SELECT run_id FROM sync_run_bodies")).toEqual([]);
    });

    it("deduplicates deferred evidence for a card that has not been discovered", async () => {
      const source = {
        ...adapter,
        projectProviderState: (value: Parameters<typeof evidenceObject>[0]) =>
          evidenceObject(value, {
            identity: {
              baseKey: "scalar",
              occurrenceCount: "scalar",
              currentRows: ["scalar"],
            },
          }),
        extract: (...args: Parameters<typeof synthetic.extract>) => {
          const result = synthetic.extract(...args);
          if (args[1].runId !== "known-card") {
            result.partitions.forEach((part) => {
              part.success = false;
              part.comparable = false;
            });
          }
          return result;
        },
      };
      const input = row("native-original", {
        cardKey: "known-card",
        identityStrength: "native",
      });
      input.details.provider = {
        cal: {
          rows: [{ reference: "Declared component" }],
          identity: { baseKey: "source-family", occurrenceCount: 1 },
        },
      };
      const capture = (runId: string, day: number) =>
        db.ingestRun(
          {
            connectionId: "synthetic",
            runId,
            responses: [
              {
                accountKey: "account",
                endpoint: "synthetic:semantic",
                capturedAt: `2040-08-0${day}T00:00:00Z`,
                responseText: JSON.stringify([input]),
              },
            ],
          },
          source,
        );
      await capture("known-card", 1);
      input.sourceKey = "native-replacement";
      input.cardKey = "undiscovered-card";
      expect(await capture("partial-2", 2)).toMatchObject({
        created: 0,
        updated: 0,
      });
      expect(await capture("partial-3", 3)).toMatchObject({
        created: 0,
        updated: 0,
      });
      const evidence = await db.raw(
        "SELECT content_json, first_seen_run_id, last_seen_run_id FROM deferred_evidence",
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        first_seen_run_id: "partial-2",
        last_seen_run_id: "partial-3",
      });
      expect(JSON.parse(String(evidence[0]!.content_json))).toMatchObject({
        cardKey: "undiscovered-card",
      });
      expect(JSON.parse(String(evidence[0]!.content_json))).not.toHaveProperty(
        "cardId",
      );
    });

    it("logs extraction failure safely and keeps staged evidence for recovery", async () => {
      const input = {
        connectionId: "synthetic",
        runId: "33f2801e-7bed-4e94-9b03-e694258a2a10",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:semantic",
            capturedAt: "2040-08-01T00:00:00Z",
            responseText: JSON.stringify([row("stable")]),
          },
        ],
      };
      const entries: unknown[] = [];
      const broken = {
        ...adapter,
        extract: () => {
          throw new Error("SYNTHETIC-PRIVATE-ERROR");
        },
      };
      await expect(
        db.ingestRun(input, broken, (entry) => entries.push(entry)),
      ).rejects.toThrow("SYNTHETIC-PRIVATE-ERROR");
      expect(entries).toContainEqual(
        expect.objectContaining({
          stage: "extraction",
          outcome: "failed",
          failureCategory: "invalid_response",
        }),
      );
      expect(JSON.stringify(entries)).not.toContain("SYNTHETIC-PRIVATE-ERROR");
      expect(await db.raw("SELECT retention FROM sync_run_bodies")).toEqual([
        { retention: "staged" },
      ]);
      expect(await db.ingestRun(input, adapter)).toMatchObject({ created: 1 });
      expect(await db.raw("SELECT run_id FROM sync_run_bodies")).toEqual([]);
    });
  });
}
