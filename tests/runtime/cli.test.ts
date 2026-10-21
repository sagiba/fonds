import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { parseCredentialsKey } from "../../src/runtime/credential-vault.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { syncRuns } from "../../src/storage/sqlite/schema.js";

const collectorState = vi.hoisted(() => ({
  partial: false,
  calls: [] as unknown[],
  isracardCalls: [] as unknown[],
}));

vi.mock("../../src/providers/cal/collect.js", () => ({
  CAL_COLLECTOR_VERSION: "synthetic-cli-collector-v1",
  async *collectCal(options: unknown) {
    collectorState.calls.push(options);
    yield {
      type: "capture",
      capture: {
        accountKey: "SYNTHETIC-PRIVATE-ACCOUNT",
        endpoint: "synthetic:cal/recent",
        capturedAt: "2040-06-01T00:00:00Z",
        responseText: readFileSync(
          new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
          "utf8",
        ),
        scope: { kind: "recent" },
      },
    };
    if (collectorState.partial) {
      yield {
        type: "failure",
        failure: {
          accountKey: "SYNTHETIC-PRIVATE-ACCOUNT",
          endpoint: "synthetic:cal/history",
          code: "invalid_response",
        },
        fatal: false,
      };
    }
  },
}));

vi.mock("../../src/providers/isracard/collect.js", () => ({
  ISRACARD_COLLECTOR_VERSION: "synthetic-isracard-cli-v1",
  async *collectIsracard(options: unknown) {
    collectorState.isracardCalls.push(options);
    yield {
      type: "capture",
      capture: {
        accountKey: 'isracard:card:["11","1234"]',
        endpoint: "isracard:card-month",
        capturedAt: "2040-07-01T00:00:00Z",
        responseText: readFileSync(
          new URL(
            "../providers/isracard/fixtures/card-month.json",
            import.meta.url,
          ),
          "utf8",
        ),
        scope: {
          kind: "recent",
          month: "2040-07",
          cardKey: 'isracard:card:["11","1234"]',
        },
      },
    };
    if (collectorState.partial) {
      yield {
        type: "failure",
        failure: {
          accountKey: null,
          endpoint: "synthetic:isracard/history",
          code: "invalid_response",
        },
        fatal: false,
      };
    }
  },
}));

vi.mock("../../src/providers/isracard/node-http.js", () => ({
  createIsracardHttpClient: () => ({
    request: () => {
      throw new Error("CLI unit tests cannot make live requests");
    },
  }),
}));

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliPath = join(repositoryRoot, "src", "cli.ts");
const fixture = (name: string) =>
  join(repositoryRoot, "tests/providers/cal/fixtures", name);

/** The wire fields these tests read; operation output schemas define the rest. */
interface WireTransaction {
  id: string;
  cardId: string | null;
  version: number;
  status: "pending" | "posted";
  presence: "seen" | "not_returned" | "removed";
  supersededById: string | null;
  amount: { currency: string; amount: string } | null;
  merchant: { name: string | null; providerId: string | null } | null;
  annotation: {
    version: number;
    notes: string | null;
    category: string | null;
  } | null;
  source: { lastSyncRunId: string | null };
}

