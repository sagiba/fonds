/** Invented, opt-in benchmark: npm run benchmark:reconciliation */
import { performance } from "node:perf_hooks";

import { emptyDetails, type TransactionInput } from "../src/domain/model.js";
import type { SourceAdapter } from "../src/domain/source-adapter.js";
import { type Backend, open } from "../tests/helpers/storage-harness.js";

const adapter: SourceAdapter = {
  provider: "synthetic-benchmark",
  parserVersion: "synthetic-v1",
  extract(text, context) {
    return {
      transactions: JSON.parse(text) as TransactionInput[],
      partitions: ["posted", "pending"].map((status) => ({
        accountKey: context.accountKey,
        status: status as "posted" | "pending",
        success: true,
        comparable: true,
      })),
      warnings: [],
      historical: false,
    };
  },
};

const selected = process.argv[process.argv.indexOf("--backend") + 1];
const backend: Backend = process.argv.includes("--backend")
  ? selected === "libsql"
    ? "libsql-local"
    : selected === "postgres"
      ? "postgres"
      : selected === "sqlite"
        ? "sqlite"
        : (() => {
            throw new Error("Use --backend sqlite, libsql or postgres");
          })()
  : "sqlite";
if (backend === "postgres" && !process.env.FONDS_TEST_POSTGRES_URL) {
  throw new Error(
    "PostgreSQL benchmark requires a disposable FONDS_TEST_POSTGRES_URL",
  );
}

async function measure(rowCount: number, historyCount: number) {
  const db = await open(backend);
  try {
    await db.ensureConnection({ id: "benchmark", provider: adapter.provider });
    const rows: TransactionInput[] = Array.from(
      { length: rowCount },
      (_, index) => ({
        sourceScope: "account",
        cardKey: "card",
        sourceKey: `purchase-${index}`,
        sourceAliases: [],
        identityStrength: "native",
        status: "posted",
        kind: "purchase",
        description: "Synthetic benchmark purchase",
        counterpartyName: null,
        merchantName: `Synthetic merchant ${index % 100}`,
        merchantProviderId: null,
        merchantCategoryCode: null,
        transactionDate: "2040-01-01",
        bookingDate: null,
        billingDate: null,
        amountMinor: -100,
        currency: "ILS",
        amountBasis: "purchase_commitment",
        originalAmountMinor: null,
        originalCurrency: null,
        installmentCount: null,
        details: emptyDetails(),
      }),
    );
    const responseText = JSON.stringify(rows);
    const capture = (index: number) =>
      db.ingestRun(
        {
          connectionId: "benchmark",
          runId: `run-${index}`,
          startedAt: "2040-01-01T00:00:00Z",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:benchmark",
              capturedAt: "2040-01-01T00:00:00Z",
              responseText,
            },
          ],
        },
        adapter,
      );
    if ((await capture(0)).created !== rowCount) {
      throw new Error("Invalid synthetic baseline");
    }
    // Bound setup memory: older runs retain empty synthetic capture bodies and identical
    // comparable account/scope metadata. Timed runs still archive all current rows.
    const columns =
      "connection_id,started_at,completed_at,status,collector_version,parser_version,snapshot_json,coverage_json,warnings_json,applied_at";
    const retained = await db.raw(
      "SELECT snapshot_json FROM sync_runs WHERE id = 'run-0'",
    );
    const snapshot = JSON.parse(String(retained[0]!.snapshot_json));
    snapshot.responses[0].responseText = "[]";
    const historySnapshot = JSON.stringify(snapshot);
    const metadataColumn = backend === "postgres" ? ",metadata_json" : "";
    const projectedColumns = columns.replace("snapshot_json", "?");
    for (let index = 1; index < historyCount; index++) {
      await db.raw(
        `INSERT INTO sync_runs(id,${columns}${metadataColumn}) SELECT ?,${projectedColumns}${metadataColumn} FROM sync_runs WHERE id = 'run-0'`,
        [`history-${index}`, historySnapshot],
      );
    }
    const times = [];
    for (let index = 1; index <= 3; index++) {
      const started = performance.now();
      const result = await capture(index);
      times.push(Math.round(performance.now() - started));
      if (
        result.status !== "completed" ||
        result.created ||
        result.updated ||
        result.unlisted
      ) {
        throw new Error("Benchmark must replay unchanged accepted rows");
      }
    }
    const metadata = await db.raw(
      "SELECT sum(length(coverage_json)) AS bytes FROM sync_runs",
    );
    const metadataBytes = { bytes: Number(metadata[0]?.bytes ?? 0) };
    return {
      backend,
      rowCount,
      historyCount,
      milliseconds: times,
      metadataBytes,
    };
  } finally {
    await db.close();
  }
}

for (const [rows, history] of [
  [1000, 1],
  [1000, 500],
  [10000, 1],
  [10000, 500],
]) {
  console.log(JSON.stringify(await measure(rows!, history!)));
}
