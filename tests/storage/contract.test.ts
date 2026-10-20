import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deliverFromStore } from "../../src/application/change-delivery.js";
import {
  collectFromStore,
  type ProviderCollector,
} from "../../src/application/collection.js";
import {
  createApplication,
  publicError,
} from "../../src/application/operations.js";
import { NotFoundError } from "../../src/domain/errors.js";
import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import type { TransactionView } from "../../src/domain/read-model.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import {
  backends,
  type Harness,
  open,
  renameTransactionFixture,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`shared storage behavior: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `contract-${randomUUID()}`;
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(async () => {
      await db?.close();
    });
    const capture = (
      rows: TransactionInput[],
      adapter = synthetic,
      runId = `contract-run-${randomUUID()}`,
      context: { capturedAt?: string; scope?: CollectionScope } = {},
    ) =>
      db.ingestRun(
        {
          debugArchiveDays: 2,
          runId: `${connectionId}:${runId}`,
          connectionId,
          startedAt: "2040-08-01T00:00:00Z",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:cal/recent",
              capturedAt: context.capturedAt ?? "2040-08-01T00:00:00Z",
              responseText: JSON.stringify(rows),
              ...(context.scope && { scope: context.scope }),
            },
          ],
        },
        adapter,
      );
    const all = async () =>
      (
        await db.listTransactionPage({
          connectionId,
          limit: 200,
          includeSuperseded: true,
        })
      ).transactions;

    it("persists optional enrichment, retains sparse values and gives current facts precedence over history", async () => {
      const known = emptyDetails();
      known.merchant.city = "Current synthetic city";
      const knownPayment = {
        cardPresent: false,
        authorizationMethod: "online" as const,
        wallet: null,
      };
      known.sourceRefs = [{ runId: `${connectionId}:enriched`, path: "/0" }];
      known.provider = { synthetic: { oldSourceValue: true } };
      await capture(
        [row("enriched", { ...knownPayment, details: known })],
        synthetic,
        "enriched",
        { capturedAt: "2040-08-02T00:00:00Z" },
      );
      const initial = (await all())[0]!;
      await db.editAnnotation({
        transactionId: initial.id,
        expectedVersion: 0,
        notes: "User annotation survives enrichment",
      });
      await capture(
        [row("enriched", { amountMinor: 0 })],
        synthetic,
        "sparse",
        { capturedAt: "2040-08-03T00:00:00Z" },
      );
      const sparse = (await all())[0]!;
      expect(sparse.details.merchant.city).toBe("Current synthetic city");
      expect(sparse).toMatchObject(knownPayment);
      expect(sparse.amountMinor).toBe(0);
      expect(sparse.details.provider).toEqual({});
      const historicalDetails = emptyDetails();
      historicalDetails.merchant = {
        address: "Historical synthetic address",
        phone: "Historical synthetic phone",
        city: "Outdated synthetic city",
        countryCode: "ISR",
      };
      historicalDetails.sourceRefs = [
        { runId: `${connectionId}:history`, path: "/0" },
      ];
      await capture(
        [
          row("enriched", {
            amountMinor: -9999,
            cardPresent: true,
            authorizationMethod: "contactless",
            wallet: "apple_pay",
            details: historicalDetails,
          }),
        ],
        synthetic,
        "history",
        {
          capturedAt: "2040-08-04T00:00:00Z",
          scope: { kind: "history", month: "2040-07", cardKey: "card" },
        },
      );
      const enriched = (await all())[0]!;
      expect(enriched).toMatchObject({
        id: initial.id,
        amountMinor: 0,
        version: sparse.version + 1,
        presence: "seen",
        lastSeenRunId: sparse.lastSeenRunId,
        lastSeenAt: sparse.lastSeenAt,
      });
      expect(enriched.details.merchant).toEqual({
        ...historicalDetails.merchant,
        city: "Current synthetic city",
      });
      // Historical windows never change payment context.
      expect(enriched).toMatchObject({
        cardPresent: false,
        authorizationMethod: "online",
        wallet: null,
      });
      expect(enriched.details.sourceRefs).toEqual([
        ...known.sourceRefs,
        ...historicalDetails.sourceRefs,
      ]);
      const replacement = emptyDetails();
      replacement.merchant.city = "New current city";
      await capture(
        [
          row("enriched", {
            cardPresent: true,
            authorizationMethod: "contactless",
            details: replacement,
          }),
        ],
        synthetic,
        "replacement",
        { capturedAt: "2040-08-05T00:00:00Z" },
      );
      const latest = (await all())[0]!;
      expect(latest.details).toMatchObject({
        merchant: {
          city: "New current city",
          phone: "Historical synthetic phone",
        },
      });
      expect(latest).toMatchObject({
        cardPresent: true,
        authorizationMethod: "contactless",
        wallet: null,
      });
      expect(latest.annotation?.data.notes).toBe(
        "User annotation survives enrichment",
      );
    });

    it.each([false, true])(
      "defers native source-key conflicts only within declared partial identity groups and honors known aliases (historical first=%s)",
      async (historicalFirst) => {
        const adapter: SourceAdapter = {
          ...synthetic,
          extract(text, context) {
            const result = synthetic.extract(text, context);
            return {
              ...result,
              partitions: result.partitions.map((partition) => ({
                ...partition,
                comparable: false,
              })),
            };
          },
        };
        const details = emptyDetails();
        details.provider.cal = { identity: { baseKey: "declared-purchase" } };
        const first = row("native-first", {
          sourceAliases: ["known-alias"],
          details,
        });
        await capture(
          [first],
          adapter,
          "native-first",
          historicalFirst
            ? { scope: { kind: "history", month: "2040-07", cardKey: "card" } }
            : {},
        );
        const initial = (await all())[0]!;
        await db.editAnnotation({
          transactionId: initial.id,
          expectedVersion: 0,
          notes: "Preserved owner annotation",
        });
        const conflict = row("native-second", {
          transactionDate: "2040-07-02",
          details,
        });
        expect(
          await capture([conflict], adapter, "native-conflict"),
        ).toMatchObject({ created: 0, updated: 0, unlisted: 0 });
        expect(await all()).toHaveLength(1);
        expect((await all())[0]).toMatchObject({
          id: initial.id,
          sourceKey: initial.sourceKey,
          transactionDate: initial.transactionDate,
          amountMinor: initial.amountMinor,
          version: initial.version,
          presence: initial.presence,
          lastSeenRunId: initial.lastSeenRunId,
          annotation: { data: { notes: "Preserved owner annotation" } },
        });
        const archived = await db.raw(
          "SELECT snapshot_json FROM sync_run_bodies WHERE run_id = ?",
          [`${connectionId}:native-conflict`],
        );
        expect(
          JSON.parse(String(archived[0]!.snapshot_json)).responses[0]
            .responseText,
        ).toBe(JSON.stringify([conflict]));
        expect(
          await capture(
            [row("known-alias", { details, amountMinor: -300 })],
            adapter,
            "known-alias",
          ),
        ).toMatchObject({ created: 0, updated: 1 });
        expect((await all())[0]).toMatchObject({
          id: initial.id,
          sourceKey: "known-alias",
          amountMinor: -300,
        });
        const distinct = emptyDetails();
        distinct.provider.cal = { identity: { baseKey: "different-purchase" } };
        expect(
          await capture(
            [row("distinct-native", { details: distinct })],
            adapter,
            "distinct",
          ),
        ).toMatchObject({ created: 1 });
        expect(await all()).toHaveLength(2);
      },
    );

    it("keeps explicit recent noncomparable evidence ordered by capture time", async () => {
      const adapter: SourceAdapter = {
        ...synthetic,
        extract(text, context) {
          const result = synthetic.extract(text, context);
          return {
            ...result,
            partitions: result.partitions.map((partition) => ({
              ...partition,
              comparable: false,
            })),
          };
        },
      };
      const details = emptyDetails();
      details.merchant.city = "Newest synthetic city";
      await capture(
        [row("stable-native", { amountMinor: -500, details })],
        adapter,
        "newest-recent",
        { capturedAt: "2040-08-03T00:00:00Z", scope: { kind: "recent" } },
      );
      const initial = (await all())[0]!;
      await db.editAnnotation({
        transactionId: initial.id,
        expectedVersion: 0,
        notes: "Annotation uses newest facts",
      });
      const newest = await all();
      const outdated = emptyDetails();
      outdated.merchant.city = "Outdated synthetic city";
      await capture(
        [row("stable-native", { amountMinor: -900, details: outdated })],
        adapter,
        "outdated-recent",
        { capturedAt: "2040-08-02T00:00:00Z", scope: { kind: "recent" } },
      );
      expect(await all()).toEqual(newest);
    });

    it.each(["alias-without-base", "same-key-changed-base"] as const)(
      "preserves a newer resolved row across stale key or alias matching (%s)",
      async (variant) => {
        const adapter: SourceAdapter = {
          ...synthetic,
          extract(text, context) {
            const result = synthetic.extract(text, context);
            return {
              ...result,
              partitions: result.partitions.map((partition) => ({
                ...partition,
                comparable: false,
              })),
            };
          },
        };
        const currentDetails = emptyDetails();
        currentDetails.merchant.city = "Newest synthetic city";
        currentDetails.provider.cal = { identity: { baseKey: "B1" } };
        await capture(
          [
            row("A", {
              sourceAliases: ["K"],
              amountMinor: -500,
              details: currentDetails,
            }),
          ],
          adapter,
          "current-base",
          { capturedAt: "2040-08-03T00:00:00Z", scope: { kind: "recent" } },
        );
        const initial = (await all())[0]!;
        await db.editAnnotation({
          transactionId: initial.id,
          expectedVersion: 0,
          notes: "Preserve current owner annotation",
        });
        const current = await all();
        const staleDetails = emptyDetails();
        staleDetails.merchant.city = "Outdated synthetic city";
        if (variant === "same-key-changed-base") {
          staleDetails.provider.cal = { identity: { baseKey: "B2" } };
        }
        expect(
          await capture(
            [
              row(variant === "alias-without-base" ? "K" : "A", {
                amountMinor: -900,
                details: staleDetails,
              }),
            ],
            adapter,
            "stale-other-base",
            { capturedAt: "2040-08-02T00:00:00Z", scope: { kind: "recent" } },
          ),
        ).toMatchObject({ created: 0, updated: 0 });
        expect(await all()).toEqual(current);
      },
    );

    it("reports the latest change across the ledger and per connection", async () => {
      const before = await db.latestEventId();
      expect(await db.latestEventId(connectionId)).toBe(0);
      await capture([row("latest")]);
      const own = (await db.listEvents({ connectionId, limit: 1000 })).at(
        -1,
      )!.id;
      expect(own).toBeGreaterThan(before);
      expect(await db.latestEventId(connectionId)).toBe(own);
      const other = `${connectionId}-other`;
      await db.ensureConnection({ id: other, provider: "cal" });
      await db.ingestRun(
        {
          debugArchiveDays: 2,
          runId: `${other}:run`,
          connectionId: other,
          startedAt: "2040-08-01T00:00:00Z",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:cal/recent",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([row("latest")]),
            },
          ],
        },
        synthetic,
      );
      expect(await db.latestEventId(connectionId)).toBe(own);
      expect(await db.latestEventId(other)).toBeGreaterThan(own);
      expect(await db.latestEventId()).toBe(await db.latestEventId(other));
      // Synthetic corruption clears the foreign-key reference before deleting the row.
      // The change IDs stay intact; the row count still changes the revision.
      const latest = await db.latestEventId();
      expect(await db.ledgerRevision(connectionId)).toBe(`${latest}:1`);
      const [victim] = await all();
      await db.raw(
        "UPDATE events SET transaction_id = NULL WHERE transaction_id = ?",
        [victim!.id],
      );
      for (const table of [
        "transaction_observations",
        "transaction_reconciliation",
        "transaction_posting_links",
      ]) {
        await db.raw(`DELETE FROM ${table} WHERE transaction_id = ?`, [
          victim!.id,
        ]);
      }
      await db.raw("DELETE FROM transactions WHERE id = ?", [victim!.id]);
      expect(await db.ledgerRevision(connectionId)).toBe(`${latest}:0`);
    });

    it("keeps duplicate occurrence evidence on the same IDs after updates and reloads", async () => {
      const adapter: SourceAdapter = {
        ...synthetic,
        extract(text, context) {
          const result = synthetic.extract(text, context);
          result.transactions = result.transactions.map((value, index) => ({
            ...value,
            details: {
              ...value.details,
              sourceRefs: [{ runId: context.runId, path: `/${index}` }],
            },
          }));
          return result;
        },
      };
      const duplicate = row("weak", { identityStrength: "weak" });
      const different = row("weak", {
        identityStrength: "weak",
        amountMinor: -200,
      });
      await capture([duplicate, duplicate, different], adapter, "first");
      const before = await all();
      const first = before.find(
        (value) => value.details.sourceRefs[0]?.path === "/0",
      )!;
      const second = before.find(
        (value) => value.details.sourceRefs[0]?.path === "/1",
      )!;
      expect(
        await capture([different, duplicate, duplicate], adapter, "second"),
      ).toMatchObject({ created: 0, updated: 0 });
      expect(
        await capture([duplicate, different, duplicate], adapter, "third"),
      ).toMatchObject({ created: 0, updated: 0 });
      expect(await all()).toHaveLength(3);
      expect(
        (await db.getTransaction(first.id))?.details.sourceRefs,
      ).toContainEqual({ runId: `${connectionId}:third`, path: "/0" });
      expect(
        (await db.getTransaction(second.id))?.details.sourceRefs,
      ).toContainEqual({ runId: `${connectionId}:third`, path: "/2" });
    });

    it("cleans third-party candidate references and keeps adapter fields out of lifecycle results", async () => {
      const adapter = { ...synthetic, pendingPostingCandidates: true };
      await capture(
        [
          row("pending", { status: "pending", amountBasis: "authorization" }),
          row("posted"),
          row("another-posted"),
        ],
        adapter,
      );
      const rows = await all();
      const pending = rows.find((value) => value.sourceKey === "pending")!;
      const posted = rows.find((value) => value.sourceKey === "posted")!;
      const other = rows.find((value) => value.sourceKey === "another-posted")!;
      expect(other.pendingPostingCandidates).toEqual([pending.id]);
      const result = await db.linkPendingTransaction({
        pendingId: pending.id,
        postedId: posted.id,
        expectedPendingVersion: pending.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner confirmation",
      });
      expect(result).toMatchObject({
        id: pending.id,
        status: "posted",
        supersededById: null,
      });
      expect(result).not.toHaveProperty("ingestionOrder");
      expect(
        (await db.getTransaction(other.id))?.pendingPostingCandidates,
      ).toEqual([]);
      expect((await db.getTransaction(other.id))?.sourceIssues).not.toContain(
        "possible_pending_posted_match",
      );
      expect(await db.getTransaction(posted.id)).toMatchObject({
        supersededById: pending.id,
      });
      const removed = await db.confirmRemoval({
        transactionId: other.id,
        expectedVersion: (await db.getTransaction(other.id))!.version,
        reason: "Synthetic removal",
      });
      expect(removed).not.toHaveProperty("ingestionOrder");
    });

    it("uses UTF-8 SQL ID ordering for astral versus high-BMP keys and places null dates last", async () => {
      await capture([
        row("astral"),
        row("bmp"),
        row("undated", { transactionDate: null }),
      ]);
      // The synthetic ID-ordering setup also detaches the import references.
      await db.raw(
        "UPDATE events SET transaction_id = NULL WHERE transaction_id IN (SELECT id FROM transactions WHERE connection_id = ?)",
        [connectionId],
      );
      for (const [sourceKey, id] of [
        ["astral", "🚀"],
        ["bmp", "\uE000"],
        ["undated", "undated"],
      ]) {
        const [current] = await db.raw(
          "SELECT id FROM transactions WHERE connection_id = ? AND source_key = ?",
          [connectionId, sourceKey!],
        );
        await renameTransactionFixture(
          db,
          String(current!.id),
          `${connectionId}:${id!}`,
        );
      }
      // Keyset seeks compare IDs with the same UTF-8 byte order as ORDER BY.
      const after = (page: { transactions: TransactionView[] }) => ({
        transactionDate: page.transactions[0]!.transactionDate,
        id: page.transactions[0]!.id,
      });
      const first = await db.listTransactionPage({ connectionId, limit: 1 });
      const second = await db.listTransactionPage({
        connectionId,
        limit: 1,
        after: after(first),
      });
      const third = await db.listTransactionPage({
        connectionId,
        limit: 1,
        after: after(second),
      });
      expect([
        first.transactions[0]?.id,
        second.transactions[0]?.id,
        third.transactions[0]?.id,
      ]).toEqual([
        `${connectionId}:\uE000`,
        `${connectionId}:🚀`,
        `${connectionId}:undated`,
      ]);
      expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([
        true,
        true,
        false,
      ]);
    });

    it("keeps ingestion ordering when prior application timestamps tie", async () => {
      const failure = (runId: string) =>
        db.ingestRun(
          {
            debugArchiveDays: 2,
            runId: `${connectionId}:${runId}`,
            connectionId,
            startedAt: "2040-08-01T00:00:00Z",
            responses: [],
            failures: [
              {
                accountKey: null,
                endpoint: "collection",
                code: "network_error",
              },
            ],
          },
          synthetic,
        );
      await failure("z-first-failure");
      await capture([], synthetic, "a-second-recovery");
      await db.raw(
        "UPDATE sync_runs SET applied_at = ? WHERE connection_id = ?",
        ["2040-08-02T00:00:00.000Z", connectionId],
      );
      await failure("m-third-failure");
      const changes = await db.listEvents({ connectionId });
      expect(
        changes.filter((change) => change.type === "sync.recovered"),
      ).toHaveLength(1);
      expect(
        changes.filter((change) => change.type === "sync.failed").at(-1)
          ?.before,
      ).toEqual({ status: "completed" });
    });

    it("plans later runs from metadata without decoding prior NUL source bodies in SQL", async () => {
      const adapter: SourceAdapter = {
        ...synthetic,
        extract: () => ({
          transactions: [],
          partitions: [],
          warnings: [],
          historical: false,
        }),
      };
      const text = "actual\u0000 literal\\u0000 🚀";
      const runId = `nul-${randomUUID()}`;
      const endpoint = "synthetic:cal/recent\u0000context";
      await db.ingestRun(
        {
          debugArchiveDays: 2,
          runId,
          connectionId,
          responses: [
            {
              accountKey: "account",
              endpoint,
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: text,
            },
          ],
        },
        adapter,
      );
      await capture([row("later")]);
      const stored = await db.raw(
        "SELECT snapshot_json FROM sync_run_bodies WHERE run_id = ?",
        [runId],
      );
      expect(
        JSON.parse(String(stored[0]!.snapshot_json)).responses[0].responseText,
      ).toBe(text);
      expect(
        JSON.parse(String(stored[0]!.snapshot_json)).responses[0].endpoint,
      ).toBe(endpoint);
      if (backend === "postgres") {
        const projection = await db.raw(
          "SELECT metadata_json FROM sync_runs WHERE id = ?",
          [runId],
        );
        const metadata = JSON.parse(String(projection[0]!.metadata_json));
        expect(metadata.responses[0].endpoint).toBe(endpoint);
        expect(metadata.responses[0]).not.toHaveProperty("responseText");
      }
    });

    it("isolates scalar NUL rows across repeated collection while retaining exact source and JSON", async () => {
      await capture([row("existing")]);
      const invalid = row("invalid-scalar", {
        description: "before\u0000after",
      });
      const texts: string[] = [];
      const collector: ProviderCollector = {
        provider: "cal",
        collectorVersion: "synthetic-v1",
        async *collect() {
          for (const amountMinor of [-100, -200]) {
            const responseText = JSON.stringify([
              invalid,
              row("valid", {
                amountMinor,
                details: {
                  ...row("valid").details,
                  provider: {
                    cal: { retained: { comments: ["exact\u0000JSON"] } },
                  },
                },
              }),
            ]);
            texts.push(responseText);
            yield {
              type: "capture",
              capture: {
                accountKey: "account",
                endpoint: "synthetic:cal/recent",
                capturedAt: "2040-08-01T00:00:00Z",
                responseText,
              },
            };
          }
        },
      };
      const result = await collectFromStore(
        db,
        { connectionId, debugArchiveDays: 2 },
        collector,
        synthetic,
      );
      expect(result).toMatchObject({
        status: "partial",
        captures: 2,
        failures: 2,
        created: 1,
        updated: 1,
      });
      const rows = await all();
      expect(rows.map((value) => value.sourceKey).sort()).toEqual([
        "existing",
        "valid",
      ]);
      expect(
        rows.find((value) => value.sourceKey === "existing")?.presence,
      ).toBe("seen");
      expect(rows.find((value) => value.sourceKey === "valid")).toMatchObject({
        amountMinor: -200,
        details: {
          provider: { cal: { retained: { comments: ["exact\u0000JSON"] } } },
        },
      });
      for (const [index, runId] of result.runIds.entries()) {
        const stored = await db.raw(
          "SELECT b.snapshot_json, r.warnings_json, r.coverage_json, r.applied_at FROM sync_runs r JOIN sync_run_bodies b ON b.run_id=r.id WHERE r.id = ?",
          [runId],
        );
        expect(
          JSON.parse(String(stored[0]!.snapshot_json)).responses[0]
            .responseText,
        ).toBe(texts[index]);
        expect(JSON.parse(String(stored[0]!.warnings_json))).toContain(
          "invalid_extracted_posted_row",
        );
        expect(JSON.parse(String(stored[0]!.coverage_json))).toContainEqual(
          expect.objectContaining({
            status: "posted",
            success: false,
            comparable: false,
          }),
        );
        expect(stored[0]!.applied_at).not.toBeNull();
      }
    });

    it("exposes the same application projections and typed write errors", async () => {
      const application = createApplication(db);
      const operation = (name: string) =>
        application.operations.find((value) => value.name === name)!;
      const connections = await operation("list_connections").execute({});
      expect(connections).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ id: connectionId, provider: "cal" }),
        ]),
      });
      expect(JSON.stringify(connections)).not.toContain("config");
      expect(JSON.stringify(connections)).not.toContain("changeCursors");
      await capture([row("application")]);
      const transaction = (await all())[0]!;
      const detail = await operation("get_transaction").execute({
        transactionId: transaction.id,
      });
      expect(detail).toMatchObject({
        transaction: {
          id: transaction.id,
          merchant: { name: "Merchant" },
          amount: { currency: "ILS", amount: "-1.00" },
          connectionId,
          amountBasis: "purchase_commitment",
        },
      });
      expect(JSON.stringify(detail)).not.toContain("sourceAliases");
      expect(JSON.stringify(detail)).not.toContain("providerPaymentHistory");
      let error: unknown;
      try {
        await operation("update_annotation").execute({
          transactionId: `missing-${randomUUID()}`,
          expectedVersion: 0,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(NotFoundError);
      expect(publicError(error)).toEqual({
        code: "not_found",
        message: "Requested record was not found.",
        status: 404,
      });
    });

    it("collects through the shared store boundary and retains every overlapping capture", async () => {
      const collector: ProviderCollector = {
        provider: "cal",
        collectorVersion: "synthetic-v1",
        async *collect() {
          for (const amountMinor of [-100, -200]) {
            yield {
              type: "capture",
              capture: {
                accountKey: "account",
                endpoint: "synthetic:cal/recent",
                capturedAt: "2040-08-01T00:00:00Z",
                responseText: JSON.stringify([
                  row("overlapping", { amountMinor }),
                ]),
              },
            };
          }
        },
      };
      const result = await collectFromStore(
        db,
        { connectionId, debugArchiveDays: 2 },
        collector,
        synthetic,
      );
      expect(result).toMatchObject({
        status: "completed",
        captures: 2,
        created: 1,
        updated: 1,
      });
      expect(result.runIds).toHaveLength(2);
      expect(await all()).toHaveLength(1);
      expect((await all())[0]?.amountMinor).toBe(-200);
      expect(
        await db.raw("SELECT id FROM sync_runs WHERE connection_id = ?", [
          connectionId,
        ]),
      ).toHaveLength(2);
    });

    it("retries delivery after callback failure with stable keys and preserves configuration edits", async () => {
      await capture([row("one")]);
      const transaction = (await all())[0]!;
      await db.editAnnotation({
        transactionId: transaction.id,
        expectedVersion: 0,
        notes: "Synthetic",
      });
      const attempted: string[] = [];
      await expect(
        deliverFromStore(
          db,
          { connectionId, consumerId: "consumer" },
          async (message) => {
            attempted.push(message.deliveryKey);
            if (attempted.length === 2) {
              throw new Error("Synthetic callback failure");
            }
            await db.updateConfig(connectionId, (config) => ({
              ...config,
              preserved: "yes",
            }));
          },
        ),
      ).rejects.toThrow("Synthetic callback failure");
      const retried: string[] = [];
      const result = await deliverFromStore(
        db,
        { connectionId, consumerId: "consumer" },
        async (message) => {
          retried.push(message.deliveryKey);
        },
      );
      expect(retried[0]).toBe(attempted[1]);
      expect(result.delivered).toBe(2);
      expect(
        (await db.getStoredConnection(connectionId))?.config,
      ).toMatchObject({
        preserved: "yes",
        changeCursors: { consumer: result.cursor },
      });
    });
  });
}