interface Page<Item> {
  data: Item[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Capture a stream write, acknowledging it as stdout would. */
function capture(append: (text: string) => void) {
  return (chunk: unknown, ...rest: unknown[]) => {
    append(String(chunk));
    const callback = rest.find((entry) => typeof entry === "function") as
      (() => void) | undefined;
    callback?.();
    return true;
  };
}

/** Run the CLI in-process; spawnCli covers the executable entry point. */
async function run(...args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(
    capture((text) => {
      stdout += text;
    }),
  );
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
    capture((text) => {
      stderr += text;
    }),
  );
  try {
    const status = await main(args);
    return { status, stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function spawnCli(args: string[], credentialsFd?: number) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 15_000,
      stdio:
        credentialsFd === undefined
          ? "pipe"
          : ["pipe", "pipe", "pipe", credentialsFd],
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

/** `connect`'s one stderr note: what turns scheduled collection on. */
const scheduleNote =
  "Scheduled refresh runs only when the service sets FONDS_REFRESH_SCHEDULE=daily (or hourly, or hours such as 9,13,18).\n";

async function success<T>(...args: string[]): Promise<T> {
  const result = await run(...args);
  expect(result.stderr).toBe(
    args[0] === "connect" && !args.includes("--offline") ? scheduleNote : "",
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as T;
}

async function seedConnection(db: string, id: string, provider: string) {
  await success("init", "--db", db);
  return success("connect", provider, "--name", id, "--offline", "--db", db);
}

/** Every row of every perspective, as list_transactions returns it. */
async function listRows(dbPath: string, ...args: string[]) {
  const page = await success<Page<WireTransaction>>(
    "list",
    "--db",
    dbPath,
    "--perspective",
    "all",
    ...args,
  );
  return page.data;
}

/** Detailed rows carry source facts such as the last sync run. */
async function detailedRows(dbPath: string) {
  const rows: WireTransaction[] = [];
  // One in-process CLI call at a time: each captures stdout while it runs.
  for (const row of await listRows(dbPath)) {
    rows.push(await getRow(dbPath, row.id));
  }
  return rows;
}

async function getRow(dbPath: string, transactionId: string) {
  const result = await success<{ transaction: WireTransaction }>(
    "get",
    "--db",
    dbPath,
    "--transaction-id",
    transactionId,
  );
  return result.transaction;
}

interface StoredEvent {
  id: number;
  type: string;
}

/** Private source keys and full event records are storage-only; read them there. */
async function idForSource(dbPath: string, sourceKeyPart: string) {
  const database = await openDatabase(dbPath);
  try {
    const row = (await database.listTransactions({})).find((transaction) =>
      transaction.sourceKey.includes(sourceKeyPart),
    );
    expect(row).toBeDefined();
    return row!.id;
  } finally {
    await database.close();
  }
}

async function storedEvents(dbPath: string, connectionId: string) {
  const database = await openDatabase(dbPath);
  try {
    return (await database.listEvents({ connectionId })) as StoredEvent[];
  } finally {
    await database.close();
  }
}

async function ingest(
  dbPath: string,
  runId: string,
  filename: string,
  connection = "synthetic-cli",
) {
  return success(
    "ingest",
    "--db",
    dbPath,
    "--connection",
    connection,
    "--account",
    "synthetic-account",
    "--run",
    runId,
    "--file",
    fixture(filename),
    "--captured-at",
    "2040-06-01T00:00:00Z",
  );
}

describe("offline CLI", () => {
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    collectorState.partial = false;
    collectorState.calls = [];
    collectorState.isracardCalls = [];
    directory = mkdtempSync(join(tmpdir(), "fonds-cli-"));
    dbPath = join(directory, "service.sqlite");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // Each spawned CLI may take seconds on a busy runner; spawnCli allows 15 s.
  it("runs as an executable with JSON stdout and a failing exit status", () => {
    const created = spawnCli(["init", "--db", dbPath]);
    expect(created).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(created.stdout)).toEqual({
      initialized: true,
    });
    // Without --db, the isolated test FONDS_HOME has no default ledger yet.
    expect(spawnCli(["list"])).toMatchObject({ status: 1, stdout: "" });
    expect(spawnCli(["list"]).stderr).toMatch(
      /^No Fonds database at .*fonds\.sqlite; run fonds init first, or try fonds demo\.\n$/,
    );
  }, 60_000);

  it("initializes storage without adding a provider connection", async () => {
    const result = await run("init", "--db", dbPath);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(dbPath)).toBe(true);
    expect(await success("list-connections", "--db", dbPath)).toMatchObject({
      data: [],
    });
  });

  it("rejects an unsupported provider before creating a connection", async () => {
    const result = await run(
      "connect",
      "unsupported",
      "--name",
      "primary",
      "--db",
      dbPath,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No source adapter or live collector");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("ingests fixtures, keeps edits through replay/correction, queries, and backs up", async () => {
    expect(await seedConnection(dbPath, "synthetic-cli", "cal")).toEqual({
      connectionId: "synthetic-cli",
      provider: "cal",
      credentials: "none",
    });
    const ingest = async (runId: string, filename: string) =>
      await success(
        "ingest",
        "--db",
        dbPath,
        "--connection",
        "synthetic-cli",
        "--account",
        "synthetic-account",
        "--run",
        runId,
        "--file",
        fixture(filename),
        "--captured-at",
        "2040-06-01T00:00:00Z",
      );
    await ingest("synthetic-run-1", "recent-01.json");
    const baseline = await success<Page<WireTransaction>>(
      "list",
      "--db",
      dbPath,
      "--status",
      "posted",
      "--perspective",
      "all",
    );
    expect(baseline.data).toHaveLength(19);
    const corrected = baseline.data.find(
      (row) => row.merchant?.providerId === "SYNTHETIC-MERCHANT-CORRECTED",
    );
    expect(corrected).toBeDefined();
    expect(corrected!.amount).toEqual({ currency: "ILS", amount: "-72.10" });
    const get = (database = dbPath) =>
      success<{ transaction: WireTransaction }>(
        "get",
        "--db",
        database,
        "--transaction-id",
        corrected!.id,
      ).then((result) => result.transaction);
    const annotate = (expectedVersion: string, ...fields: string[]) =>
      run(
        "annotate",
        "--db",
        dbPath,
        "--transaction-id",
        corrected!.id,
        "--expected-version",
        expectedVersion,
        ...fields,
      );
    expect(
      JSON.parse((await annotate("0", "--notes", "Synthetic CLI note")).stdout),
    ).toEqual({ annotation: { transactionId: corrected!.id, version: 1 } });
    expect((await annotate("1", "--category", "Example category")).status).toBe(
      0,
    );
    const annotated = await get();
    expect(annotated.annotation).toMatchObject({
      version: 2,
      notes: "Synthetic CLI note",
      category: "Example category",
    });
    const stale = await annotate("0", "--notes", "Rejected note");
    expect(stale.status).toBe(1);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toMatch(/^conflict: /);
    const events = (...args: string[]) =>
      success<Page<{ id: number }>>(
        "events",
        "--db",
        dbPath,
        "--connection-id",
        "synthetic-cli",
        ...args,
      );
    const beforeReplay = await events();
    await ingest("synthetic-run-1", "recent-01.json");
    expect(await events()).toEqual(beforeReplay);
    await ingest("synthetic-run-2", "recent-02.json");
    const updated = await get();
    expect(updated.amount).toEqual({ currency: "ILS", amount: "-75.60" });
    expect(updated.annotation).toEqual(annotated.annotation);
    expect((await events("--limit", "1")).data).toHaveLength(1);
    const totals = await success<{
      totals: { currency: string; amount: string }[];
      excludedCount: number;
      excluded: Record<string, number>;
    }>("totals", "--db", dbPath, "--connection-id", "synthetic-cli");
    expect(Object.keys(totals).sort()).toEqual([
      "excluded",
      "excludedCount",
      "fxFeeUnknownCount",
      "fxFees",
      "includedCount",
      "totals",
    ]);
    expect(Object.keys(totals.excluded).sort()).toEqual([
      "authorization",
      "pending",
      "retiredOrRemoved",
      "transferOrIncome",
      "unresolved",
    ]);
    expect(totals.excludedCount).toBe(
      Object.values(totals.excluded).reduce((sum, count) => sum + count, 0),
    );
    expect(totals.totals.length).toBeGreaterThan(0);
    for (const group of totals.totals) {
      expect(group.amount).toMatch(/^-?\d+(\.\d+)?$/);
    }
    const backupPath = join(directory, "backup.sqlite");
    expect(
      await success("backup", "--db", dbPath, "--out", backupPath),
    ).toEqual({
      backupPath,
      // The secrets stay in the state directory, backed up beside the copy.
      stateDirectory: process.env.FONDS_HOME,
    });
    expect(await get(backupPath)).toEqual(updated);
    expect((await annotate("2", "--notes", "")).status).toBe(0);
    expect((await get()).annotation).toMatchObject({
      notes: null,
      category: "Example category",
    });
  });

  it("filters seeded transactions by the --merchant-name card acceptor name", async () => {
    await seedConnection(dbPath, "synthetic-cli", "cal");
    await ingest(dbPath, "merchant-filter-baseline", "recent-01.json");
    const list = (...args: string[]) =>
      success<Page<WireTransaction>>(
        "list",
        "--db",
        dbPath,
        "--perspective",
        "all",
        ...args,
      ).then((page) => page.data);
    const baseline = await list();
    const purchase = baseline.find(
      (row) => row.merchant?.providerId === "SYNTHETIC-MERCHANT-REGULAR",
    )!;
    expect(purchase.merchant!.name).toBe("בית עסק סינתטי REGULAR");
    const filtered = await list("--merchant-name", purchase.merchant!.name!);
    expect(filtered.map((row) => row.id)).toEqual(
      baseline
        .filter((row) => row.merchant?.name === purchase.merchant!.name)
        .map((row) => row.id),
    );
    expect(filtered).toHaveLength(2);
    expect(baseline.length).toBeGreaterThan(filtered.length);
    expect(
      await list("--merchant-name", "Missing synthetic card acceptor"),
    ).toEqual([]);
  });

  it("keeps ingest --account as the private scope and filters list by --billing-account-id", async () => {
    await seedConnection(dbPath, "synthetic-cli", "cal");
    await ingest(dbPath, "billing-account-baseline", "recent-01.json");
    const list = (...args: string[]) =>
      success<Page<WireTransaction>>(
        "list",
        "--db",
        dbPath,
        "--perspective",
        "all",
        ...args,
      ).then((page) => page.data);
    const baseline = await list();
    const database = await openDatabase(dbPath);
    let accountId: string;
    let cardId: string;
    try {
      // The private account scope never appears on the wire; read it from storage.
      expect(
        (await database.listTransactions({})).every(
          (row) => row.sourceScope === "synthetic-account",
        ),
      ).toBe(true);
      // Replay created reference-only cards; discovery adds the billing account.
      expect(
        (await database.listAccounts({ connectionId: "synthetic-cli" }))
          .accounts,
      ).toEqual([]);
      await database.recordCardDiscovery("synthetic-cli", {
        observedAt: "2040-06-01T00:00:00Z",
        cards: [
          {
            cardKey: "SYNTHETIC-CARD-A",
            last4: null,
            billingAccount: { providerKey: "synthetic-account" },
          },
        ],
      });
      accountId = (
        await database.listAccounts({ connectionId: "synthetic-cli" })
      ).accounts[0]!.id;
      cardId = (
        await database.listCards({ connectionId: "synthetic-cli" })
      ).cards.find((card) => card.providerKey === "SYNTHETIC-CARD-A")!.id;
    } finally {
      await database.close();
    }
    const billed = await list("--billing-account-id", accountId);
    expect(billed.length).toBeGreaterThan(0);
    expect(billed.every((row) => row.cardId === cardId)).toBe(true);
    expect(billed.length).toBe(
      baseline.filter((row) => row.cardId === cardId).length,
    );
    const legacy = await run("list", "--db", dbPath, "--account", "x");
    expect(legacy.status).not.toBe(0);
  });

  it("validates missing or malformed arguments before creating a database", async () => {
    for (const args of [
      ["refresh", "--connection", "synthetic-cli"],
      ["refresh"],
      ["refresh", "--connection", "synthetic-cli", "--history-mode", "search"],
      [
        "refresh",
        "--connection",
        "synthetic-cli",
        "--history-mode",
        "unknown",
        "--from",
        "2040-01-01",
        "--to",
        "2040-06-01",
      ],
      [
        "refresh",
        "--connection",
        "synthetic-cli",
        "--search-window-months",
        "3",
      ],
      [
        "refresh",
        "--connection",
        "synthetic-cli",
        "--history-mode",
        "monthly",
        "--search-window-months",
        "3",
        "--from",
        "2040-01-01",
        "--to",
        "2040-06-01",
      ],
      [
        "refresh",
        "--connection",
        "synthetic-cli",
        "--history-mode",
        "statements",
        "--search-window-months",
        "3",
        "--from",
        "2040-01-01",
        "--to",
        "2040-06-01",
      ],
      [
        "refresh",
        "--connection",
        "synthetic-cli",
        "--history-mode",
        "search",
        "--search-window-months",
        "2",
        "--from",
        "2040-01-01",
        "--to",
        "2040-06-01",
      ],
      ["refresh", "--connection", "synthetic-cli", "--from", "2040-01-01"],
      [
        "refresh",
        "--connection",
        "synthetic-cli",
        "--from",
        "2040-02-30",
        "--to",
        "2040-03-01",
      ],
      [
        "refresh",
        "--connection",
        "synthetic-cli",
        "--from",
        "2040-03-01",
        "--to",
        "2040-02-01",
      ],
      ["refresh", "--connection", "synthetic-cli", "--credentials-fd", "0"],
      ["ingest", "--connection", "synthetic-cli"],
      [
        "annotate",
        "--transaction-id",
        "missing",
        "--expected-version",
        "-1",
        "--notes",
        "Example",
      ],
      ["list", "--status", "invalid"],
      ["list", "--limit", "ten"],
      ["get", "--transaction-id", "missing", "--detail", "yes"],
      ["events", "--connection-id", "synthetic-cli", "--limit", "0"],
      ["events", "--connection-id", "synthetic-cli", "--limit", "201"],
      ["events"],
      ["consume", "--connection", "synthetic-cli"],
      [
        "consume",
        "--connection",
        "synthetic-cli",
        "--consumer",
        " ",
        "--limit",
        "2",
      ],
      [
        "consume",
        "--connection",
        "synthetic-cli",
        "--consumer",
        "local",
        "--limit",
        "1001",
      ],
      [
        "remove",
        "--transaction-id",
        "missing",
        "--expected-transaction-version",
        "0",
        "--reason",
        "Example",
      ],
      [
        "remove",
        "--transaction-id",
        "missing",
        "--expected-transaction-version",
        "1",
        "--reason",
        " ",
      ],
      [
        "link",
        "--transaction-id",
        "pending",
        "--posted-id",
        "posted",
        "--reason",
        "Example",
      ],
      [
        "link",
        "--transaction-id",
        "pending",
        "--posted-id",
        "posted",
        "--expected-pending-transaction-version",
        "1",
        "--expected-posted-transaction-version",
        "1",
        "--expected-pending-annotation-version",
        "-1",
        "--expected-posted-annotation-version",
        "0",
        "--reason",
        "Example",
      ],
      ["update-annotation", "--transaction-id", "x", "--tags", "[unquoted]"],
      ["init", "--note", "unsupported"],
      [
        "ingest",
        "--connection",
        "synthetic-cli",
        "--account",
        "account",
        "--run",
        "run",
        "--file",
        fixture("recent-01.json"),
        "--captured-at",
        "invalid",
      ],
    ]) {
      const result = await run(...args, "--db", dbPath);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toBe("");
      expect(existsSync(dbPath)).toBe(false);
    }
    expect((await run("list")).stderr).toMatch(/^No Fonds database at /);
  });

  it("keeps live collection private and unavailable to unsupported providers", async () => {
    await seedConnection(dbPath, "synthetic-cli", "cal");
    expect(statSync(dbPath).mode & 0o077).toBe(0);
    // refresh is always live, so --live is not one of its options.
    const liveFlag = await run(
      "refresh",
      "--live",
      "--db",
      dbPath,
      "--connection",
      "synthetic-cli",
    );
    expect(liveFlag).toMatchObject({ status: 1, stdout: "" });
    const noTerminal = await run(
      "refresh",
      "--db",
      dbPath,
      "--connection",
      "synthetic-cli",
    );
    expect(noTerminal.stderr).toContain("interactive terminal");
    expect(noTerminal.stdout).toBe("");
    const secretArgument = await run(
      "refresh",
      "--db",
      dbPath,
      "--connection",
      "synthetic-cli",
      "--password",
      "DO-NOT-ECHO-SYNTHETIC",
    );
    expect(secretArgument.status).toBe(1);
    expect(secretArgument.stderr).not.toContain("DO-NOT-ECHO-SYNTHETIC");
    const seeded = await openDatabase(dbPath);
    try {
      await seeded.ensureConnection({
        id: "bank-cli",
        provider: "synthetic-bank",
      });
    } finally {
      await seeded.close();
    }
    const unsupported = await run(
      "refresh",
      "--db",
      dbPath,
      "--connection",
      "bank-cli",
    );
    expect(unsupported.stderr).toContain("No source adapter or live collector");
    expect(unsupported.stdout).toBe("");
    const unsupportedIngest = await run(
      "ingest",
      "--db",
      dbPath,
      "--connection",
      "bank-cli",
      "--account",
      "synthetic-account",
      "--run",
      "unsupported-run",
      "--file",
      fixture("recent-01.json"),
    );
    expect(unsupportedIngest.status).toBe(1);
    expect(unsupportedIngest.stderr).toContain(
      "No source adapter or live collector",
    );
    expect(unsupportedIngest.stdout).toBe("");
    chmodSync(dbPath, 0o644);
    const publicDatabase = await run(
      "refresh",
      "--db",
      dbPath,
      "--connection",
      "synthetic-cli",
    );
    expect(publicDatabase.stderr).toContain("private current-owner");
    expect(publicDatabase.stdout).toBe("");
    chmodSync(dbPath, 0o600);
    chmodSync(directory, 0o755);
    const publicDirectory = await run(
      "refresh",
      "--db",
      dbPath,
      "--connection",
      "synthetic-cli",
    );
    expect(publicDirectory.stderr).toContain("private current-owner");
    expect(publicDirectory.stdout).toBe("");
  });

  it("rejects CAL-only history controls for Isracard before prompting for credentials", async () => {
    await seedConnection(dbPath, "isracard-cli", "isracard");
    for (const options of [
      ["--history-mode", "monthly"],
      ["--search-window-months", "3"],
    ]) {
      const result = await run(
        "refresh",
        "--db",
        dbPath,
        "--connection",
        "isracard-cli",
        "--from",
        "2040-01-01",
        "--to",
        "2040-03-01",
        ...options,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("are not supported by this provider");
      expect(result.stdout).toBe("");
    }
  });

  it("validates Isracard operator budgets and passes detail opt-in to the collector", async () => {
    await seedConnection(dbPath, "synthetic-cli", "cal");
    await seedConnection(dbPath, "isracard-cli", "isracard");
    for (const [connection, flag, value, message] of [
      ["isracard-cli", "--call-budget", "101", "at most 100"],
      ["isracard-cli", "--call-budget", "0", "at least 1"],
      [
        "synthetic-cli",
        "--call-budget",
        "50",
        "is not supported by this provider",
      ],
      ["isracard-cli", "--max-details", "21", "at most 20"],
      ["isracard-cli", "--max-details", "-1", "Invalid arguments"],
      ["isracard-cli", "--max-details", "1.5", "at least 0"],
      [
        "synthetic-cli",
        "--max-details",
        "0",
        "is not supported by this provider",
      ],
    ] as const) {
      const result = await run(
        "refresh",
        "--db",
        dbPath,
        "--connection",
        connection,
        flag,
        value,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
    }
    const credentialPath = join(directory, "invented-credentials.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({
        username: "INVENTED-PRIVATE-USER",
        password: "INVENTED-PRIVATE-PASSWORD",
        cardSuffix: "123456",
      }),
      { mode: 0o600 },
    );
    for (const maxDetails of ["0", "7", "20"]) {
      const fd = openSync(credentialPath, "r");
      await run(
        "refresh",
        "--db",
        dbPath,
        "--connection",
        "isracard-cli",
        "--credentials-fd",
        String(fd),
        "--call-budget",
        "74",
        "--max-details",
        maxDetails,
      ).finally(() => closeSync(fd));
    }
    expect(collectorState.isracardCalls).toMatchObject(
      [0, 7, 20].map((maxDetails) => ({ callBudget: 74, maxDetails })),
    );
  });

  it("requires an Isracard suffix through the private credential channel before collection", async () => {
    await seedConnection(dbPath, "isracard-cli", "isracard");
    const credentialPath = join(directory, "invented-credentials.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({
        username: "INVENTED-PRIVATE-USER",
        password: "INVENTED-PRIVATE-PASSWORD",
      }),
      { mode: 0o600 },
    );
    const fd = openSync(credentialPath, "r");
    const result = await run(
      "refresh",
      "--db",
      dbPath,
      "--connection",
      "isracard-cli",
      "--credentials-fd",
      String(fd),
    ).finally(() => closeSync(fd));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Isracard credentials require username, password and cardSuffix",
    );
    expect(result.stderr).not.toContain("INVENTED-PRIVATE");
    expect(collectorState.isracardCalls).toEqual([]);
    expect(collectorState.calls).toEqual([]);
  });

  it("selects the Isracard adapter for offline ingest and same-run replay", async () => {
    await seedConnection(dbPath, "isracard-cli", "isracard");
    const args = [
      "ingest",
      "--db",
      dbPath,
      "--connection",
      "isracard-cli",
      "--account",
      'isracard:card:["11","1234"]',
      "--run",
      "isracard-offline",
      "--file",
      join(repositoryRoot, "tests/providers/isracard/fixtures/card-month.json"),
      "--captured-at",
      "2040-07-01T00:00:00Z",
      "--endpoint",
      "isracard:card-month",
    ];
    expect(await success(...args)).toMatchObject({
      created: 2,
      status: "completed",
      replayed: false,
    });
    const baseline = await listRows(dbPath);
    expect(baseline).toHaveLength(2);
    const database = await openDatabase(dbPath);
    try {
      // Source keys are private; storage shows the Isracard adapter made them.
      expect(
        (await database.listTransactions({})).every((row) =>
          row.sourceKey.startsWith("isracard:"),
        ),
      ).toBe(true);
    } finally {
      await database.close();
    }
    await success(
      "annotate",
      "--db",
      dbPath,
      "--transaction-id",
      baseline[0]!.id,
      "--expected-version",
      "0",
      "--notes",
      "Synthetic Isracard note",
    );
    expect(await success(...args)).toMatchObject({
      created: 0,
      updated: 0,
      replayed: true,
    });
    const transaction = await getRow(dbPath, baseline[0]!.id);
    expect(transaction.annotation?.notes).toBe("Synthetic Isracard note");
  });

  it("rejects an Isracard account mismatch before retaining source evidence", async () => {
    await seedConnection(dbPath, "isracard-cli", "isracard");
    const result = await run(
      "ingest",
      "--db",
      dbPath,
      "--connection",
      "isracard-cli",
      "--account",
      "SYNTHETIC-WRONG-ACCOUNT",
      "--run",
      "mismatched-source",
      "--file",
      join(repositoryRoot, "tests/providers/isracard/fixtures/card-month.json"),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--account must match the capture's account identity",
    );
    expect(result.stderr).not.toContain("SYNTHETIC-WRONG-ACCOUNT");
    expect(result.stderr).not.toContain("SYNTHETIC-CARD-GUID");
    const database = await openDatabase(dbPath);
    try {
      expect(await database.orm.select().from(syncRuns).all()).toEqual([]);
      expect(await database.listTransactions()).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("derives offline Isracard history scope and preserves newer current facts", async () => {
    await seedConnection(dbPath, "isracard-cli", "isracard");
    const original = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "tests/providers/isracard/fixtures/card-month.json",
        ),
        "utf8",
      ),
    );
    const historyPath = join(directory, "invented-history.json");
    const history = { ...original, mode: "history" };
    writeFileSync(historyPath, JSON.stringify(history));
    const args = [
      "ingest",
      "--db",
      dbPath,
      "--connection",
      "isracard-cli",
      "--account",
      'isracard:card:["11","1234"]',
    ];
    expect(
      await success(
        ...args,
        "--run",
        "offline-history",
        "--file",
        historyPath,
        "--captured-at",
        "2040-07-01T00:00:00Z",
      ),
    ).toMatchObject({ status: "completed", created: 2 });
    const initial = await listRows(dbPath);
    expect(initial).toHaveLength(2);
    expect(initial.every((row) => row.presence === "not_returned")).toBe(true);
    expect(
      await success(
        ...args,
        "--run",
        "offline-current",
        "--file",
        join(
          repositoryRoot,
          "tests/providers/isracard/fixtures/card-month.json",
        ),
        "--captured-at",
        "2040-08-01T00:00:00Z",
      ),
    ).toMatchObject({ status: "completed", created: 0 });
    const current = await detailedRows(dbPath);
    expect(
      current.every(
        (row) =>
          row.presence === "seen" &&
          row.source.lastSyncRunId === "offline-current",
      ),
    ).toBe(true);
    history.responses.digital = history.responses.digital
      .replace("Synthetic merchant", "Outdated synthetic merchant")
      .replace("86.4", "999.9");
    writeFileSync(historyPath, JSON.stringify(history));
    expect(
      await success(
        ...args,
        "--run",
        "later-offline-history",
        "--file",
        historyPath,
        "--captured-at",
        "2040-08-02T00:00:00Z",
      ),
    ).toMatchObject({ status: "completed", created: 0, updated: 0 });
    const facts = (row: WireTransaction) => ({
      id: row.id,
      merchantName: row.merchant?.name,
      amount: row.amount,
      presence: row.presence,
      lastSyncRunId: row.source.lastSyncRunId,
    });
    expect((await detailedRows(dbPath)).map(facts)).toEqual(current.map(facts));
  });

  it.each([false, true])(
    "dispatches Isracard collection with private suffix and bounded summaries (partial=%s)",
    async (partial) => {
      collectorState.partial = partial;
      await seedConnection(dbPath, "isracard-cli", "isracard");
      const credentialPath = join(directory, "invented-credentials.json");
      writeFileSync(
        credentialPath,
        JSON.stringify({
          username: "INVENTED-PRIVATE-USER",
          password: "INVENTED-PRIVATE-PASSWORD",
          cardSuffix: "001234",
        }),
        { mode: 0o600 },
      );
      const fd = openSync(credentialPath, "r");
      const result = await run(
        "refresh",
        "--db",
        dbPath,
        "--connection",
        "isracard-cli",
        "--credentials-fd",
        String(fd),
        "--from",
        "2040-01-01",
        "--to",
        "2040-06-01",
      ).finally(() => closeSync(fd));
      expect(result.status).toBe(partial ? 2 : 0);
      expect(result.stderr).toBe("");
      // A ranged refresh requests one calendar month at a time, newest first.
      expect(JSON.parse(result.stdout)).toMatchObject({
        type: "refresh_summary",
        status: partial ? "partial" : "completed",
        captures: 6,
        failures: partial ? 6 : 0,
        created: 2,
        requestedRange: { from: "2040-01-01", to: "2040-06-01" },
      });
      expect(collectorState.calls).toEqual([]);
      expect(
        collectorState.isracardCalls.map(
          (call) => (call as { range: unknown }).range,
        ),
      ).toEqual([
        { from: "2040-06-01", to: "2040-06-01" },
        { from: "2040-05-01", to: "2040-05-31" },
        { from: "2040-04-01", to: "2040-04-30" },
        { from: "2040-03-01", to: "2040-03-31" },
        { from: "2040-02-01", to: "2040-02-29" },
        { from: "2040-01-01", to: "2040-01-31" },
      ]);
      expect(collectorState.isracardCalls[0]).toMatchObject({
        credentials: {
          username: "INVENTED-PRIVATE-USER",
          password: "INVENTED-PRIVATE-PASSWORD",
          cardSuffix: "001234",
        },
        httpClient: { request: expect.any(Function) },
      });
      for (const secret of [
        "INVENTED-PRIVATE",
        "001234",
        "SYNTHETIC-CARD-GUID",
        "Synthetic merchant",
      ]) {
        expect(result.stdout).not.toContain(secret);
      }
    },
  );

  it.each([false, true])(
    "reports collection counts with a distinct partial exit code (partial=%s)",
    async (partial) => {
      collectorState.partial = partial;
      await seedConnection(dbPath, "synthetic-cli", "cal");
      const credentialPath = join(directory, "invented-credentials.json");
      writeFileSync(
        credentialPath,
        "INVENTED-PRIVATE-USER:INVENTED-PRIVATE-PASSWORD:WITH-COLON\n",
        { mode: 0o600 },
      );
      const fd = openSync(credentialPath, "r");
      const result = await run(
        "refresh",
        "--db",
        dbPath,
        "--connection",
        "synthetic-cli",
        "--credentials-fd",
        String(fd),
      ).finally(() => closeSync(fd));
      expect(result.status).toBe(partial ? 2 : 0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        type: "refresh_summary",
        status: partial ? "partial" : "completed",
        captures: 1,
        unchanged: 0,
        observed: 21,
        unchangedTransactions: 0,
        unlisted: 0,
        failures: partial ? 1 : 0,
        ...(partial && { failureCodes: ["invalid_response"] }),
        created: 21,
        updated: 0,
      });
      expect(result.stdout).not.toContain("SYNTHETIC-PRIVATE-ACCOUNT");
      expect(result.stdout).not.toContain("INVENTED-PRIVATE");
      expect(await listRows(dbPath)).toHaveLength(21);
      // The CLI run is the connection's latest refresh, as get_connection shows.
      const { connection } = await success<{
        connection: { latestRefresh: Record<string, unknown> };
      }>("get-connection", "--db", dbPath, "--connection-id", "synthetic-cli");
      expect(connection.latestRefresh).toMatchObject({
        status: partial ? "partial" : "completed",
        requiresAttention: false,
        counts: {
          captures: 1,
          unchanged: 0,
          observed: 21,
          unchangedTransactions: 0,
          unlisted: 0,
          failures: partial ? 1 : 0,
          created: 21,
          updated: 0,
        },
        failureCodes: partial ? ["invalid_response"] : [],
      });
      expect(typeof connection.latestRefresh.finishedAt).toBe("string");
    },
  );

  it("accepts the inherited descriptor channel and sanitizes malformed secret input", async () => {
    await seedConnection(dbPath, "synthetic-cli", "cal");
    const credentialPath = join(
      directory,
      "invented-malformed-credentials.json",
    );
    writeFileSync(credentialPath, "DO-NOT-ECHO-SYNTHETIC malformed JSON", {
      mode: 0o600,
    });
    const fd = openSync(credentialPath, "r");
    try {
      const result = spawnCli(
        [
          "refresh",
          "--db",
          dbPath,
          "--connection",
          "synthetic-cli",
          "--credentials-fd",
          "3",
        ],
        fd,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Could not read credentials");
      expect(result.stderr).not.toContain("DO-NOT-ECHO-SYNTHETIC");
    } finally {
      closeSync(fd);
    }
  });

  it.each([
    { mode: undefined, months: undefined },
    { mode: undefined, months: "3" },
    { mode: "monthly", months: undefined },
    { mode: "search", months: "3" },
  ])(
    "forwards explicit history mode/window while preserving the default (%s)",
    async ({ mode, months }) => {
      await seedConnection(dbPath, "synthetic-cli", "cal");
      const credentialPath = join(directory, "invented-credentials.txt");
      writeFileSync(credentialPath, "invented-user:invented-password", {
        mode: 0o600,
      });
      const fd = openSync(credentialPath, "r");
      const args = [
        "refresh",
        "--db",
        dbPath,
        "--connection",
        "synthetic-cli",
        "--credentials-fd",
        String(fd),
        "--from",
        "2040-01-01",
        "--to",
        "2040-06-01",
      ];
      if (mode) {
        args.push("--history-mode", mode);
      }
      if (months) {
        args.push("--search-window-months", months);
      }
      const result = await run(...args).finally(() => closeSync(fd));
      expect(result.status).toBe(0);
      expect(collectorState.calls).toHaveLength(6);
      expect(collectorState.calls[0]).toMatchObject({
        range: { from: "2040-06-01", to: "2040-06-01" },
        ...(mode && { historyMode: mode }),
        ...(months && { searchWindowMonths: Number(months) }),
      });
      if (!mode) {
        expect(collectorState.calls[0]).not.toHaveProperty("historyMode");
      }
      if (!months) {
        expect(collectorState.calls[0]).not.toHaveProperty(
          "searchWindowMonths",
        );
      }
      expect(result.stdout).not.toContain("invented-user");
      expect(result.stdout).not.toContain("invented-password");
    },
  );

  it("confirms posting under the pending ID, preserves annotations, and records removal evidence", async () => {
    await seedConnection(dbPath, "synthetic-cli", "cal");
    await ingest(dbPath, "synthetic-run-1", "recent-01.json");
    const pendingId = await idForSource(
      dbPath,
      "SYNTHETIC-AUTH-PENDING-POSTED",
    );
    await success(
      "annotate",
      "--db",
      dbPath,
      "--transaction-id",
      pendingId,
      "--expected-version",
      "0",
      "--notes",
      "Keep this confirmed note",
    );
    const { annotation } = await getRow(dbPath, pendingId);
    await ingest(dbPath, "synthetic-run-2", "recent-02.json");
    const postedId = await idForSource(dbPath, "SYNTHETIC-TXN-PENDING-POSTED");
    const currentPending = await getRow(dbPath, pendingId);
    const posted = await getRow(dbPath, postedId);
    const linkArgs = [
      "link",
      "--db",
      dbPath,
      "--transaction-id",
      pendingId,
      "--posted-id",
      postedId,
      "--expected-pending-transaction-version",
      String(currentPending.version),
      "--expected-posted-transaction-version",
      String(posted.version),
      "--expected-pending-annotation-version",
      "1",
      "--expected-posted-annotation-version",
      "0",
      "--reason",
      "Owner confirmed same purchase",
    ];
    const stale = await run(
      ...linkArgs.map((entry, index) =>
        linkArgs[index - 1] === "--expected-pending-annotation-version"
          ? "0"
          : entry,
      ),
    );
    expect(stale.status).toBe(1);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toMatch(/^conflict: /);
    const linked = await success<{ transaction: { id: string } }>(...linkArgs);
    expect(linked.transaction.id).toBe(pendingId);
    const survivor = await getRow(dbPath, pendingId);
    expect(survivor).toMatchObject({ status: "posted", amount: posted.amount });
    expect(survivor.annotation).toEqual(annotation);
    expect((await getRow(dbPath, postedId)).supersededById).toBe(pendingId);
    expect((await listRows(dbPath)).some((row) => row.id === postedId)).toBe(
      false,
    );
    await success(
      "remove",
      "--db",
      dbPath,
      "--transaction-id",
      pendingId,
      "--expected-transaction-version",
      String(survivor.version),
      "--reason",
      "Owner confirmed invalid entry",
    );
    const removed = await getRow(dbPath, pendingId);
    expect(removed.presence).toBe("removed");
    expect(removed.annotation).toEqual(annotation);
    const history = await storedEvents(dbPath, "synthetic-cli");
    expect(history.map((change) => change.type)).toEqual(
      expect.arrayContaining([
        "transaction.linked",
        "transaction.posted",
        "transaction.removed",
      ]),
    );
    expect(
      JSON.stringify(
        history.find((change) => change.type === "transaction.removed"),
      ),
    ).toContain("Owner confirmed invalid entry");
  });

  it("delivers scoped JSON lines to stdout once across CLI invocations", async () => {
    await seedConnection(dbPath, "synthetic-cli", "cal");
    await ingest(dbPath, "synthetic-run-1", "recent-01.json");
    await seedConnection(dbPath, "other-connection", "cal");
    await ingest(dbPath, "other-run", "recent-01.json", "other-connection");
    const changes = await storedEvents(dbPath, "synthetic-cli");
    const otherChanges = await storedEvents(dbPath, "other-connection");
    expect(changes).not.toHaveLength(0);
    expect(
      otherChanges.every(
        (change) => !changes.some((own) => own.id === change.id),
      ),
    ).toBe(true);
    const consume = async () => {
      const result = await run(
        "consume",
        "--db",
        dbPath,
        "--connection",
        "synthetic-cli",
        "--consumer",
        "local-stdout",
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              deliveryKey?: string;
              event?: StoredEvent;
              type?: string;
              delivered?: number;
              cursor?: number;
            },
        );
    };
    const first = await consume();
    expect(first.slice(0, -1).map((message) => message.event)).toEqual(changes);
    expect(
      first
        .slice(0, -1)
        .every((message) => typeof message.deliveryKey === "string"),
    ).toBe(true);
    expect(first.at(-1)).toEqual({
      type: "delivery_summary",
      delivered: changes.length,
      cursor: changes.at(-1)!.id,
    });
    expect(await consume()).toEqual([
      { type: "delivery_summary", delivered: 0, cursor: changes.at(-1)!.id },
    ]);
    const missing = await run(
      "consume",
      "--db",
      dbPath,
      "--connection",
      "missing",
      "--consumer",
      "local-stdout",
    );
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("Connection not found.\n");
  });

  it("rejects repository runtime paths, including through symlinks", async () => {
    const indirectRoot = join(directory, "repository-link");
    symlinkSync(repositoryRoot, indirectRoot, "dir");
    for (const path of [
      join(repositoryRoot, "runtime.sqlite"),
      join(indirectRoot, "runtime.sqlite"),
    ]) {
      const result = await run("init", "--db", path);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("outside the repository");
      expect(existsSync(path)).toBe(false);
    }
    const backup = await run(
      "backup",
      "--db",
      dbPath,
      "--out",
      join(repositoryRoot, "backup.sqlite"),
    );
    expect(backup.status).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(repositoryRoot, "backup.sqlite"))).toBe(false);
  });
});

