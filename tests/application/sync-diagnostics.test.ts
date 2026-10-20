import { describe, expect, it, vi } from "vitest";

import {
  collectFromStore,
  type CollectionStore,
} from "../../src/application/collection.js";
import {
  createSyncDiagnosticReport,
  safeLog,
  type SyncDiagnostic,
  syncDiagnostics,
} from "../../src/application/sync-diagnostics.js";
import type {
  ProviderCollector,
  SourceAdapter,
} from "../../src/domain/source-adapter.js";

const refreshId = "58882f68-1baf-46ce-bf0e-efef201f0913";
const diagnostic: SyncDiagnostic = {
  event: "fonds_sync",
  refreshId,
  stage: "ingest",
  outcome: "completed",
  counts: {
    observed: 20,
    created: 2,
    changed: 3,
    unchangedTransactions: 15,
    absent: 1,
  },
};

function setup() {
  const ingestRun = vi.fn<CollectionStore["ingestRun"]>(async (input) => ({
    runId: input.runId,
    replayed: false,
    observed: 20,
    unchanged: 15,
    created: 2,
    updated: 3,
    unlisted: 1,
    status: "completed",
  }));
  const store: CollectionStore = {
    identity: {},
    getConnection: async () => ({
      id: "private-connection",
      provider: "synthetic",
      displayName: "private-holder",
      createdAt: "2040-01-01T00:00:00Z",
      latestRefresh: null,
    }),
    recordCardDiscovery: vi.fn(),
    ingestRun,
  };
  const collector: ProviderCollector = {
    provider: "synthetic",
    collectorVersion: "1",
    async *collect() {
      yield {
        type: "capture",
        capture: {
          accountKey: "private-account",
          endpoint: "private-url",
          capturedAt: "2040-01-01T00:00:00Z",
          responseText: '{"token":"private-credential","amount":4321}',
        },
      };
    },
  };
  const adapter: SourceAdapter = {
    provider: "synthetic",
    parserVersion: "1",
    extract: vi.fn(),
  };
  return { store, collector, adapter, ingestRun };
}

describe("structured sync diagnostics", () => {
  it("projects known fields and rejects free-form reasons and private identifiers", () => {
    const log = vi.fn();
    const emit = syncDiagnostics(log);
    emit({
      ...diagnostic,
      responseText: "private-body",
      accountKey: "private-account",
      counts: { ...diagnostic.counts, amount: 4321 },
    } as SyncDiagnostic);
    expect(log).toHaveBeenCalledExactlyOnceWith(diagnostic);
    emit({
      ...diagnostic,
      reason: "private-provider-error",
    } as unknown as SyncDiagnostic);
    emit({ ...diagnostic, captureId: "private-account" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("distinguishes extracted inputs, accepted observations and deferred evidence counts", () => {
    const report = createSyncDiagnosticReport();
    report.log({
      ...diagnostic,
      stage: "extraction",
      counts: { extracted: 23 },
    });
    report.log({
      ...diagnostic,
      stage: "reconciliation",
      reason: "evidence_deferred",
      counts: {
        observed: 20,
        deferred: 3,
        created: 2,
        changed: 3,
        unchangedTransactions: 15,
      },
    });
    expect(report.report().entries).toEqual([
      { ...diagnostic, stage: "extraction", counts: { extracted: 23 } },
      {
        ...diagnostic,
        stage: "reconciliation",
        reason: "evidence_deferred",
        counts: {
          observed: 20,
          deferred: 3,
          created: 2,
          changed: 3,
          unchangedTransactions: 15,
        },
      },
    ]);
  });

  it("bounds the opt-in report and reports the omitted count", () => {
    const report = createSyncDiagnosticReport();
    for (let index = 0; index < 230; index++) {
      report.log(diagnostic);
    }
    report.log({ event: "raw_error", message: "private-body" });
    expect(report.report()).toMatchObject({ dropped: 30, truncated: true });
    expect(report.report().entries).toHaveLength(200);
    report.report().entries[0]!.counts!.observed = 99;
    expect(report.report().entries[0]!.counts!.observed).toBe(20);
  });

  it.each(["throw", "reject"])(
    "keeps committed collection successful when its logger callbacks %s",
    async (mode) => {
      const { store, collector, adapter, ingestRun } = setup();
      const log = vi.fn(() => {
        if (mode === "throw") {
          throw new Error("private-logger-error");
        }
        return Promise.reject(new Error("private-logger-error"));
      });
      const summary = await collectFromStore(
        store,
        { connectionId: "private-connection", refreshId, onDiagnostic: log },
        collector,
        adapter,
      );
      await Promise.resolve();
      expect(summary).toMatchObject({
        status: "completed",
        observed: 20,
        unchangedTransactions: 15,
        created: 2,
        updated: 3,
        unlisted: 1,
      });
      expect(ingestRun).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalled();
    },
  );

  it("explains observed versus changed counts with correlation IDs and no provider data", async () => {
    const { store, collector, adapter } = setup();
    const report = createSyncDiagnosticReport();
    await collectFromStore(
      store,
      {
        connectionId: "private-connection",
        refreshId,
        onDiagnostic: report.log,
      },
      collector,
      adapter,
    );
    const entries = report.report().entries;
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining(diagnostic)]),
    );
    const applied = entries.find(
      (entry) => entry.stage === "ingest" && entry.outcome === "completed",
    )!;
    expect(applied.captureId).toMatch(/^[a-f0-9-]{36}$/);
    expect(applied.durationMs).toBeGreaterThanOrEqual(0);
    expect(
      entries
        .filter((entry) => entry.captureId)
        .every((entry) => entry.captureId === applied.captureId),
    ).toBe(true);
    const output = JSON.stringify(entries);
    expect(output).not.toContain("private-");
    expect(output).not.toContain("4321");
    expect(output).not.toContain("responseText");
  });

  it("reports a fixed persistence failure category while preserving the original error", async () => {
    const { store, collector, adapter, ingestRun } = setup();
    const error = new Error("private-driver-connection-string");
    ingestRun.mockRejectedValue(error);
    const report = createSyncDiagnosticReport();
    await expect(
      collectFromStore(
        store,
        {
          connectionId: "private-connection",
          refreshId,
          onDiagnostic: report.log,
        },
        collector,
        adapter,
      ),
    ).rejects.toBe(error);
    expect(report.report().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "collection",
          outcome: "failed",
          reason: "persistence_failure",
          failureCategory: "persistence",
        }),
      ]),
    );
    expect(JSON.stringify(report.report())).not.toContain("private-");
  });

  it("swallows sync and async operational log failures", async () => {
    expect(() =>
      safeLog(() => {
        throw new Error("private-log");
      })({}),
    ).not.toThrow();
    safeLog(async () => {
      throw new Error("private-log");
    })({});
    await Promise.resolve();
  });
});
