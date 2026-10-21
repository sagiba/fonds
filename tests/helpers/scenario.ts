import { expect } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import type { TransactionView } from "../../src/domain/read-model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { type Backend, type Harness, synthetic } from "./storage-harness.js";

const connectionId = "synthetic-scenario";

export interface Capture {
  rows: TransactionInput[];
  history?: boolean;
  incomplete?: boolean;
  adapter?: SourceAdapter;
  expectedStatus?: "completed" | "partial" | "failed";
  expectedUnlisted?: number;
}

/** Observation receipts may advance on replay; financial state must not. */
function semantic(row: TransactionView) {
  const { lastSeenAt: _last, lastSeenRunId: _run, details, ...facts } = row;
  const { sourceRefs: _refs, ...retained } = details;
  // currentRows is capture bookkeeping. Keep the retained provider evidence,
  // but not its indices into the current observation (including an empty shell).
  const provider = structuredClone(retained.provider);
  for (const namespace of Object.values(provider)) {
    if (
      !namespace ||
      typeof namespace !== "object" ||
      Array.isArray(namespace)
    ) {
      continue;
    }
    const identity = namespace.identity;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
      continue;
    }
    delete identity.currentRows;
    if (Object.keys(identity).length === 0) {
      delete namespace.identity;
    }
  }
  return { ...facts, details: { ...retained, provider } };
}

export async function scenario(db: Harness, backend: Backend) {
  await db.ensureConnection({ id: connectionId, provider: "cal" });
  let serial = 0;
  const commands: unknown[] = [];

  async function snapshot() {
    const rows = await db.listTransactions({
      connectionId,
      perspective: "all",
      includeSuperseded: true,
    });
    return {
      // Preserve multiplicity even when several rows have the same source key.
      rows: rows.map(semantic).sort((a, b) => a.id.localeCompare(b.id)),
      events: (await db.listEvents({ limit: 1000 })).filter(
        (event) => event.transactionId !== null,
      ),
      spending: await db.getTotals({ connectionId, perspective: "spending" }),
      billing: await db.getTotals({ connectionId, perspective: "billing" }),
      spendingMembers: (
        await db.listTransactions({ connectionId, perspective: "spending" })
      )
        .map((row) => row.id)
        .sort(),
      billingMembers: (
        await db.listTransactions({ connectionId, perspective: "billing" })
      )
        .map((row) => row.id)
        .sort(),
    };
  }

  type State = Awaited<ReturnType<typeof snapshot>>;

  type Check = (state: State, before: State) => void | Promise<void>;

  async function step(
    name: string,
    command: unknown,
    apply: () => Promise<unknown>,
    check: Check,
  ) {
    const before = await snapshot();
    commands.push({ name, command });
    try {
      await apply();
      const after = await snapshot();
      // Independent association invariant, without production membership helpers.
      for (const line of after.rows.filter(
        (row) =>
          row.purchaseId && row.presence !== "removed" && !row.supersededById,
      )) {
        expect(
          after.billingMembers,
          `purchase counted alongside ${line.sourceKey}`,
        ).not.toContain(line.purchaseId);
        expect(
          after.spendingMembers,
          `linked line counted as spending: ${line.sourceKey}`,
        ).not.toContain(line.id);
      }
      await check(after, before);
      return after;
    } catch (cause) {
      throw new Error(
        JSON.stringify(
          { backend, step: name, commands, before, after: await snapshot() },
          null,
          2,
        ),
        { cause },
      );
    }
  }

  async function capture(name: string, input: Capture, check: Check) {
    const apply = async () => {
      const base = input.adapter ?? synthetic;
      const adapter: SourceAdapter = {
        ...base,
        extract(text, context) {
          const result = base.extract(text, context);
          return {
            ...result,
            historical: input.history ?? false,
            partitions: result.partitions.map((partition) => ({
              ...partition,
              ...(input.incomplete
                ? { success: false, comparable: false }
                : {}),
            })),
          };
        },
      };
      serial++;
      const result = await db.ingestRun(
        {
          connectionId,
          runId: `scenario-${serial}`,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:scenario",
              capturedAt: new Date(
                Date.UTC(2040, 6, 1, 12, serial),
              ).toISOString(),
              responseText: JSON.stringify(input.rows),
              scope: { kind: input.history ? "history" : "recent" },
            },
          ],
        },
        adapter,
      );
      if (input.expectedStatus) {
        expect(result.status).toBe(input.expectedStatus);
      }
      if (input.expectedUnlisted !== undefined) {
        expect(result.unlisted).toBe(input.expectedUnlisted);
      }
      return result;
    };
    const command = {
      ...input,
      adapter: input.adapter ? "posting" : "synthetic",
    };
    let previous = await step(name, command, apply, check);
    for (let replay = 1; replay <= 2; replay++) {
      previous = await step(
        `${name}: replay ${replay}`,
        command,
        apply,
        async (after, before) => {
          expect(after).toEqual(previous);
          await check(after, before);
        },
      );
    }
    return previous;
  }

  async function byKey(key: string) {
    const rows = (
      await db.listTransactions({
        connectionId,
        perspective: "all",
        includeSuperseded: true,
      })
    ).filter((row) => row.sourceKey === key && !row.supersededById);
    expect(rows, `unique synthetic key ${key}`).toHaveLength(1);
    return rows[0]!;
  }

  return { capture, step, snapshot, byKey, connectionId };
}

export type ScenarioState = Awaited<
  ReturnType<Awaited<ReturnType<typeof scenario>>["snapshot"]>
>;

export function only(state: ScenarioState, key: string) {
  const rows = state.rows.filter(
    (row) => row.sourceKey === key && !row.supersededById,
  );
  expect(rows, `unique synthetic key ${key}`).toHaveLength(1);
  return rows[0]!;
}

/** Values and selected members are hand-written by the scenario, not inferred. */
export function accounting(
  state: ScenarioState,
  spending: number,
  billing: number | null,
  spendingKeys: string[],
  billingKeys: string[],
) {
  const keys = (ids: string[]) =>
    state.rows
      .filter((row) => ids.includes(row.id))
      .map((row) => row.sourceKey)
      .sort();
  expect(keys(state.spendingMembers)).toEqual([...spendingKeys].sort());
  expect(keys(state.billingMembers)).toEqual([...billingKeys].sort());
  expect(state.spending.totals).toEqual([
    {
      currency: "ILS",
      amountBasis: "purchase_commitment",
      amountMinor: spending,
    },
  ]);
  expect(state.billing.totals).toEqual(
    billing === null
      ? []
      : [{ currency: "ILS", amountBasis: null, amountMinor: billing }],
  );
}
