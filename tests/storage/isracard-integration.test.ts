import "../helpers/run-history-differential.js";

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectFromStore } from "../../src/application/collection.js";
import type { CollectionRange } from "../../src/domain/source-adapter.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../src/providers/isracard/capture.js";
import {
  collectIsracard,
  type CollectIsracardOptions,
  ISRACARD_COLLECTOR_VERSION,
} from "../../src/providers/isracard/collect.js";
import {
  ISRACARD_ENDPOINTS,
  type IsracardTransport,
  IsracardTransportError,
} from "../../src/providers/isracard/transport.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { syncRunBodies, syncRuns } from "../../src/storage/sqlite/schema.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../providers/isracard/fixtures/card-month.json", import.meta.url),
    "utf8",
  ),
) as IsracardCapture;
const connectionId = "synthetic-isracard";

function scriptedTransport(
  options: {
    next?: string;
    last?: string;
    failMonth?: string;
    abortMonth?: string;
    abortController?: AbortController;
    abortSuffix?: string;
    multipleCards?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let closed = false;
  const transport: IsracardTransport = {
    async request(endpoint, body, query) {
      let responseText: string;
      if (endpoint === ISRACARD_ENDPOINTS.login) {
        responseText = JSON.stringify({ Header: { Status: "1" } });
      } else if (endpoint === ISRACARD_ENDPOINTS.cards) {
        const cardList = JSON.parse(fixture.responses.cardList);
        Object.assign(cardList.data.cardsList[0], {
          isActive: true,
          isPartner: false,
          cardChargeNext: { billingDate: `${options.next ?? "2040-07"}-10` },
          cardChargeLast: { billingDate: `${options.last ?? "2040-06"}-10` },
        });
        if (options.multipleCards) {
          for (const [cardGuid, cardSuffix] of [
            ["SYNTHETIC-CARD-TWO", "2345"],
            ["SYNTHETIC-CARD-THREE", "3456"],
          ]) {
            cardList.data.cardsList.push({
              ...cardList.data.cardsList[0],
              companyCode: "77",
              cardGuid,
              cardSuffix,
            });
          }
        }
        responseText = JSON.stringify(cardList);
      } else {
        const billingDate = (body as { billingMonth?: string } | undefined)
          ?.billingMonth;
        const month = billingDate
          ? `${billingDate.slice(6)}-${billingDate.slice(3, 5)}`
          : `${query!.year}-${query!.month}`;
        calls.push(
          `${endpoint === ISRACARD_ENDPOINTS.transactions ? "digital" : "legacy"}:${month}`,
        );
        if (
          month === options.abortMonth ||
          (options.abortSuffix !== undefined &&
            (body as { card4Number?: string } | undefined)?.card4Number ===
              options.abortSuffix)
        ) {
          options.abortController!.abort();
          throw new IsracardTransportError("network_error");
        }
        if (month === options.failMonth) {
          throw new IsracardTransportError("rate_limited");
        }
        const raw =
          endpoint === ISRACARD_ENDPOINTS.transactions
            ? fixture.responses.digital!
            : fixture.responses.legacy!;
        responseText = raw
          .replaceAll("VOUCHER-1", `VOUCHER-${month}`)
          .replaceAll("LEGACY-ONLY", `LEGACY-${month}`);
      }
      return {
        responseText,
        payload: JSON.parse(responseText),
        httpStatus: 200,
      };
    },
    containsAuthMaterial: () => false,
    close() {
      closed = true;
    },
  };
  return { transport, calls, closed: () => closed };
}

describe("Isracard collection through shared storage", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: connectionId, provider: "isracard" });
  });
  afterEach(() => db.close());

  async function collect(
    script: ReturnType<typeof scriptedTransport>,
    range?: CollectionRange,
    executionOptions: Pick<CollectIsracardOptions, "callBudget" | "signal"> & {
      debugArchiveDays?: number;
    } = {},
  ) {
    const { debugArchiveDays, ...providerOptions } = executionOptions;
    return collectFromStore(
      db,
      {
        connectionId,
        ...(debugArchiveDays !== undefined && { debugArchiveDays }),
        ...(range && { range }),
        ...(executionOptions.signal && { signal: executionOptions.signal }),
      },
      {
        provider: "isracard",
        collectorVersion: ISRACARD_COLLECTOR_VERSION,
        drainsOnAbort: true,
        collect: (options) =>
          collectIsracard({
            ...providerOptions,
            ...options,
            credentials: {
              username: "invented-user",
              password: "invented-password",
              cardSuffix: "001234",
            },
            httpClient: {
              async request() {
                throw new Error(
                  "Synthetic integration cannot make network requests",
                );
              },
            },
            transport: script.transport,
            sleep: async () => {},
          }),
      },
      isracardAdapter,
    );
  }

  it("keeps stable IDs and annotations on repeat and never unlists another billing month", async () => {
    const first = scriptedTransport();
    expect(
      await collect(first, undefined, { debugArchiveDays: 2 }),
    ).toMatchObject({
      status: "completed",
      captures: 2,
      failures: 0,
      created: 4,
    });
    expect(first.closed()).toBe(true);
    const baseline = await db.listTransactions();
    await db.editAnnotation({
      transactionId: baseline[0]!.id,
      expectedVersion: 0,
      notes: "Owner's synthetic note",
    });
    const repeat = scriptedTransport();
    expect(await collect(repeat)).toMatchObject({
      status: "completed",
      created: 0,
      updated: 0,
      unlisted: 0,
    });
    expect((await db.listTransactions()).map((row) => row.id).sort()).toEqual(
      baseline.map((row) => row.id).sort(),
    );
    expect(
      (await db.getTransaction(baseline[0]!.id))?.annotation?.data.notes,
    ).toBe("Owner's synthetic note");
    const rollover = scriptedTransport({ next: "2040-08", last: "2040-07" });
    expect(await collect(rollover)).toMatchObject({
      status: "completed",
      created: 2,
      updated: 0,
      unlisted: 0,
    });
    const current = await db.listTransactions();
    expect(current).toHaveLength(6);
    expect(current.every((row) => row.presence === "seen")).toBe(true);
    const runs = await db.orm.select().from(syncRuns).all();
    expect(runs).toHaveLength(6);
    const archived = JSON.parse(
      (await db.orm.select().from(syncRunBodies).get())!.snapshot.responses[0]!
        .responseText,
    ) as IsracardCapture;
    expect(archived.responses.digital).toContain("VOUCHER-2040-07");
    expect(archived.responses.legacy).toContain("VOUCHER-2040-07");
  });

  it("retains completed historical months and fatal/range failure evidence without changing current state", async () => {
    await collect(scriptedTransport());
    const baseline = await db.listTransactions();
    const script = scriptedTransport({ failMonth: "2040-06" });
    const range = { from: "2040-05-01", to: "2040-07-31" };
    expect(await collect(script, range)).toMatchObject({
      status: "partial",
      captures: 1,
      failures: 2,
      created: 2,
      updated: 0,
      unlisted: 0,
      requestedRange: range,
    });
    expect(script.closed()).toBe(true);
    expect(script.calls).toEqual([
      "digital:2040-05",
      "legacy:2040-05",
      "digital:2040-06",
    ]);
    const after = await db.listTransactions();
    expect(
      after.filter((row) =>
        baseline.some((previous) => previous.id === row.id),
      ),
    ).toEqual(baseline);
    expect(
      after.filter(
        (row) => !baseline.some((previous) => previous.id === row.id),
      ),
    ).toHaveLength(2);
    expect(
      after
        .filter((row) => !baseline.some((previous) => previous.id === row.id))
        .every((row) => row.presence === "not_returned"),
    ).toBe(true);
    const runs = await db.orm.select().from(syncRuns).all();
    expect(
      runs.some((run) =>
        run.snapshot.responses.some(
          (capture) =>
            capture.scope?.kind === "history" &&
            capture.scope.month === "2040-05",
        ),
      ),
    ).toBe(true);
    expect(runs.flatMap((run) => run.snapshot.failures ?? [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "rate_limited",
          scope: expect.objectContaining({ kind: "history", month: "2040-06" }),
        }),
        expect.objectContaining({
          accountKey: null,
          endpoint: "isracard:card-month",
          code: "rate_limited",
          scope: { kind: "history", ...range },
        }),
      ]),
    );
  });

  it.each(["budget", "abort"] as const)(
    "keeps incremental campaign uncertainty after %s stops before every month is fetched",
    async (reason) => {
      const abortController = new AbortController();
      const script = scriptedTransport(
        reason === "abort" ? { abortMonth: "2040-06", abortController } : {},
      );
      const code = reason === "budget" ? "budget_exhausted" : "network_error";
      expect(
        await collect(
          script,
          undefined,
          reason === "budget"
            ? { callBudget: 4 }
            : { signal: abortController.signal },
        ),
      ).toMatchObject({
        status: "partial",
        captures: 1,
        failures: 2,
        created: 2,
        unlisted: 0,
      });
      expect(script.closed()).toBe(true);
      const baseline = await db.listTransactions();
      expect(baseline).toHaveLength(2);
      const failedRuns = await db.orm.select().from(syncRuns).all();
      expect(failedRuns.flatMap((run) => run.snapshot.failures ?? [])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code,
            scope: expect.objectContaining({
              kind: "recent",
              month: "2040-06",
            }),
          }),
          expect.objectContaining({
            code,
            accountKey: null,
            scope: { kind: "recent" },
          }),
        ]),
      );
      const retryOnlyFailedMonth = scriptedTransport({
        next: "2040-06",
        last: "2040-06",
      });
      expect(await collect(retryOnlyFailedMonth)).toMatchObject({
        status: "completed",
        captures: 1,
        failures: 0,
        created: 2,
        unlisted: 0,
      });
      expect(
        (await db.listTransactions()).filter((row) =>
          baseline.some((previous) => previous.id === row.id),
        ),
      ).toEqual(baseline);
      const recoveries = (await db.listEvents()).filter(
        (change) => change.type === "sync.recovered",
      );
      expect(recoveries.length).toBeGreaterThan(0);
      const recovery = recoveries.at(-1)!.after as {
        failedScopes: string[];
        recoveredScopes: string[];
      };
      const campaignScope = 'collection:{"kind":"recent"}';
      expect(recovery.failedScopes).toContain(campaignScope);
      expect(recovery.recoveredScopes).not.toContain(campaignScope);
    },
  );

  it("drains every already-fetched card after outer application cancellation without another provider request", async () => {
    const abortController = new AbortController();
    const script = scriptedTransport({
      multipleCards: true,
      abortSuffix: "3456",
      abortController,
    });
    expect(
      await collect(script, undefined, {
        signal: abortController.signal,
        debugArchiveDays: 2,
      }),
    ).toMatchObject({
      status: "partial",
      captures: 2,
      // The unit's one partial run reports its two explicit failures; its
      // capture without the required legacy response is not counted apart.
      failures: 2,
      created: 2,
      unlisted: 0,
    });
    expect(script.closed()).toBe(true);
    expect(script.calls).toEqual([
      "digital:2040-07",
      "digital:2040-07",
      "digital:2040-07",
    ]);
    const runs = await db.orm.select().from(syncRuns).all();
    const archived = (await db.orm.select().from(syncRunBodies).all()).flatMap(
      (run) => run.snapshot.responses,
    );
    expect(archived).toHaveLength(2);
    expect(new Set(archived.map((capture) => capture.accountKey)).size).toBe(2);
    expect(
      runs.some(
        (run) =>
          run.warnings.includes("missing_required_legacy_response") &&
          run.coverage.some((partition) => !partition.success),
      ),
    ).toBe(true);
    expect(
      archived.every((capture) =>
        (
          JSON.parse(capture.responseText) as IsracardCapture
        ).responses.digital?.includes("VOUCHER-2040-07"),
      ),
    ).toBe(true);
    expect(runs.flatMap((run) => run.snapshot.failures ?? [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountKey: null,
          code: "network_error",
          scope: { kind: "recent" },
        }),
      ]),
    );
  });

  it.each([false, true])(
    "defers alternating partial generations with conflicting native dates instead of inserting a second money-bearing purchase (historical first=%s)",
    async (historicalFirst) => {
      const legacyOnly = structuredClone(fixture);
      legacyOnly.mode = historicalFirst ? "history" : "recent";
      delete legacyOnly.responses.digital;
      const legacy = JSON.parse(legacyOnly.responses.legacy!);
      const group =
        legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0];
      group.txnIsrael = [group.txnIsrael[0]];
      group.txnIsrael[0].fullPurchaseDate = "10/06/2040";
      legacyOnly.responses.legacy = JSON.stringify(legacy);
      const digitalOnly = structuredClone(fixture);
      delete digitalOnly.responses.legacy;
      const accountKey = isracardCardKey(fixture.card);

      async function ingest(
        capture: IsracardCapture,
        runId: string,
        day: number,
      ) {
        return db.ingestRun(
          {
            connectionId,
            runId,
            debugArchiveDays: 2,
            responses: [
              {
                accountKey,
                endpoint: "isracard:card-month",
                capturedAt: `2040-07-${String(day).padStart(2, "0")}T00:00:00Z`,
                responseText: serializeIsracardCapture(capture),
                scope: {
                  kind: capture.mode,
                  month: capture.billingMonth,
                  cardKey: accountKey,
                },
              },
            ],
          },
          isracardAdapter,
        );
      }

      expect(await ingest(legacyOnly, "legacy-only", 1)).toMatchObject({
        created: 1,
        status: "partial",
      });
      const initial = (await db.listTransactions())[0]!;
      expect(initial).toMatchObject({
        identityStrength: "native",
        transactionDate: "2040-06-10",
        amountMinor: -8640,
      });
      await db.editAnnotation({
        transactionId: initial.id,
        expectedVersion: 0,
        notes: "Preserve owner's synthetic note",
      });
      expect(await ingest(digitalOnly, "digital-only", 2)).toMatchObject({
        created: 0,
        updated: 0,
        unlisted: 0,
        status: "partial",
      });
      expect(await ingest(digitalOnly, "digital-only", 2)).toMatchObject({
        replayed: true,
        created: 0,
      });
      const rows = await db.listTransactions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: initial.id,
        transactionDate: initial.transactionDate,
        amountMinor: initial.amountMinor,
        version: initial.version,
        presence: initial.presence,
        lastSeenRunId: initial.lastSeenRunId,
        annotation: { data: { notes: "Preserve owner's synthetic note" } },
      });
      const archived = await db.orm.select().from(syncRunBodies).all();
      expect(archived).toHaveLength(2);
      expect(
        archived.find((run) => run.runId === "digital-only")?.snapshot
          .responses[0]?.responseText,
      ).toBe(serializeIsracardCapture(digitalOnly));
    },
  );

  it("archives older explicit recent captures without replacing newer noncomparable facts, metadata or annotations", async () => {
    const accountKey = isracardCardKey(fixture.card);

    async function ingest(
      capture: IsracardCapture,
      runId: string,
      day: number,
    ) {
      return db.ingestRun(
        {
          connectionId,
          runId,
          debugArchiveDays: 2,
          responses: [
            {
              accountKey,
              endpoint: "isracard:card-month",
              capturedAt: `2040-07-0${day}T00:00:00Z`,
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

    await ingest(fixture, "newer-current", 3);
    const transaction = (await db.listTransactions())[0]!;
    await db.editAnnotation({
      transactionId: transaction.id,
      expectedVersion: 0,
      notes: "Owner annotation on newest facts",
    });
    const newest = await db.listTransactions();
    const older = structuredClone(fixture);
    older.responses.digital = older.responses
      .digital!.replaceAll("86.4", "12.34")
      .replace("Synthetic merchant", "Older synthetic merchant")
      .replace(
        "Synthetic unmapped transaction description",
        "Older synthetic description",
      );
    older.responses.legacy = older.responses.legacy!.replaceAll(
      "86.4",
      "12.34",
    );
    older.responses.details![0]!.responseText =
      older.responses.details![0]!.responseText.replace(
        "1 Synthetic Street",
        "Outdated synthetic address",
      );
    expect(await ingest(older, "older-current", 2)).toMatchObject({
      created: 0,
      updated: 0,
      unlisted: 0,
    });
    expect(await db.listTransactions()).toEqual(newest);
    const archived = await db.orm.select().from(syncRunBodies).all();
    expect(
      archived.find((run) => run.runId === "older-current")?.snapshot
        .responses[0]?.responseText,
    ).toBe(serializeIsracardCapture(older));
  });
});
