import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectFromStore } from "../../src/application/collection.js";
import { runSchema } from "../../src/domain/plans/sync.js";
import type { CollectionFailure } from "../../src/domain/records.js";
import type { ProviderCollector } from "../../src/domain/source-adapter.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "synthetic-optional-work";
const response = (day: number) => ({
  accountKey: "account",
  endpoint: "synthetic-financial",
  capturedAt: `2040-07-0${day}T00:00:00.000Z`,
  responseText: JSON.stringify([row("purchase")]),
});
const optionalFailure = (
  accountKey: string | null = "account",
): CollectionFailure => ({
  accountKey,
  endpoint: "synthetic-detail",
  code: "network_error",
  affectsCoverage: false,
});
const decode = (value: unknown) =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : value;

describe("optional collection failure input", () => {
  it.each([true, null, 0, "false"])(
    "rejects unsupported affectsCoverage value %j",
    (affectsCoverage) => {
      expect(
        runSchema.safeParse({
          connectionId,
          runId: "invalid",
          responses: [],
          failures: [{ ...optionalFailure(), affectsCoverage }],
        }).success,
      ).toBe(false);
    },
  );

  it("permits a same-account failure alongside a response only for explicit optional work", () => {
    const input = {
      connectionId,
      runId: "mixed",
      responses: [response(1)],
      failures: [optionalFailure()],
    };
    expect(runSchema.safeParse(input).success).toBe(true);
    const { affectsCoverage: _optional, ...mandatory } = optionalFailure();
    expect(
      runSchema.safeParse({ ...input, failures: [mandatory] }).success,
    ).toBe(false);
  });
});

