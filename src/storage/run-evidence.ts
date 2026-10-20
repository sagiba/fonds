import { canonicalJson } from "../domain/observations.js";
import {
  reconciliationFailure,
  type RunInput,
  runSchema,
  type SyncResult,
} from "../domain/plans/sync.js";
import type { Run } from "../domain/records.js";
import type { SourceAdapter } from "../domain/source-adapter.js";

/** Recorded for runs whose input names no collector, such as offline imports. */
const DEFAULT_COLLECTOR_VERSION = "offline-v1";

export function requireEvidenceRetention(adapter: SourceAdapter): void {
  if (typeof adapter.retainProviderEvidence !== "function") {
    throw new Error("Adapter must declare provider evidence retention");
  }
}

export function prepareRun(input: RunInput, adapter: SourceAdapter) {
  requireEvidenceRetention(adapter);
  const run = runSchema.parse(input);
  for (const item of [...run.responses, ...run.failures]) {
    if (item.scope) {
      item.scope = adapter.validateScope?.(item.scope) ?? item.scope;
    }
  }
  return run;
}

export function retainedRun(
  run: ReturnType<typeof prepareRun>,
  adapter: SourceAdapter,
  digest: string,
) {
  const startedAt = run.startedAt ?? new Date().toISOString();
  return {
    id: run.runId,
    connectionId: run.connectionId,
    startedAt,
    status: "started" as const,
    collectorVersion: run.collectorVersion ?? DEFAULT_COLLECTOR_VERSION,
    parserVersion: adapter.parserVersion,
    snapshot: {
      schemaVersion: 1 as const,
      responses: run.responses,
      failures: run.failures,
    },
    coverage: [],
    warnings: [],
    refreshId: run.refreshId ?? null,
    evidenceDigest: digest,
    bodyRetention: "staged" as const,
    bodyExpiresAt:
      run.debugArchiveDays === undefined
        ? null
        : new Date(
            Date.now() + run.debugArchiveDays * 86_400_000,
          ).toISOString(),
  };
}

export type RetainedRun = ReturnType<typeof retainedRun>;

export async function contentDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function runEvidenceDigest(
  run: ReturnType<typeof prepareRun>,
): Promise<string> {
  return contentDigest({
    digestSchema: "fonds-run-evidence-v1",
    connectionId: run.connectionId,
    collectorVersion: run.collectorVersion ?? DEFAULT_COLLECTOR_VERSION,
    responses: run.responses,
    failures: run.failures,
  });
}

export function replayResult(run: Run): SyncResult {
  if (run.status === "started") {
    throw new Error("Applied run has invalid status");
  }
  return {
    runId: run.id,
    replayed: true,
    created: 0,
    updated: 0,
    unlisted: 0,
    status: run.status,
    ...reconciliationFailure(run.warnings),
  };
}
