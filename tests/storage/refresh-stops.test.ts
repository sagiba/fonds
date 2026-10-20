import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emptyCounts,
  type Refresh,
  type RefreshWindow,
} from "../../src/application/refreshes.js";
import {
  presentRefresh,
  presentRefreshDetail,
  refreshOutputSchema,
} from "../../src/application/wire-output.js";
import type { ProviderStopReason } from "../../src/domain/refreshes.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const stoppingCases = [
  ["authentication_failed", true],
  ["authentication_challenge", true],
  ["rate_limited", false],
  ["budget_exhausted", false],
] as const;

for (const backend of backends) {
  describe(`durable refresh provider stops: ${backend}`, () => {
    let db: Harness;
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
    });
    afterEach(async () => db?.close());

    async function refresh(id: string, windows: RefreshWindow[] = []) {
      const value: Refresh = {
        id,
        connectionId: "synthetic",
        trigger: "manual",
        status: "running",
        skipReason: null,
        range: windows.length
          ? { from: windows.at(-1)!.from, to: windows[0]!.to }
          : null,
        occurrence: null,
        scheduledAt: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        requiresAttention: false,
        counts: emptyCounts(),
        failureCodes: [],
        failureReason: null,
        missed: null,
        windows,
      };
      await db.admitRefresh(value, { operator: true, now: Date.now() });
    }

    function failure(
      runId: string,
      refreshId: string,
      code: ProviderStopReason | "network_error" | "invalid_response",
    ) {
      return {
        runId,
        refreshId,
        connectionId: "synthetic",
        responses: [],
        failures: [{ accountKey: null, endpoint: "synthetic", code }],
      };
    }

    function accepted(runId: string, refreshId: string) {
      return {
        ...failure(runId, refreshId, "rate_limited"),
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic",
            capturedAt: new Date().toISOString(),
            responseText: JSON.stringify([row("one")]),
          },
        ],
      };
    }

    const window = (
      from: string,
      status: RefreshWindow["status"],
    ): RefreshWindow => ({
      from,
      to: from,
      status,
    });

    it("commits recent-refresh acceptance with a stop before a checkpoint without exposing it", async () => {
      await refresh("recent");
      expect(
        await db.ingestRun(accepted("recent-partial", "recent"), synthetic),
      ).toMatchObject({ status: "partial" });
      const peer = await db.peer();
      try {
        const stored = (await peer.getRefresh("recent"))!;
        expect(stored).toMatchObject({
          range: null,
          status: "running",
          hasAcceptedEvidence: true,
          providerStopReason: "rate_limited",
        });
        expect(presentRefresh(stored)).not.toHaveProperty(
          "hasAcceptedEvidence",
        );
        expect(presentRefreshDetail(stored)).not.toHaveProperty(
          "hasAcceptedEvidence",
        );
        refreshOutputSchema.parse(presentRefreshDetail(stored));
      } finally {
        await peer.close();
      }
      await db.withCollectionLock("synthetic", (locked) =>
        locked.updateRefresh("recent", { counts: emptyCounts() }),
      );
      expect((await db.getRefresh("recent"))!.hasAcceptedEvidence).toBe(true);
    });

    it("commits accepted evidence with a stop in its sole running window before a checkpoint", async () => {
      await refresh("refresh", [
        window("2026-10-01", "running"),
        window("2026-09-01", "completed"),
      ]);
      expect(
        await db.ingestRun(accepted("partial", "refresh"), synthetic),
      ).toMatchObject({
        status: "partial",
      });
      const peer = await db.peer();
      try {
        const stored = (await peer.getRefresh("refresh"))!;
        expect(stored).toMatchObject({ providerStopReason: "rate_limited" });
        expect(stored.windows).toEqual([
          { ...window("2026-10-01", "running"), hasAcceptedEvidence: true },
          { ...window("2026-09-01", "completed"), hasAcceptedEvidence: false },
        ]);
        const wire = presentRefreshDetail(stored);
        expect(wire.windows).toEqual([
          window("2026-10-01", "running"),
          window("2026-09-01", "completed"),
        ]);
        refreshOutputSchema.parse(wire);
      } finally {
        await peer.close();
      }
      await db.withCollectionLock("synthetic", (locked) =>
        locked.updateRefresh("refresh", {
          window: { from: "2026-10-01", status: "partial" },
        }),
      );
      expect((await db.getRefresh("refresh"))!.windows[0]).toMatchObject({
        status: "partial",
        hasAcceptedEvidence: true,
      });
    });

    it("does not guess an accepted window when multiple windows are running", async () => {
      await refresh("refresh", [
        window("2026-10-01", "running"),
        window("2026-09-01", "running"),
      ]);
      await db.ingestRun(accepted("ambiguous-window", "refresh"), synthetic);
      expect(
        (await db.getRefresh("refresh"))!.windows.map(
          (value) => value.hasAcceptedEvidence,
        ),
      ).toEqual([false, false]);
    });

    it("rolls accepted evidence back and does not attribute a recovered old run to a new window", async () => {
      await refresh("original", [window("2026-10-01", "running")]);
      if (backend === "postgres") {
        await db.raw(
          "CREATE FUNCTION synthetic_fail_accepted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic acceptance rollback'; END $$",
        );
        await db.raw(
          "CREATE TRIGGER synthetic_fail_accepted BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_fail_accepted()",
        );
      } else {
        await db.raw(
          "CREATE TRIGGER synthetic_fail_accepted BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic acceptance rollback'); END",
        );
      }
      try {
        await expect(
          db.ingestRun(accepted("recover-accepted", "original"), synthetic),
        ).rejects.toThrow();
        expect(
          (await db.getRefresh("original"))!.windows[0]!.hasAcceptedEvidence,
        ).toBe(false);
        expect((await db.getRefresh("original"))!.hasAcceptedEvidence).toBe(
          false,
        );
      } finally {
        await db.raw(
          `DROP TRIGGER synthetic_fail_accepted${backend === "postgres" ? " ON events" : ""}`,
        );
      }
      await db.withCollectionLock("synthetic", (locked) =>
        locked.updateRefresh("original", {
          status: "failed",
          finishedAt: new Date().toISOString(),
        }),
      );
      await refresh("executing", [window("2026-10-01", "running")]);
      await db.withCollectionLock("synthetic", (locked) =>
        locked.recoverPendingRuns(synthetic, undefined, "executing"),
      );
      expect(
        (await db.getRefresh("executing"))!.windows[0]!.hasAcceptedEvidence,
      ).toBe(false);
      expect(
        (await db.getRefresh("original"))!.windows[0]!.hasAcceptedEvidence,
      ).toBe(false);
      expect((await db.getRefresh("executing"))!.hasAcceptedEvidence).toBe(
        false,
      );
      expect((await db.getRefresh("original"))!.hasAcceptedEvidence).toBe(
        false,
      );
      expect((await db.getRefresh("executing"))!.counts.created).toBe(1);
    });

    it.each(stoppingCases)(
      "commits %s before a runtime checkpoint and keeps attention=%s",
      async (code, attention) => {
        await refresh("refresh");
        const input = failure("stop", "refresh", code);
        expect(await db.ingestRun(input, synthetic)).toMatchObject({
          status: "failed",
        });
        const peer = await db.peer();
        try {
          const stored = (await peer.getRefresh("refresh"))!;
          expect(stored).toMatchObject({
            status: "running",
            finishedAt: null,
            providerStopReason: code,
            requiresAttention: attention,
            counts: { ...emptyCounts(), failures: 1 },
          });
          expect(presentRefresh(stored)).not.toHaveProperty(
            "providerStopReason",
          );
          const wire = presentRefreshDetail(stored);
          expect(wire).not.toHaveProperty("providerStopReason");
          expect(refreshOutputSchema.parse(wire)).toMatchObject({
            requiresAttention: attention,
          });
        } finally {
          await peer.close();
        }
        expect(await db.raw("SELECT run_id FROM sync_run_bodies")).toEqual([]);
        await db.ingestRun(input, synthetic);
        await db.withCollectionLock("synthetic", async (locked) => {
          await locked.updateRefresh("refresh", { counts: emptyCounts() });
        });
        expect(await db.getRefresh("refresh")).toMatchObject({
          providerStopReason: code,
          requiresAttention: attention,
          counts: { ...emptyCounts(), failures: 1 },
        });
      },
    );

    it.each(["network_error", "invalid_response"] as const)(
      "keeps an ordinary %s failure distinct from a provider stop",
      async (code) => {
        await refresh("refresh");
        await db.ingestRun(failure("ordinary", "refresh", code), synthetic);
        const stored = (await db.getRefresh("refresh"))!;
        expect(stored.providerStopReason ?? null).toBeNull();
        expect(stored.requiresAttention).toBe(false);
        expect(stored.counts.failures).toBe(1);
        await expect(
          db.raw("UPDATE refreshes SET provider_stop_reason = ? WHERE id = ?", [
            code,
            "refresh",
          ]),
        ).rejects.toThrow();
      },
    );

    it("rolls back a stop with its failed application, then attributes recovered stops to the executing refresh", async () => {
      await refresh("original");
      if (backend === "postgres") {
        await db.raw(
          "CREATE FUNCTION synthetic_fail_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic stop rollback'; END $$",
        );
        await db.raw(
          "CREATE TRIGGER synthetic_fail_stop BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_fail_stop()",
        );
      } else {
        await db.raw(
          "CREATE TRIGGER synthetic_fail_stop BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic stop rollback'); END",
        );
      }
      try {
        await expect(
          db.ingestRun(
            failure("recover", "original", "rate_limited"),
            synthetic,
          ),
        ).rejects.toThrow();
        const unapplied = (await db.getRefresh("original"))!;
        expect(unapplied.providerStopReason ?? null).toBeNull();
        expect(unapplied.counts).toEqual(emptyCounts());
        expect(
          (
            await db.raw("SELECT applied_at FROM sync_runs WHERE id = ?", [
              "recover",
            ])
          )[0]!.applied_at,
        ).toBeNull();
      } finally {
        await db.raw(
          `DROP TRIGGER synthetic_fail_stop${backend === "postgres" ? " ON events" : ""}`,
        );
      }
      await db.withCollectionLock("synthetic", async (locked) => {
        await locked.updateRefresh("original", {
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
      });
      await refresh("executing");
      await db.withCollectionLock("synthetic", async (locked) => {
        await locked.recoverPendingRuns(synthetic, undefined, "executing");
      });
      const archived = (
        await db.raw(
          "SELECT refresh_id,applied_at FROM sync_runs WHERE id = ?",
          ["recover"],
        )
      )[0]!;
      expect(archived.refresh_id).toBe("original");
      expect(archived.applied_at).not.toBeNull();
      expect(
        (await db.getRefresh("original"))!.providerStopReason ?? null,
      ).toBeNull();
      expect(await db.getRefresh("executing")).toMatchObject({
        providerStopReason: "rate_limited",
        requiresAttention: false,
        counts: { ...emptyCounts(), failures: 1 },
      });
      await db.applyRun("recover", synthetic);
      await db.ingestRun(
        failure("ordinary-after", "executing", "network_error"),
        synthetic,
      );
      expect(await db.getRefresh("executing")).toMatchObject({
        providerStopReason: "rate_limited",
        requiresAttention: false,
        counts: { ...emptyCounts(), failures: 2 },
      });
    });
  });
}
