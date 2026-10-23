import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  createApplication,
  inProcessInvoker,
} from "../application/operations.js";
import type { Database } from "../storage/sqlite/database.js";
import { commandLine } from "./cli-invocation.js";
import {
  headline,
  joined,
  type Presentation,
  runnable,
  safeId,
} from "./cli-output.js";
import { CommandInputError } from "./operation-cli.js";
import { runtimeProvider } from "./providers.js";

export const DEMO_CONNECTION = "demo";

/** The demo ledger's MCP server name, apart from a real ledger's `fonds`. */
export const DEMO_SERVER_NAME = "fonds-demo";

/** Synthetic CAL captures replayed in order; fixed run IDs make reruns quiet. */
const DEMO_CAPTURES = [
  { file: "recent-01.json", run: "demo-recent-01", at: "2040-08-01T00:00:00Z" },
  { file: "recent-02.json", run: "demo-recent-02", at: "2040-08-02T00:00:00Z" },
] as const;

/**
 * The committed synthetic CAL fixtures, found relative to this module in a
 * bundled target, which carries copies in `demo/`, or in a checkout and its
 * `dist/` build.
 */
function demoFixtures(moduleUrl: string): URL {
  for (const candidate of [
    "./demo/",
    "../../tests/providers/cal/fixtures/",
    "../../../tests/providers/cal/fixtures/",
  ]) {
    const directory = new URL(candidate, moduleUrl);
    if (existsSync(new URL(DEMO_CAPTURES[0].file, directory))) {
      return directory;
    }
  }
  throw new CommandInputError(
    "The demo data is not part of this build; run demo from a source checkout or a packaged release.",
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

/** A short summary of the demo ledger and what to run next; no client setup. */
export async function demoSummary(
  database: Database,
  databasePath: string,
  command: string,
  p: Presentation,
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
  const db = ["--db", databasePath];
  const run = (args: string[]) => runnable(commandLine(command, args));
  const sections = [
    {
      title: "Try:",
      commands: [run(["list", ...db, "--limit", "5"]), run(["totals", ...db])],
    },
    {
      title: "Connect an assistant:",
      commands: [run(["mcp-config", ...db, "--name", DEMO_SERVER_NAME])],
    },
  ];
  const init = run(["init"]);
  // A path that must be escaped for display cannot be copied as a command.
  const shown = sections.every(({ commands }) =>
    commands.every((line) => line !== undefined),
  );
  return [
    headline(p, "ok", "Demo ready: synthetic CAL data, no real accounts"),
    `  ${joined(p, [`${count} transactions`, `ledger ${safeId(databasePath)}`])}`,
    "",
    ...(shown
      ? sections.flatMap(({ title, commands }, index) => [
          ...(index ? [""] : []),
          title,
          ...commands.map((line) => `  ${line}`),
        ])
      : [
          "Commands for this ledger are not shown: its path has characters a terminal cannot show as typed.",
        ]),
    "",
    `Running demo again changes nothing.${init ? ` For your own data, start with ${init}.` : ""}`,
    "",
  ].join("\n");
}
