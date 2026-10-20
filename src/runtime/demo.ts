import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createApplication,
  inProcessInvoker,
} from "../application/operations.js";
import type { Database } from "../storage/sqlite/database.js";
import { CommandInputError } from "./operation-cli.js";
import { runtimeProvider } from "./providers.js";

export const DEMO_CONNECTION = "demo";

/** Synthetic CAL captures replayed in order; fixed run IDs make reruns quiet. */
const DEMO_CAPTURES = [
  { file: "recent-01.json", run: "demo-recent-01", at: "2040-08-01T00:00:00Z" },
  { file: "recent-02.json", run: "demo-recent-02", at: "2040-08-02T00:00:00Z" },
] as const;

/**
 * The committed synthetic CAL fixtures, found relative to this module in a
 * checkout, its `dist/` build, or a bundled target.
 */
function demoFixtures(moduleUrl: string): URL {
  for (const candidate of [
    "../../tests/providers/cal/fixtures/",
    "../../../tests/providers/cal/fixtures/",
  ]) {
    const directory = new URL(candidate, moduleUrl);
    if (existsSync(new URL(DEMO_CAPTURES[0].file, directory))) {
      return directory;
    }
  }
  throw new CommandInputError(
    "The demo data is not part of this build; run demo from a source checkout.",
  );
}

/** Creates the demo connection and replays the synthetic captures; idempotent. */
export async function loadDemo(
  database: Database,
  moduleUrl: string = import.meta.url,
): Promise<void> {
  const fixtures = demoFixtures(moduleUrl);
  await database.ensureConnection({ id: DEMO_CONNECTION, provider: "cal" });
  const provider = runtimeProvider("cal");
  for (const capture of DEMO_CAPTURES) {
    const responseText = await readFile(
      new URL(capture.file, fixtures),
      "utf8",
    );
    const context = provider.prepareCapture(responseText, "synthetic-account");
    await database.ingestRun(
      {
        runId: capture.run,
        connectionId: DEMO_CONNECTION,
        responses: [
          {
            accountKey: "synthetic-account",
            ...context,
            capturedAt: capture.at,
            responseText,
          },
        ],
      },
      provider.adapter,
    );
  }
}

interface TransactionPage {
  data: unknown[];
  nextCursor?: string | null;
}

interface Totals {
  totals: { currency: string; amount: string; amountBasis: string }[];
}

/** A POSIX shell word, quoted only when it needs to be. */
function shellWord(value: string): string {
  return /^[\w./:@%+=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command a person types to run a sibling entry point from here. */
function entryCommand(path: string): string {
  const shown = relative(process.cwd(), path);
  return shellWord(
    shown.startsWith("..") || shown.startsWith(sep) ? path : shown,
  );
}

/** A short, human summary of the demo ledger and what to run next. */
export async function demoSummary(
  database: Database,
  databasePath: string,
  moduleUrl: string,
): Promise<string> {
  const invoker = inProcessInvoker(createApplication(database));
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = (await invoker.invoke("list_transactions", {
      connectionId: DEMO_CONNECTION,
      limit: 100,
      ...(cursor && { cursor }),
    })) as TransactionPage;
    count += page.data.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const { totals } = (await invoker.invoke("get_transaction_totals", {
    connectionId: DEMO_CONNECTION,
  })) as Totals;
  const source = moduleUrl.endsWith(".ts");
  const cli = fileURLToPath(moduleUrl);
  const server = fileURLToPath(
    new URL(source ? "../dist/server.js" : "./server.js", moduleUrl),
  );
  const run = source
    ? `npx tsx ${entryCommand(cli)}`
    : `node ${entryCommand(cli)}`;
  const db = shellWord(databasePath);
  const desktop = JSON.stringify({
    mcpServers: {
      "fonds-demo": {
        command: "node",
        args: [server, "--transport", "stdio", "--db", databasePath],
      },
    },
  });
  return [
    "Demo ledger ready: synthetic CAL data, not real transactions.",
    `  Database:      ${databasePath}`,
    `  Transactions:  ${count} on connection "${DEMO_CONNECTION}"`,
    `  Totals:        ${
      totals
        .map(
          (total) => `${total.currency} ${total.amount} (${total.amountBasis})`,
        )
        .join(", ") || "none"
    }`,
    "",
    "Look around:",
    `  ${run} list --db ${db} --limit 5`,
    `  ${run} totals --db ${db}`,
    "",
    "Ask an agent. Claude Code:",
    `  claude mcp add fonds-demo -- node ${shellWord(server)} --transport stdio --db ${db}`,
    "Claude Desktop (add to claude_desktop_config.json):",
    `  ${desktop}`,
    "",
    "Running demo again changes nothing. Your own data goes in a separate",
    'ledger; see "Use your own data" in the README.',
    "",
  ].join("\n");
}