describe.each(backends)("%s optional collection failures", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({
      id: connectionId,
      provider: synthetic.provider,
    });
  });
  afterEach(async () => db.close());

  async function saved(runId: string) {
    const result = (
      await db.raw(
        "SELECT metadata_json AS snapshot, coverage_json AS coverage, warnings_json AS warnings, status FROM sync_runs WHERE id = ?",
        [runId],
      )
    )[0]!;
    return {
      snapshot: decode(result.snapshot),
      coverage: decode(result.coverage),
      warnings: decode(result.warnings),
      status: result.status,
    };
  }

  it("archives and reports optional failure without fabricating financial coverage; replay stays quiet", async () => {
    const input = {
      connectionId,
      runId: "optional-failed",
      responses: [],
      failures: [optionalFailure()],
    };
    expect(await db.ingestRun(input, synthetic)).toMatchObject({
      status: "failed",
      created: 0,
      updated: 0,
      unlisted: 0,
    });
    expect(await saved(input.runId)).toMatchObject({
      snapshot: { failures: input.failures },
      coverage: [],
      warnings: ["network_error"],
      status: "failed",
    });
    const events = await db.listEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sync.failed",
        after: { status: "failed", coverage: [], warnings: ["network_error"] },
      }),
    );
    expect(await db.ingestRun(input, synthetic)).toMatchObject({
      replayed: true,
    });
    expect(await db.listEvents()).toEqual(events);
    const { affectsCoverage: _optional, ...mandatory } = optionalFailure();
    await expect(
      db.ingestRun({ ...input, failures: [mandatory] }, synthetic),
    ).rejects.toThrow("Run ID already refers to different evidence");
    await db.ingestRun(
      { connectionId, runId: "healthy", responses: [response(2)] },
      synthetic,
    );
    expect(
      (await db.listEvents()).some((event) => event.type === "sync.recovered"),
    ).toBe(false);
  });

  it("applies healthy same-account evidence while retaining optional partial status and warnings", async () => {
    const input = {
      connectionId,
      runId: "mixed",
      responses: [response(1)],
      failures: [optionalFailure()],
    };
    expect(await db.ingestRun(input, synthetic)).toMatchObject({
      status: "partial",
      created: 1,
    });
    expect(await saved(input.runId)).toMatchObject({
      snapshot: { failures: input.failures },
      coverage: [
        {
          status: "posted",
          success: true,
          comparable: true,
          resource: "synthetic-financial",
        },
        {
          status: "pending",
          success: true,
          comparable: true,
          resource: "synthetic-financial",
        },
      ],
      warnings: ["network_error"],
    });
    expect(await db.listTransactions()).toHaveLength(1);
  });

  it("keeps annotated financial content quiet when only an optional detail fetch fails", async () => {
    await db.ingestRun(
      { connectionId, runId: "baseline", responses: [response(1)] },
      synthetic,
    );
    const original = (await db.listTransactions())[0]!;
    const annotation = await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Keep the financial owner note",
    });
    const cursor = await db.latestEventId();
    const input = {
      connectionId,
      runId: "optional-only-change",
      responses: [response(2)],
      failures: [optionalFailure()],
    };
    expect(await db.ingestRun(input, synthetic)).toMatchObject({
      status: "partial",
      observed: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
      unlisted: 0,
    });
    expect(await db.getTransaction(original.id)).toMatchObject({
      id: original.id,
      amountMinor: original.amountMinor,
      currency: original.currency,
      version: original.version,
      presence: "seen",
      annotation,
      lastSeenRunId: input.runId,
    });
    expect(await saved(input.runId)).toMatchObject({
      coverage: [
        expect.objectContaining({
          status: "posted",
          success: true,
          comparable: true,
        }),
        expect.objectContaining({
          status: "pending",
          success: true,
          comparable: true,
        }),
      ],
      warnings: ["network_error"],
      snapshot: { failures: [optionalFailure()] },
    });
    const events = await db.listEvents({ after: cursor });
    expect(events.map((event) => event.type)).toEqual(["sync.partial"]);
    expect(await db.ingestRun(input, synthetic)).toMatchObject({
      replayed: true,
    });
    expect(await db.listEvents({ after: cursor })).toEqual(events);
    expect(
      await db.ingestRun(
        { connectionId, runId: "healthy-repeat", responses: [response(3)] },
        synthetic,
      ),
    ).toMatchObject({
      status: "completed",
      created: 0,
      updated: 0,
      unlisted: 0,
      unchanged: 1,
    });
    expect(
      (await db.listEvents({ after: cursor })).filter(
        (event) =>
          event.type.startsWith("transaction.") ||
          event.type === "sync.failed" ||
          event.type === "sync.recovered",
      ),
    ).toEqual([]);
  });

  it("keeps mandatory failed scopes until real recovery and never adds an optional account-null health failure", async () => {
    await db.ingestRun(
      {
        connectionId,
        runId: "optional-global",
        responses: [],
        failures: [
          {
            ...optionalFailure(null),
            scope: { kind: "recent", month: "2040-06" },
          },
        ],
      },
      synthetic,
    );
    await db.ingestRun(
      {
        connectionId,
        runId: "mandatory",
        responses: [],
        failures: [
          {
            accountKey: "account",
            endpoint: "synthetic-financial",
            code: "network_error",
          },
        ],
      },
      synthetic,
    );
    expect(await saved("mandatory")).toMatchObject({
      coverage: [
        { status: "posted", success: false },
        { status: "pending", success: false },
      ],
    });
    await db.ingestRun(
      { connectionId, runId: "retry", responses: [response(2)] },
      synthetic,
    );
    const recovery = (await db.listEvents()).filter(
      (event) => event.type === "sync.recovered",
    );
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ after: { failedScopes: [] } });
  });

  it("retains fatal codes and stops collection while the broader required-work interruption still affects coverage", async () => {
    let continued = false;
    const collector: ProviderCollector = {
      provider: synthetic.provider,
      collectorVersion: "synthetic",
      async *collect() {
        yield {
          type: "failure",
          failure: { ...optionalFailure(), code: "authentication_challenge" },
          fatal: true,
        };
        continued = true;
      },
    };
    expect(
      await collectFromStore(
        db,
        { connectionId, range: { from: "2040-07-01", to: "2040-07-31" } },
        collector,
        synthetic,
      ),
    ).toMatchObject({ status: "failed", failures: 2 });
    expect(continued).toBe(false);
    const runs = await db.raw(
      "SELECT metadata_json AS snapshot, coverage_json AS coverage, warnings_json AS warnings FROM sync_runs",
    );
    const optional = runs.map((run) => ({
      snapshot: decode(run.snapshot),
      coverage: decode(run.coverage),
      warnings: decode(run.warnings),
    }));
    // One run holds the unit's failures; the broader interruption stays required work.
    expect(optional).toEqual([
      expect.objectContaining({
        coverage: [],
        warnings: ["authentication_challenge", "authentication_challenge"],
        snapshot: expect.objectContaining({
          failures: [
            {
              ...optionalFailure(),
              code: "authentication_challenge",
              failedAt: expect.any(String),
            },
            {
              accountKey: null,
              endpoint: "collection",
              code: "authentication_challenge",
              scope: { kind: "history", from: "2040-07-01", to: "2040-07-31" },
              failedAt: expect.any(String),
            },
          ],
        }),
      }),
    ]);
  });
});
