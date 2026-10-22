import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emptyDetails,
  type JsonObject,
  type JsonValue,
  type TransactionInput,
} from "../../src/domain/model.js";
import {
  currentSourceRowIndices,
  currentSourceRows,
  evidenceList,
  evidenceObject,
  mergeDeclaredEvidence,
} from "../../src/domain/provider-evidence.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { Run } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { normalizeCalSearchFilters } from "../../src/providers/cal/search.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
} from "../helpers/storage-harness.js";

const accountKey = "synthetic-account";

function entry(
  sourceKey: string,
  overrides: Partial<TransactionInput> = {},
): TransactionInput {
  return {
    sourceScope: accountKey,
    cardKey: "synthetic-card",
    sourceKey,
    sourceAliases: [],
    identityStrength: "native",
    status: "posted",
    description: "Synthetic purchase",
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Synthetic merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate: "2040-01-01",
    bookingDate: null,
    billingDate: null,
    amountMinor: -1000,
    currency: "EUR",
    amountBasis: "booked_entry",
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: null,
    details: emptyDetails(),
    ...overrides,
  };
}

function bankAdapter(overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    provider: "synthetic-bank",
    parserVersion: "synthetic-v1",
    retainProviderEvidence: () => ({}),
    projectProviderState: (value) =>
      evidenceObject(value, {
        identity: {
          baseKey: "scalar",
          occurrenceCount: "scalar",
          currentRows: ["scalar"],
        },
      }),
    extract(raw, context) {
      return {
        transactions: (JSON.parse(raw) as TransactionInput[]).map(
          (input, index) => ({
            ...input,
            sourceScope: context.accountKey,
            details: {
              ...input.details,
              sourceRefs: [{ runId: context.runId, path: `/${index}` }],
            },
          }),
        ),
        partitions: (["posted", "pending"] as const).map((status) => ({
          accountKey: context.accountKey,
          status,
          success: true,
          comparable: true,
        })),
        historical: false,
        warnings: [],
      };
    },
    ...overrides,
  };
}