describe("stored provider credentials", () => {
  let directory: string;
  let dbPath: string;
  let stateDir: string;
  const calCredentials = {
    username: "INVENTED-PRIVATE-USER",
    password: "INVENTED-PRIVATE-PASSWORD",
  };

  beforeEach(() => {
    collectorState.calls = [];
    collectorState.isracardCalls = [];
    vi.stubEnv("FONDS_CREDENTIALS_KEY", undefined);
    directory = mkdtempSync(join(tmpdir(), "fonds-cli-credentials-"));
    dbPath = join(directory, "service.sqlite");
    stateDir = join(directory, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    vi.stubEnv("FONDS_STATE_DIR", stateDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  async function withCredentialFile<T>(
    value: object,
    work: (fd: string) => Promise<T>,
  ): Promise<T> {
    const path = join(directory, `invented-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    const fd = openSync(path, "r");
    try {
      return await work(String(fd));
    } finally {
      closeSync(fd);
      rmSync(path);
    }
  }

  async function init(connection: string, provider: string) {
    await seedConnection(dbPath, connection, provider);
  }

  it("stores CAL credentials encrypted under the state's key and collects with them", async () => {
    await init("cal-cli", "cal");
    const stored = await withCredentialFile(calCredentials, (fd) =>
      success(
        "connect",
        "--db",
        dbPath,
        "--connection",
        "cal-cli",
        "--credentials-fd",
        fd,
      ),
    );
    expect(stored).toEqual({
      connectionId: "cal-cli",
      provider: "cal",
      credentials: "stored",
    });
    const statePath = join(stateDir, "fonds.env");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(statePath, "utf8")).toMatch(
      /^FONDS_CREDENTIALS_KEY=[A-Za-z0-9_-]{43}$/m,
    );
    expect(existsSync(`${dbPath}.credentials-key`)).toBe(false);
    const database = readFileSync(dbPath);
    for (const value of Object.values(calCredentials)) {
      expect(database.includes(value)).toBe(false);
    }
    await success("refresh", "--db", dbPath, "--connection", "cal-cli");
    expect(collectorState.calls).toMatchObject([
      { credentials: calCredentials },
    ]);
  });

  it("validates Isracard fields before storing and collects with the stored card suffix", async () => {
    await init("isracard-cli", "isracard");
    const missingSuffix = await withCredentialFile(calCredentials, (fd) =>
      run(
        "connect",
        "--db",
        dbPath,
        "--connection",
        "isracard-cli",
        "--credentials-fd",
        fd,
      ),
    );
    expect(missingSuffix).toMatchObject({ status: 1, stdout: "" });
    expect(missingSuffix.stderr).not.toContain("INVENTED");
    const isracardCredentials = { ...calCredentials, cardSuffix: "123456" };
    await withCredentialFile(isracardCredentials, (fd) =>
      success(
        "connect",
        "--db",
        dbPath,
        "--connection",
        "isracard-cli",
        "--credentials-fd",
        fd,
      ),
    );
    await success("refresh", "--db", dbPath, "--connection", "isracard-cli");
    expect(collectorState.isracardCalls).toMatchObject([
      { credentials: isracardCredentials },
    ]);
  });

  it("refreshes two CAL logins and Isracard together without mixing credentials or records", async () => {
    collectorState.partial = false;
    const logins = [
      {
        id: "cal-one",
        provider: "cal",
        credentials: {
          username: "INVENTED-FIRST",
          password: "INVENTED-FIRST-PASSWORD",
        },
      },
      {
        id: "cal-two",
        provider: "cal",
        credentials: {
          username: "INVENTED-SECOND",
          password: "INVENTED-SECOND-PASSWORD",
        },
      },
      {
        id: "isracard-one",
        provider: "isracard",
        credentials: {
          username: "INVENTED-THIRD",
          password: "INVENTED-THIRD-PASSWORD",
          cardSuffix: "123456",
        },
      },
    ];
    for (const login of logins) {
      await init(login.id, login.provider);
      await withCredentialFile(login.credentials, (fd) =>
        success(
          "connect",
          "--db",
          dbPath,
          "--connection",
          login.id,
          "--credentials-fd",
          fd,
        ),
      );
    }
    const result = await run("refresh", "--db", dbPath);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed" });
    expect(collectorState.calls).toMatchObject(
      logins.slice(0, 2).map(({ credentials }) => ({ credentials })),
    );
    expect(collectorState.isracardCalls).toMatchObject([
      { credentials: logins[2]!.credentials },
    ]);
    const rows = await Promise.all(
      logins.map(async ({ id }) => {
        const database = await openDatabase(dbPath);
        try {
          return await database.listTransactions({
            connectionId: id,
            perspective: "all",
          });
        } finally {
          await database.close();
        }
      }),
    );
    expect(rows.map((group) => group.length)).toEqual([21, 21, 2]);
    expect(new Set(rows.flat().map((row) => row.id)).size).toBe(44);
    for (const login of logins) {
      for (const value of Object.values(login.credentials)) {
        expect(result.stdout + result.stderr).not.toContain(value);
      }
    }
    collectorState.calls = [];
    collectorState.isracardCalls = [];
    await success("refresh", "--db", dbPath, "--connection", "cal-two");
    expect(collectorState.calls).toMatchObject([
      { credentials: logins[1]!.credentials },
    ]);
    expect(collectorState.isracardCalls).toEqual([]);
  });

  it("prefers an explicit descriptor over stored credentials", async () => {
    await init("cal-cli", "cal");
    await withCredentialFile(calCredentials, (fd) =>
      success(
        "connect",
        "--db",
        dbPath,
        "--connection",
        "cal-cli",
        "--credentials-fd",
        fd,
      ),
    );
    const override = { username: "INVENTED-OTHER", password: "INVENTED-PW" };
    await withCredentialFile(override, (fd) =>
      success(
        "refresh",
        "--db",
        dbPath,
        "--connection",
        "cal-cli",
        "--credentials-fd",
        fd,
      ),
    );
    expect(collectorState.calls).toMatchObject([{ credentials: override }]);
  });

  it("refuses another state's key and never echoes values", async () => {
    await init("cal-cli", "cal");
    await withCredentialFile(calCredentials, (fd) =>
      success(
        "connect",
        "--db",
        dbPath,
        "--connection",
        "cal-cli",
        "--credentials-fd",
        fd,
      ),
    );
    // The key comes only from the state file, never the environment.
    vi.stubEnv(
      "FONDS_CREDENTIALS_KEY",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(
      await run("refresh", "--db", dbPath, "--connection", "cal-cli"),
    ).toMatchObject({ status: 0 });
    vi.stubEnv("FONDS_CREDENTIALS_KEY", undefined);
    // A lost state directory is never regenerated beside an existing ledger.
    const replacement = join(directory, "replacement");
    mkdirSync(replacement, { mode: 0o700 });
    vi.stubEnv("FONDS_STATE_DIR", replacement);
    expect(
      await run("refresh", "--db", dbPath, "--connection", "cal-cli"),
    ).toEqual({
      status: 1,
      stdout: "",
      stderr: `${replacement} has no fonds.env; restore the state directory backed up with this database, or start the service once first\n`,
    });
    expect(existsSync(join(replacement, "fonds.env"))).toBe(false);
    // A replaced one, with other secrets, is refused by the database.
    expect(
      (await run("init", "--db", join(directory, "other.sqlite"))).status,
    ).toBe(0);
    expect(
      await run("refresh", "--db", dbPath, "--connection", "cal-cli"),
    ).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "These secrets do not match the database's installation; restore the state directory (fonds.env) backed up with this database\n",
    });
    expect(collectorState.calls).toHaveLength(1);
    const output = JSON.stringify(collectorState.calls);
    expect(output).toContain("INVENTED-PRIVATE-USER");
  });

  it("disconnects by removing stored credentials and keeps the connection", async () => {
    await init("cal-cli", "cal");
    await withCredentialFile(calCredentials, (fd) =>
      success(
        "connect",
        "--db",
        dbPath,
        "--connection",
        "cal-cli",
        "--credentials-fd",
        fd,
      ),
    );
    expect(
      await success("disconnect", "--db", dbPath, "--connection", "cal-cli"),
    ).toEqual({
      connectionId: "cal-cli",
      provider: "cal",
      credentials: "removed",
    });
    expect(
      await success("disconnect", "--db", dbPath, "--connection", "cal-cli"),
    ).toMatchObject({ credentials: "none" });
    const empty = await run("refresh", "--db", dbPath);
    expect(empty.status).toBe(0);
    expect(empty.stderr).toContain("No connections have saved credentials");
    expect(JSON.parse(empty.stdout)).toMatchObject({
      status: "completed",
      captures: 0,
    });
    expect(collectorState.calls).toHaveLength(0);
    const database = await openDatabase(dbPath);
    try {
      expect(await database.getConnection("cal-cli")).toMatchObject({
        provider: "cal",
      });
    } finally {
      await database.close();
    }
    expect(
      await run("disconnect", "--db", dbPath, "--connection", "missing"),
    ).toMatchObject({ status: 1, stderr: "Connection not found.\n" });
  });

  it("rejects unknown connections, missing input and a public state file", async () => {
    await init("cal-cli", "cal");
    expect(
      await run("connect", "--db", dbPath, "--connection", "missing"),
    ).toMatchObject({
      status: 1,
      stderr: "Connection not found; add it with connect <provider> first.\n",
    });
    expect(
      await run("connect", "--db", dbPath, "--connection", "cal-cli"),
    ).toMatchObject({
      status: 1,
      stderr:
        "Credentials require an interactive terminal or --credentials-fd.\n",
    });
    expect(
      await run("connect", "--db", dbPath, "--connection", "cal-cli", "--live"),
    ).toMatchObject({ status: 1 });
    await withCredentialFile(calCredentials, (fd) =>
      success(
        "connect",
        "--db",
        dbPath,
        "--connection",
        "cal-cli",
        "--credentials-fd",
        fd,
      ),
    );
    chmodSync(join(stateDir, "fonds.env"), 0o644);
    expect(
      (
        await withCredentialFile(calCredentials, (fd) =>
          run(
            "connect",
            "--db",
            dbPath,
            "--connection",
            "cal-cli",
            "--credentials-fd",
            fd,
          ),
        )
      ).stderr,
    ).toBe(
      `The state file ${join(stateDir, "fonds.env")} must be an owned regular 0600 file\n`,
    );
  });
});

describe("state directory and installation", () => {
  let directory: string;
  let dbPath: string;
  let stateDir: string;

  beforeEach(() => {
    vi.stubEnv("FONDS_CREDENTIALS_KEY", undefined);
    directory = mkdtempSync(join(tmpdir(), "fonds-cli-state-"));
    dbPath = join(directory, "ledger.sqlite");
    stateDir = join(directory, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    vi.stubEnv("FONDS_STATE_DIR", stateDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  const init = () => run("init", "--db", dbPath);

  async function recorded(path = dbPath) {
    const database = await openDatabase(path);
    try {
      return JSON.parse((await database.getSetting("installation"))!);
    } finally {
      await database.close();
    }
  }

  it("generates the state on first start, binds the database and reuses both", async () => {
    expect(await init()).toMatchObject({ status: 0, stderr: "" });
    const statePath = join(stateDir, "fonds.env");
    const state = readFileSync(statePath, "utf8");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(state).toMatch(
      /^FONDS_AUTH_SECRET=\S+\nFONDS_OWNER_ID=\S+\nFONDS_CREDENTIALS_KEY=\S+\nFONDS_SCHEDULE_SECRET=\S+\nFONDS_REFRESH_SECRET=\S+\nFONDS_API_TOKEN=\S+\n$/,
    );
    const key = /FONDS_CREDENTIALS_KEY=(\S+)/.exec(state)![1]!;
    expect(await recorded()).toMatchObject({
      ownerId: /FONDS_OWNER_ID=(\S+)/.exec(state)![1],
      credentialsKeyId: parseCredentialsKey(key).id,
    });
    expect(await init()).toMatchObject({ status: 0, stderr: "" });
    expect(await run("list-connections", "--db", dbPath)).toMatchObject({
      status: 0,
      stderr: "",
    });
    expect(readFileSync(statePath, "utf8")).toBe(state);
  });

  it("starts concurrently from two processes with one state", async () => {
    const start = () =>
      new Promise<number | null>((resolveExit) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", cliPath, "init", "--db", dbPath],
          {
            cwd: repositoryRoot,
            env: { ...process.env, FONDS_STATE_DIR: stateDir },
            stdio: "ignore",
          },
        );
        child.once("exit", resolveExit);
      });
    expect(await Promise.all([start(), start()])).toEqual([0, 0]);
    const key = /FONDS_CREDENTIALS_KEY=(\S+)/.exec(
      readFileSync(join(stateDir, "fonds.env"), "utf8"),
    )![1]!;
    expect((await recorded()).credentialsKeyId).toBe(
      parseCredentialsKey(key).id,
    );
    expect(
      JSON.parse((await run("list-connections", "--db", dbPath)).stdout).data,
    ).toHaveLength(0);
  }, 30_000);

  it("refuses a database with another installation's state", async () => {
    expect(await init()).toMatchObject({ status: 0 });
    const other = join(directory, "other-state");
    mkdirSync(other, { mode: 0o700 });
    vi.stubEnv("FONDS_STATE_DIR", other);
    const otherDb = join(directory, "other.sqlite");
    expect(await run("init", "--db", otherDb)).toMatchObject({ status: 0 });
    const mismatch = {
      status: 1,
      stdout: "",
      stderr:
        "These secrets do not match the database's installation; restore the state directory (fonds.env) backed up with this database\n",
    };
    expect(await run("list-connections", "--db", dbPath)).toEqual(mismatch);
    expect(await init()).toEqual(mismatch);
    vi.stubEnv("FONDS_STATE_DIR", stateDir);
    expect(await run("list-connections", "--db", otherDb)).toEqual(mismatch);
    expect(await run("list-connections", "--db", dbPath)).toMatchObject({
      status: 0,
    });
  });

  it("refuses an existing database that was never bound", async () => {
    expect((await init()).status).toBe(0);
    rmSync(dbPath);
    const unbound = await openDatabase(dbPath);
    await unbound.ensureConnection({ id: "unbound", provider: "cal" });
    await unbound.close();
    chmodSync(dbPath, 0o600);
    for (const args of [["list-connections"], ["init"]]) {
      expect(await run(...args, "--db", dbPath)).toEqual({
        status: 1,
        stdout: "",
        stderr:
          "This database has no installation record; open it with the state directory it was created with, or initialize a new database\n",
      });
    }
  });

  it("restores a backup together with its state directory", async () => {
    expect(await init()).toMatchObject({ status: 0 });
    await success(
      "connect",
      "cal",
      "--name",
      "state-cal",
      "--offline",
      "--db",
      dbPath,
    );
    const backupPath = join(directory, "backup.sqlite");
    expect(
      JSON.parse(
        (await run("backup", "--db", dbPath, "--out", backupPath)).stdout,
      ),
    ).toEqual({ backupPath, stateDirectory: stateDir });
    const restoredState = join(directory, "restored-state");
    mkdirSync(restoredState, { mode: 0o700 });
    writeFileSync(
      join(restoredState, "fonds.env"),
      readFileSync(join(stateDir, "fonds.env")),
      { mode: 0o600 },
    );
    vi.stubEnv("FONDS_STATE_DIR", restoredState);
    expect(
      JSON.parse((await run("list-connections", "--db", backupPath)).stdout)
        .data,
    ).toEqual([expect.objectContaining({ id: "state-cal" })]);
    // Restored without its state, the backup opens with no other secrets.
    rmSync(join(restoredState, "fonds.env"));
    expect((await run("list-connections", "--db", backupPath)).stderr).toBe(
      `${restoredState} has no fonds.env; restore the state directory backed up with this database, or start the service once first\n`,
    );
  });

  it("refuses a state file without its identity and never completes it", async () => {
    writeFileSync(join(stateDir, "fonds.env"), "FONDS_API_TOKEN=x\n", {
      mode: 0o600,
    });
    expect(await init()).toEqual({
      status: 1,
      stdout: "",
      stderr: `The state file ${join(stateDir, "fonds.env")} lacks FONDS_AUTH_SECRET, FONDS_OWNER_ID, FONDS_CREDENTIALS_KEY; restore it from the backup made with this database\n`,
    });
    expect(readFileSync(join(stateDir, "fonds.env"), "utf8")).toBe(
      "FONDS_API_TOKEN=x\n",
    );
  });

  it("refuses a shared state directory without creating anything", async () => {
    chmodSync(stateDir, 0o755);
    expect(await init()).toEqual({
      status: 1,
      stdout: "",
      stderr: `The state directory ${stateDir} must be an owned 0700 directory\n`,
    });
    expect(existsSync(join(stateDir, "fonds.env"))).toBe(false);
    expect(statSync(stateDir).mode & 0o777).toBe(0o755);
  });
});