for (const backend of backends) {
  describe(`reconciliation indexes and provider boundaries: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `reconciliation-index-${randomUUID()}`;
      await db.ensureConnection({
        id: connectionId,
        provider: "synthetic-bank",
      });
    });
    afterEach(() => db?.close());

    async function readRuns(id?: string) {
      const rows = await db.raw(
        `SELECT * FROM sync_runs ${id === undefined ? "" : "WHERE id = ?"} ORDER BY ${backend === "postgres" ? "ingestion_order" : "rowid"}`,
        id === undefined ? [] : [id],
      );
      return rows.map((row) => ({
        ...row,
        id: String(row.id),
        status: String(row.status),
        appliedAt: row.applied_at,
        parserVersion: String(row.parser_version),
        collectorVersion: String(row.collector_version),
        snapshot: JSON.parse(String(row.metadata_json)) as Omit<
          Run["snapshot"],
          "responses"
        > & {
          responses: Omit<
            Run["snapshot"]["responses"][number],
            "responseText"
          >[];
        },
        coverage: JSON.parse(String(row.coverage_json)) as Run["coverage"],
        warnings: JSON.parse(String(row.warnings_json)) as string[],
      }));
    }

    async function readRun(id?: string) {
      return (await readRuns(id))[0];
    }

    async function capture(
      runId: string,
      inputs: TransactionInput[],
      adapter = bankAdapter(),
      scope?: CollectionScope,
      capturedAt = "2040-02-01T00:00:00Z",
    ) {
      return await db.ingestRun(
        {
          runId,
          connectionId,
          responses: [
            {
              accountKey,
              endpoint: "synthetic-bank/entries",
              capturedAt,
              responseText: JSON.stringify(inputs),
              ...(scope ? { scope } : {}),
            },
          ],
        },
        adapter,
      );
    }

    const rows = () => db.listTransactions({ includeSuperseded: true });

    it("retains month-scoped pending absence and health across rollover while native reobservations keep their ID", async () => {
      const july: CollectionScope = {
        kind: "recent",
        month: "2040-07",
        cardKey: "synthetic-card",
      };
      const august: CollectionScope = { ...july, month: "2040-08" };
      const authorization = entry("authorization", {
        status: "pending",
        amountBasis: "authorization",
      });
      await capture(
        "july",
        [authorization],
        bankAdapter(),
        july,
        "2040-07-02T00:00:00Z",
      );
      const original = (await rows())[0]!;
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Owner's authorization note",
      });
      const base = bankAdapter();
      const failed = bankAdapter({
        extract(raw, context) {
          const result = base.extract(raw, context);
          for (const part of result.partitions) {
            part.success = false;
            part.comparable = false;
          }
          return result;
        },
      });
      await capture("july-failure", [], failed, july, "2040-07-03T00:00:00Z");
      await capture(
        "august-empty",
        [],
        bankAdapter(),
        august,
        "2040-08-02T00:00:00Z",
      );
      expect((await rows())[0]).toMatchObject({
        id: original.id,
        presence: "seen",
        lastSeenRunId: "july",
      });
      expect(
        (await db.listEvents()).filter(
          (event) => event.type === "sync.recovered",
        ),
      ).toEqual([]);
      await capture(
        "august-reobserved",
        [authorization],
        bankAdapter(),
        august,
        "2040-08-03T00:00:00Z",
      );
      expect(await db.getTransaction(original.id)).toMatchObject({
        id: original.id,
        lastSeenRunId: "august-reobserved",
        annotation: { data: { notes: "Owner's authorization note" } },
      });
      await capture(
        "july-recovery",
        [],
        bankAdapter(),
        july,
        "2040-08-04T00:00:00Z",
      );
      const recovered = (await db.listEvents()).filter(
        (event) => event.type === "sync.recovered",
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        runId: "july-recovery",
        after: { failedScopes: [] },
      });
    });

    it.each([
      ["+99 999 9999999", null],
      ["https://merchant.example", null],
      ["www.merchant.example", null],
      ["contact@merchant.example", null],
      ["SHOP.EXAMPLE.COM", null],
      ["shop.example.com/bill", null],
      ["St.Louis", "St.Louis"],
      ["Synthetic city", "Synthetic city"],
    ])(
      "restores a stored merchant city %j through a sparse read only when it names a place",
      async (city, expected) => {
        const details = emptyDetails();
        details.merchant = { ...details.merchant, city };
        await capture("enriched", [entry("entry", { details })]);
        await capture("sparse", [entry("entry")]);
        expect((await rows())[0]!.details.merchant.city ?? null).toBe(expected);
      },
    );

    it("retains known merchant/payment enrichment through sparse reads and accepts newer explicit values", async () => {
      const details = emptyDetails();
      details.merchant = {
        address: "Synthetic address",
        phone: "Synthetic phone",
        city: "Synthetic city",
        countryCode: "ISR",
      };
      const payment = {
        cardPresent: true,
        authorizationMethod: "online" as const,
        wallet: "apple_pay" as const,
        threeDSecureUsed: true,
        recurring: true,
      };
      details.provider = { "synthetic-bank": { retainedOnlyInArchive: true } };
      await capture("enriched", [entry("entry", { ...payment, details })]);
      const original = (await rows())[0]!;
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "User-owned note",
      });
      await capture("sparse", [
        entry("entry", { amountMinor: 0, installmentCount: 0 }),
      ]);
      const sparse = (await rows())[0]!;
      expect(sparse.details.merchant).toEqual(details.merchant);
      expect(sparse).toMatchObject(payment);
      expect(sparse.details.provider).toEqual({});
      expect(sparse.amountMinor).toBe(0);
      expect(sparse.installmentCount).toBe(0);
      expect(sparse.details.sourceRefs.map((ref) => ref.runId)).toEqual([
        "sparse",
      ]);
      const replacement = emptyDetails();
      replacement.merchant = {
        address: null,
        phone: null,
        city: "New city",
        countryCode: null,
      };
      await capture("replacement", [
        entry("entry", {
          cardPresent: false,
          authorizationMethod: "contactless",
          details: replacement,
        }),
      ]);
      const replaced = (await rows())[0]!;
      expect(replaced.details.merchant).toEqual({
        ...details.merchant,
        city: "New city",
      });
      expect(replaced).toMatchObject({
        ...payment,
        cardPresent: false,
        authorizationMethod: "contactless",
      });
      await capture("sparse-again", [entry("entry")]);
      expect((await rows())[0]!.cardPresent).toBe(false);
      // An explicit null is conflicting evidence: it is never replaced by a known value.
      const conflicted = emptyDetails();
      conflicted.issues = ["conflicting_payment_context"];
      await capture("conflict", [
        entry("entry", {
          cardPresent: null,
          authorizationMethod: null,
          wallet: null,
          threeDSecureUsed: null,
          recurring: null,
          details: conflicted,
        }),
      ]);
      const unknown = (await rows())[0]!;
      expect(unknown).toMatchObject({
        cardPresent: null,
        authorizationMethod: null,
        wallet: null,
        threeDSecureUsed: null,
        recurring: null,
        version: replaced.version + 1,
      });
      expect(
        (await db.getTransaction(original.id))?.annotation?.data.notes,
      ).toBe("User-owned note");
    });

    it("clears a payment-context conflict only when a read states the conflicted field", async () => {
      const conflicted = emptyDetails();
      conflicted.issues = ["conflicting_payment_context"];
      await capture("conflict", [
        entry("entry", { authorizationMethod: null, details: conflicted }),
      ]);
      const original = (await rows())[0]!;
      expect(original.details.paymentContextConflicts).toEqual([
        "authorizationMethod",
      ]);
      // Evidence for an unrelated field never resolves the recorded conflict.
      const walletOnly = await db.latestEventId();
      await capture("wallet", [entry("entry", { wallet: "apple_pay" })]);
      const enriched = (await rows())[0]!;
      expect(enriched).toMatchObject({
        authorizationMethod: null,
        wallet: "apple_pay",
      });
      expect(enriched.details.issues).toContain("conflicting_payment_context");
      expect(enriched.details.paymentContextConflicts).toEqual([
        "authorizationMethod",
      ]);
      expect(
        (await db.listEvents({ after: walletOnly })).map((event) => event.type),
      ).not.toContain("transaction.review_resolved");
      // Evidence for the conflicted field resolves it.
      const resolving = await db.latestEventId();
      await capture("resolved", [
        entry("entry", { authorizationMethod: "online" }),
      ]);
      const resolved = (await rows())[0]!;
      expect(resolved).toMatchObject({
        authorizationMethod: "online",
        wallet: "apple_pay",
      });
      expect(resolved.details.issues).not.toContain(
        "conflicting_payment_context",
      );
      expect(resolved.details.paymentContextConflicts).toBeUndefined();
      expect(
        (await db.listEvents({ after: resolving })).map((event) => event.type),
      ).toContain("transaction.review_resolved");
    });

    it("keeps a plan's accepted FX state when it rejects a converted single-charge restatement", async () => {
      const usdToIls = [
        {
          sourceCurrency: "USD",
          targetCurrency: "ILS",
          unitCurrency: "USD",
          exchangeRate: "3.75",
          quotationDate: "2040-01-01",
        },
      ];
      const plan = entry("purchase", {
        amountBasis: "purchase_commitment",
        amountMinor: -30000,
        currency: "ILS",
        installmentCount: 3,
      });
      const lines = [1, 2, 3].map((installmentNumber) => {
        // An adapter's FX facts on a billed line never reach the ledger.
        const details = emptyDetails();
        details.currencyExchange = usdToIls;
        return entry(`line-${installmentNumber}`, {
          amountMinor: -10000,
          currency: "ILS",
          installmentCount: 3,
          installmentNumber,
          purchaseKey: "purchase",
          fxFeeMinor: -100,
          fxFeeCurrency: "ILS",
          details,
        });
      });
      await capture("plan", [plan, ...lines]);
      const converted = emptyDetails();
      converted.currencyExchange = usdToIls;
      await capture("restated", [
        entry("purchase", {
          amountBasis: "purchase_commitment",
          amountMinor: -30100,
          currency: "ILS",
          originalAmountMinor: -8000,
          originalCurrency: "USD",
          installmentCount: 1,
          billingDate: "2040-02-10",
          fxFeeMinor: -100,
          fxFeeCurrency: "ILS",
          details: converted,
        }),
        ...lines,
      ]);
      const stored = await rows();
      const purchase = stored.find((row) => row.sourceKey === "purchase")!;
      expect(purchase).toMatchObject({
        amountMinor: -30000,
        originalAmountMinor: null,
        originalCurrency: null,
        installmentCount: 3,
        billingDate: null,
        fxFeeMinor: null,
        fxFeeCurrency: null,
        version: 2,
      });
      expect(purchase.details.currencyExchange).toBeUndefined();
      expect(purchase.details.issues).toContain("conflicting_installment_plan");
      for (const line of stored.filter((row) => row.purchaseId !== null)) {
        expect(line).toMatchObject({ fxFeeMinor: null, fxFeeCurrency: null });
        expect(line.details.currencyExchange).toBeUndefined();
      }
    });

    it("flags, but never merges, a posted plan restated under another native ID", async () => {
      let revision = 0;
      const nextCapture = (runId: string, inputs: TransactionInput[]) =>
        capture(
          runId,
          inputs,
          bankAdapter(),
          undefined,
          `2040-02-01T00:00:0${revision++}Z`,
        );
      const planRows = (purchaseKey: string, amountMinor = -30000) => [
        entry(purchaseKey, {
          amountBasis: "purchase_commitment",
          amountMinor,
          currency: "ILS",
          installmentCount: 3,
        }),
        ...[1, 2, 3].map((installmentNumber) =>
          entry(`${purchaseKey}:line-${installmentNumber}`, {
            amountMinor: amountMinor / 3,
            currency: "ILS",
            installmentCount: 3,
            installmentNumber,
            purchaseKey,
          }),
        ),
      ];
      const purchases = async () =>
        (await rows()).filter((row) => row.installmentNumber === null);
      await nextCapture("first", planRows("plan-a"));
      const restated = await db.latestEventId();
      await nextCapture("restated", [
        ...planRows("plan-a"),
        ...planRows("plan-b"),
      ]);
      const flagged = await purchases();
      expect(flagged).toHaveLength(2);
      for (const purchase of flagged) {
        expect(purchase.details.issues).toContain("possible_duplicate_plan");
        expect(purchase.supersededById).toBeNull();
      }
      // Both identities stay counted; the warning is the safeguard.
      expect(
        (await db.getTotals({ perspective: "billing" })).totals[0]!.amountMinor,
      ).toBe(-60000);
      expect(
        (await db.listEvents({ after: restated }))
          .filter((event) => event.type === "transaction.review_required")
          .map((event) => event.transactionId)
          .sort(),
      ).toEqual(flagged.map((row) => row.id).sort());
      // A differing whole amount is not a lookalike.
      await nextCapture("corrected", [
        ...planRows("plan-a"),
        ...planRows("plan-b", -36000),
      ]);
      for (const purchase of await purchases()) {
        expect(purchase.details.issues).not.toContain(
          "possible_duplicate_plan",
        );
      }
      // Restated again, then the owner removes one twin: the other resolves at once.
      await nextCapture("again", [
        ...planRows("plan-a"),
        ...planRows("plan-b"),
      ]);
      const [kept, twin] = await purchases();
      expect(kept!.details.issues).toContain("possible_duplicate_plan");
      const removal = await db.latestEventId();
      await db.confirmRemoval({
        transactionId: twin!.id,
        expectedVersion: twin!.version,
        reason: "Same plan under another ID",
      });
      const survivor = (await rows()).find((row) => row.id === kept!.id)!;
      expect(survivor.details.issues).not.toContain("possible_duplicate_plan");
      expect(
        (await db.listEvents({ after: removal }))
          .filter((event) => event.type === "transaction.review_resolved")
          .map((event) => event.transactionId)
          .sort(),
      ).toEqual([kept!.id, twin!.id].sort());
    });

    it("never changes payment context from historical evidence, including a current conflict", async () => {
      const current = emptyDetails();
      current.issues = ["conflicting_payment_context"];
      await capture(
        "current",
        [entry("entry", { authorizationMethod: null, details: current })],
        bankAdapter(),
        undefined,
        "2040-03-02T00:00:00Z",
      );
      const adapter = bankAdapter();
      const historicalAdapter = bankAdapter({
        extract(raw, context) {
          return { ...adapter.extract(raw, context), historical: true };
        },
      });
      await capture(
        "history",
        [
          entry("entry", {
            cardPresent: true,
            authorizationMethod: "contactless",
            wallet: "apple_pay",
            threeDSecureUsed: true,
            recurring: true,
          }),
        ],
        historicalAdapter,
        { kind: "history", month: "2040-01" },
        "2040-03-03T00:00:00Z",
      );
      expect((await rows())[0]!).toMatchObject({
        authorizationMethod: null,
        cardPresent: null,
        wallet: null,
        threeDSecureUsed: null,
        recurring: null,
      });
    });

    it("fills missing merchant enrichment from historical native evidence without replacing current values, financial facts or payment context", async () => {
      const current = emptyDetails();
      current.merchant.city = "Current city";
      await capture(
        "current",
        [entry("entry", { cardPresent: false, details: current })],
        bankAdapter(),
        undefined,
        "2040-03-02T00:00:00Z",
      );
      const original = (await rows())[0]!;
      const historical = emptyDetails();
      historical.merchant = {
        address: "Archived address",
        phone: "Archived phone",
        city: "Old city",
        countryCode: "ISR",
      };
      const historicalPayment = {
        cardPresent: true,
        authorizationMethod: "contactless" as const,
        wallet: "apple_pay" as const,
        threeDSecureUsed: true,
        recurring: true,
      };
      const adapter = bankAdapter();
      const historicalAdapter = bankAdapter({
        extract(raw, context) {
          return { ...adapter.extract(raw, context), historical: true };
        },
      });
      await capture(
        "history",
        [
          entry("entry", {
            amountMinor: -9999,
            ...historicalPayment,
            details: historical,
          }),
        ],
        historicalAdapter,
        { kind: "history", month: "2040-01" },
        "2040-03-03T00:00:00Z",
      );
      const enriched = (await rows())[0]!;
      expect(enriched).toMatchObject({
        id: original.id,
        amountMinor: original.amountMinor,
        version: original.version + 1,
        lastSeenAt: original.lastSeenAt,
        lastSeenRunId: original.lastSeenRunId,
        presence: original.presence,
      });
      expect(enriched.details.merchant).toEqual({
        ...historical.merchant,
        city: "Current city",
      });
      // Historical windows never change payment context.
      expect(enriched).toMatchObject({
        cardPresent: false,
        authorizationMethod: null,
        wallet: null,
        threeDSecureUsed: null,
        recurring: null,
      });
      expect(enriched.details.sourceRefs.map((ref) => ref.runId)).toEqual([
        "current",
        "history",
      ]);
      const newer = emptyDetails();
      newer.merchant.phone = "Current phone";
      await capture(
        "new-current",
        [entry("entry", { authorizationMethod: "online", details: newer })],
        bankAdapter(),
        undefined,
        "2040-03-04T00:00:00Z",
      );
      await capture(
        "old-current",
        [entry("entry", { ...historicalPayment, details: historical })],
        bankAdapter(),
        undefined,
        "2040-03-01T00:00:00Z",
      );
      expect((await rows())[0]!.details).toMatchObject({
        merchant: { city: "Current city", phone: "Current phone" },
      });
      expect((await rows())[0]!).toMatchObject({
        authorizationMethod: "online",
        cardPresent: false,
      });
    });

    it("deduplicates a row matched through both its source key and repeated aliases", async () => {
      await capture("first", [
        entry("entry", { sourceAliases: ["entry", "alias", "alias"] }),
      ]);
      const original = (await rows())[0]!;
      expect(
        await capture("same-source-and-alias", [
          entry("entry", { sourceAliases: ["entry", "alias", "alias"] }),
        ]),
      ).toMatchObject({ created: 0, updated: 0 });
      expect(
        await capture("repeat", [entry("alias", { amountMinor: -2000 })]),
      ).toMatchObject({ created: 0, updated: 1 });
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({
        id: original.id,
        sourceKey: "alias",
        amountMinor: -2000,
        identityStrength: "native",
      });
    });

    it("prefers one active alias match over an inactive colliding match", async () => {
      await capture("first", [
        entry("old", { sourceAliases: ["shared"] }),
        entry("active", { sourceAliases: ["shared"] }),
      ]);
      const original = (await rows()).find(
        (row) => row.sourceKey === "active",
      )!;
      await capture("only-active", [
        entry("active", { sourceAliases: ["shared"] }),
      ]);
      expect(
        await capture("alias", [entry("shared", { amountMinor: -2000 })]),
      ).toMatchObject({ created: 0, updated: 1 });
      expect(await rows()).toHaveLength(2);
      expect(
        (await rows()).find((row) => row.id === original.id),
      ).toMatchObject({
        sourceKey: "shared",
        amountMinor: -2000,
        presence: "seen",
        identityStrength: "native",
      });
      expect(
        (await rows()).find((row) => row.sourceKey === "old"),
      ).toMatchObject({
        amountMinor: -1000,
        presence: "not_returned",
      });
    });

    it("preserves both original rows when an incoming alias collides with two active matches", async () => {
      await capture("first", [
        entry("a", { sourceAliases: ["shared"] }),
        entry("b", { sourceAliases: ["shared"], amountMinor: -2000 }),
      ]);
      const original = await rows();
      expect(
        await capture("collision", [entry("shared", { amountMinor: -3000 })]),
      ).toMatchObject({ created: 1, updated: 0 });
      expect(await rows()).toHaveLength(3);
      for (const row of original) {
        expect(
          (await rows()).find((after) => after.id === row.id)?.amountMinor,
        ).toBe(row.amountMinor);
      }
      expect(
        (await rows()).find((row) => row.sourceKey === "shared"),
      ).toMatchObject({
        identityStrength: "ambiguous",
        details: { issues: ["ambiguous_identity"] },
        amountMinor: -3000,
      });
    });

    it.each(["weak", "ambiguous"] as const)(
      "keeps %s identity matching quiet after retaining partial evidence from another scope",
      async (identityStrength) => {
        const project = (value: JsonObject) =>
          evidenceObject(value, {
            rows: [{ label: "scalar", marker: "scalar" }],
          });
        const adapter = bankAdapter({
          retainProviderEvidence: project,
          projectProviderState: (value) =>
            evidenceObject(value, {
              identity: {
                baseKey: "scalar",
                occurrenceCount: "scalar",
                currentRows: ["scalar"],
              },
            }),
          mergeProviderEvidence: (previous, incoming) =>
            mergeDeclaredEvidence(previous, incoming, {
              project,
              componentKey: (row: JsonValue) =>
                row &&
                typeof row === "object" &&
                !Array.isArray(row) &&
                typeof row.label === "string"
                  ? row.label
                  : null,
            }),
        });
        const inputs = ["A", "B"].map((label) =>
          entry("same-uncertain-key", {
            identityStrength,
            details: {
              ...emptyDetails(),
              provider: {
                "synthetic-bank": { rows: [{ label, marker: "complete" }] },
              },
            },
          }),
        );
        await capture("complete", inputs, adapter);
        const original = await rows();
        expect(original).toHaveLength(2);
        const noted = original.find(
          (row) =>
            (
              currentSourceRows(
                row.details.provider[adapter.provider]!,
              )[0] as JsonObject
            ).label === "A",
        )!;
        const annotation = await db.editAnnotation({
          transactionId: noted.id,
          expectedVersion: 0,
          notes: "Keep the A occurrence",
        });
        for (const row of original) {
          const namespace = row.details.provider[adapter.provider]!;
          const current = currentSourceRows(namespace);
          const partial = { label: (current[0] as JsonObject).label! };
          const merged = adapter.mergeProviderEvidence!(
            { rows: [partial] },
            namespace,
          );
          await insertTransactionFixture(
            db,
            [
              {
                ...row,
                details: {
                  ...row.details,
                  provider: {
                    [adapter.provider]: {
                      ...adapter.projectProviderState!(namespace),
                      ...merged,
                      identity: {
                        ...((namespace.identity as JsonObject) ?? {}),
                        currentRows: currentSourceRowIndices(
                          evidenceList(merged.rows),
                          current,
                        ),
                      },
                    },
                  },
                },
              },
            ],
            "update",
          );
        }
        const before = await rows();
        for (const [index, incoming] of [
          [...inputs].reverse(),
          inputs,
        ].entries()) {
          expect(
            await capture(`repeat-${index}`, incoming, adapter),
          ).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
          expect(
            (await rows())
              .map((row) => [row.id, row.version, row.identityStrength])
              .sort(),
          ).toEqual(
            before
              .map((row) => [row.id, row.version, row.identityStrength])
              .sort(),
          );
        }
        expect((await db.getTransaction(noted.id))!.annotation).toEqual(
          annotation,
        );
        expect(
          (await rows()).every(
            (row) =>
              evidenceList(row.details.provider[adapter.provider]!.rows)
                .length === 2,
          ),
        ).toBe(true);
      },
    );

    it("preserves duplicate uncertain identities when reordered, and keeps a changed multiplicity separate", async () => {
      let revision = 0;
      const nextCapture = (runId: string, inputs: TransactionInput[]) =>
        capture(
          runId,
          inputs,
          bankAdapter(),
          undefined,
          `2040-02-01T00:00:0${revision++}Z`,
        );
      const duplicate = entry("weak", { identityStrength: "weak" });
      const different = entry("weak", {
        identityStrength: "weak",
        amountMinor: -2000,
      });
      await nextCapture("first", [duplicate, duplicate, different]);
      const original = await rows();
      expect(original).toHaveLength(3);
      expect(
        await nextCapture("reordered", [different, duplicate, duplicate]),
      ).toMatchObject({ created: 0, updated: 0 });
      expect(
        (await rows()).map((row) => [row.id, row.amountMinor]).sort(),
      ).toEqual(original.map((row) => [row.id, row.amountMinor]).sort());
      expect(await nextCapture("shrunk", [duplicate, different])).toMatchObject(
        {
          created: 2,
          updated: 3,
        },
      );
      const current = (await rows()).filter((row) => row.presence === "seen");
      expect(current).toHaveLength(2);
      expect(current.every((row) => row.identityStrength === "ambiguous")).toBe(
        true,
      );
      expect(
        current.every((row) => !original.some((old) => old.id === row.id)),
      ).toBe(true);
      expect(
        await nextCapture("shrunk-repeat", [different, duplicate]),
      ).toMatchObject({
        created: 0,
        updated: 0,
      });
      expect(await rows()).toHaveLength(5);
    });

    it("uses the adapter's identity namespace when a weak source key changes", async () => {
      const details = {
        ...emptyDetails(),
        provider: {
          "synthetic-bank": { identity: { baseKey: "shared-identity" } },
        },
      };
      await capture("first", [
        entry("old-key", { identityStrength: "weak", details }),
      ]);
      const original = (await rows())[0]!;
      expect(
        await capture("renamed", [
          entry("new-key", { identityStrength: "weak", details }),
        ]),
      ).toMatchObject({ created: 0, updated: 0 });
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({
        id: original.id,
        sourceKey: "new-key",
        sourceAliases: ["old-key"],
      });
    });

    it.each([true, false, undefined])(
      "uses the pending-candidate capability for another provider: %s",
      async (enabled) => {
        const adapter = bankAdapter(
          enabled === undefined ? {} : { pendingPostingCandidates: enabled },
        );
        await capture(
          "pair",
          [
            entry("pending", {
              status: "pending",
              amountBasis: "authorization",
            }),
            entry("posted"),
          ],
          adapter,
        );
        const pending = (await rows()).find((row) => row.status === "pending")!;
        const posted = (await rows()).find((row) => row.status === "posted")!;
        expect(pending.details.pendingPostingCandidates ?? []).toEqual(
          enabled ? [posted.id] : [],
        );
        expect(posted.details.pendingPostingCandidates ?? []).toEqual(
          enabled ? [pending.id] : [],
        );
        expect(await rows()).toHaveLength(2);
      },
    );

    it("does not enable candidate matching from the provider name alone", async () => {
      await db.ensureConnection({ id: `${connectionId}-cal`, provider: "cal" });
      const adapter = bankAdapter({ provider: "cal" });
      await db.ingestRun(
        {
          runId: "cal-without-capability",
          connectionId: `${connectionId}-cal`,
          responses: [
            {
              accountKey,
              endpoint: "synthetic/entries",
              capturedAt: "2040-02-01T00:00:00Z",
              responseText: JSON.stringify([
                entry("pending", { status: "pending" }),
                entry("posted"),
              ]),
            },
          ],
        },
        adapter,
      );
      expect(
        (await rows()).every(
          (row) => !row.details.pendingPostingCandidates?.length,
        ),
      ).toBe(true);
    });

    it("separates candidate buckets, enforces the seven-day boundary, and retains existing unseen candidates", async () => {
      const adapter = bankAdapter({ pendingPostingCandidates: true });
      await capture(
        "pair",
        [
          entry("pending", {
            status: "pending",
            cardKey: "a|b",
            merchantName: "c",
          }),
          entry("pending-two", {
            status: "pending",
            cardKey: "a|b",
            merchantName: "c",
          }),
          entry("match", {
            cardKey: "a|b",
            merchantName: "c",
            transactionDate: "2040-01-08",
          }),
          entry("match-two", {
            cardKey: "a|b",
            merchantName: "c",
            transactionDate: "2040-01-08",
          }),
          entry("match-before", {
            cardKey: "a|b",
            merchantName: "c",
            transactionDate: "2039-12-25",
          }),
          entry("too-early", {
            cardKey: "a|b",
            merchantName: "c",
            transactionDate: "2039-12-24",
          }),
          entry("too-late", {
            cardKey: "a|b",
            merchantName: "c",
            transactionDate: "2040-01-09",
          }),
          entry("tuple-collision", { cardKey: "a", merchantName: "b|c" }),
          entry("other-currency", {
            cardKey: "a|b",
            merchantName: "c",
            currency: "USD",
          }),
          entry("other-amount", {
            cardKey: "a|b",
            merchantName: "c",
            amountMinor: -1001,
          }),
        ],
        adapter,
      );
      const pending = (await rows()).find(
        (row) => row.sourceKey === "pending",
      )!;
      const matched = (await rows()).find((row) => row.sourceKey === "match")!;
      const pendingIds = (await rows())
        .filter((row) => row.status === "pending")
        .map((row) => row.id)
        .sort();
      const postedIds = (await rows())
        .filter((row) =>
          ["match", "match-two", "match-before"].includes(row.sourceKey),
        )
        .map((row) => row.id)
        .sort();
      expect(pending.details.pendingPostingCandidates).toEqual(postedIds);
      expect(matched.details.pendingPostingCandidates).toEqual(pendingIds);
      expect(
        (await rows())
          .filter((row) => ![...pendingIds, ...postedIds].includes(row.id))
          .every((row) => !row.details.pendingPostingCandidates?.length),
      ).toBe(true);
      await capture("neither-seen", [], adapter);
      expect((await rows()).find((row) => row.id === pending.id)).toMatchObject(
        {
          presence: "not_returned",
          details: { pendingPostingCandidates: postedIds },
        },
      );
      expect(
        (await rows()).find((row) => row.id === matched.id)?.details
          .pendingPostingCandidates,
      ).toEqual(pendingIds);
    });

    it("distinguishes null cards from a literal null string in candidate keys", async () => {
      const adapter = bankAdapter({ pendingPostingCandidates: true });
      await capture(
        "null-card-pair",
        [
          entry("pending", { status: "pending", cardKey: null }),
          entry("match", { cardKey: null }),
          entry("literal-null", { cardKey: "null" }),
        ],
        adapter,
      );
      const pending = (await rows()).find((row) => row.status === "pending")!;
      const matched = (await rows()).find((row) => row.sourceKey === "match")!;
      expect(pending.details.pendingPostingCandidates).toEqual([matched.id]);
      expect(matched.details.pendingPostingCandidates).toEqual([pending.id]);
      expect(
        (await rows()).find((row) => row.sourceKey === "literal-null")?.details
          .pendingPostingCandidates ?? [],
      ).toEqual([]);
    });

    it("does not create new candidates when neither side was observed in the current response", async () => {
      await capture("without-capability", [
        entry("pending", { status: "pending" }),
        entry("posted"),
      ]);
      await capture(
        "neither-seen",
        [],
        bankAdapter({ pendingPostingCandidates: true }),
      );
      expect(await rows()).toHaveLength(2);
      expect(
        (await rows()).every(
          (row) =>
            row.presence === "not_returned" &&
            !row.details.pendingPostingCandidates?.length,
        ),
      ).toBe(true);
    });

    it("clears both sides of an existing candidate pair after its financial facts diverge", async () => {
      const adapter = bankAdapter({ pendingPostingCandidates: true });
      const pending = entry("pending", { status: "pending" });
      await capture("pair", [pending, entry("posted")], adapter);
      expect(
        (await rows()).every(
          (row) => row.details.pendingPostingCandidates?.length === 1,
        ),
      ).toBe(true);
      await capture(
        "diverged",
        [pending, entry("posted", { amountMinor: -2000 })],
        adapter,
      );
      expect(await rows()).toHaveLength(2);
      expect(
        (await rows()).every(
          (row) =>
            !row.details.pendingPostingCandidates?.length &&
            !row.details.issues.includes("possible_pending_posted_match"),
        ),
      ).toBe(true);
    });

    it("validates and normalizes another provider's scope namespace while retaining raw criteria", async () => {
      const adapter = bankAdapter({
        validateScope(scope) {
          if (
            scope.filters &&
            (!scope.filters.synthetic ||
              Object.keys(scope.filters).some((key) => key !== "synthetic"))
          ) {
            throw new Error("Invalid synthetic criteria");
          }
        },
        normalizeScope(scope) {
          return (scope.filters?.synthetic as { mode?: string } | undefined)
            ?.mode === "all"
            ? { ...scope, filters: undefined }
            : scope;
        },
      });
      const scope: CollectionScope = {
        kind: "history",
        from: "2040-01-01",
        to: "2040-01-31",
        filters: { synthetic: { mode: "all" } },
      };
      await db.ingestRun(
        {
          runId: "failed",
          connectionId,
          startedAt: "2040-01-01T00:00:00Z",
          responses: [],
          failures: [
            {
              accountKey,
              endpoint: "synthetic-bank/entries",
              code: "network_error",
              scope,
            },
          ],
        },
        adapter,
      );
      expect(
        (
          await capture("recovered", [], adapter, {
            kind: "history",
            from: scope.from!,
            to: scope.to!,
          })
        ).status,
      ).toBe("completed");
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
      expect(
        (await readRuns()).find((run) => run.id === "failed")?.snapshot
          .failures?.[0]?.scope,
      ).toEqual(scope);
      await expect(
        capture("wrong-namespace", [], adapter, {
          kind: "recent",
          filters: { cal: {} },
        }),
      ).rejects.toThrow("Invalid synthetic criteria");
      expect(await readRuns()).toHaveLength(2);
    });

    it.each([
      ["bigint", 1n],
      ["function", () => undefined],
      ["Date", new Date("2040-01-01T00:00:00Z")],
      ["NaN", NaN],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ])(
      "rejects non-JSON generic scope criteria before archiving: %s",
      async (_, value) => {
        const scope = {
          kind: "recent",
          filters: { synthetic: { value } },
        } as unknown as CollectionScope;
        await expect(
          capture("invalid-json", [], bankAdapter(), scope),
        ).rejects.toThrow();
        await expect(
          db.ingestRun(
            {
              runId: "invalid-json-failure",
              connectionId,
              responses: [],
              failures: [
                {
                  accountKey,
                  endpoint: "synthetic-bank/entries",
                  code: "network_error",
                  scope,
                },
              ],
            },
            bankAdapter(),
          ),
        ).rejects.toThrow();
        expect(await readRuns()).toEqual([]);
        expect(await rows()).toEqual([]);
      },
    );

    it("replays CAL filters collected in request order against legacy archive key order", async () => {
      await db.ensureConnection({ id: `${connectionId}-cal`, provider: "cal" });
      const filters = normalizeCalSearchFilters({
        merchantHebName: "Synthetic merchant",
      }).recorded;
      const legacy = {
        merchantHebName: filters.merchantHebName,
        merchantHebCity: filters.merchantHebCity,
        trnType: filters.trnType,
        fromTrnAmt: filters.fromTrnAmt,
        toTrnAmt: filters.toTrnAmt,
        transactionsOrigin: filters.transactionsOrigin,
        transCardPresentInd: filters.transCardPresentInd,
      };
      const input = {
        runId: "legacy-cal-filter-order",
        connectionId: `${connectionId}-cal`,
        responses: [
          {
            accountKey,
            endpoint: "synthetic/cal",
            capturedAt: "2040-02-01T00:00:00Z",
            responseText: JSON.stringify({
              statusCode: 1,
              result: { transArr: [] },
            }),
            scope: { kind: "history" as const, filters: { cal: legacy } },
          },
        ],
      };
      await db.ingestRun(input, calAdapter);
      const archived = (await readRun())!;
      expect(
        Object.keys(archived.snapshot.responses[0]!.scope!.filters!.cal!),
      ).toEqual(Object.keys(legacy));
      expect(
        (
          await db.ingestRun(
            {
              ...input,
              responses: [
                {
                  ...input.responses[0]!,
                  scope: { kind: "history", filters: { cal: filters } },
                },
              ],
            },
            calAdapter,
          )
        ).replayed,
      ).toBe(true);
      expect(await readRuns()).toHaveLength(1);
    });

    it.each(["response", "failure"] as const)(
      "rejects invalid CAL %s scope before archiving",
      async (kind) => {
        await db.ensureConnection({
          id: `${connectionId}-cal`,
          provider: "cal",
        });
        const scope: CollectionScope = {
          kind: "history",
          filters: { cal: { trnType: "unsupported" } },
        };
        const response = {
          accountKey,
          endpoint: "synthetic/cal",
          capturedAt: "2040-02-01T00:00:00Z",
          responseText: "{}",
          scope,
        };
        const failure = {
          accountKey,
          endpoint: "synthetic/cal",
          code: "network_error" as const,
          scope,
        };
        await expect(
          db.ingestRun(
            {
              runId: "invalid",
              connectionId: `${connectionId}-cal`,
              responses: kind === "response" ? [response] : [],
              failures: kind === "failure" ? [failure] : [],
            },
            calAdapter,
          ),
        ).rejects.toThrow();
        expect(await readRuns()).toEqual([]);
        expect(await rows()).toEqual([]);
        expect(await db.listEvents()).toEqual([]);
      },
    );
  });
}
