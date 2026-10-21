import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import tty from "node:tty";

import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import {
  totalsOutputSchema,
  transactionDetailOutputSchema,
  transactionListOutputSchema,
  transactionOutputSchema,
} from "../../src/application/wire-output.js";
import { main } from "../../src/cli.js";
import {
  type Presentation,
  presentation,
  safe,
} from "../../src/runtime/cli-output.js";
import {
  refreshView,
  totalsView,
  transactionListView,
  transactionView,
} from "../../src/runtime/cli-views.js";
import { jsonOutput } from "../../src/runtime/json-output.js";

/** A stream that is not a terminal, so views render without color. */
const plainStream = new PassThrough() as unknown as NodeJS.WriteStream;

function plain(width = 100, ascii = false): Presentation {
  return { human: true, ascii, width, stream: plainStream };
}

const context = (input: Record<string, unknown> = {}) => ({
  input: { perspective: "spending", ...input },
  command: (args: string[]) => ["fonds", ...args].join(" "),
});

/** Check the copied command's shell syntax without running a provider operation. */
function nextCommand(output: string): string {
  const command = /^Next: (.+)$/m.exec(output)?.[1];
  expect(command).toBeDefined();
  const parsed = spawnSync("/bin/sh", ["-n"], {
    input: command,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(parsed.status, parsed.stderr).toBe(0);
  return command!;
}

type Transaction = z.infer<typeof transactionOutputSchema>;

/** An invented wire transaction; each test states the fields it is about. */
function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return transactionOutputSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    connectionId: "synthetic",
    cardId: null,
    status: "posted",
    presence: "seen",
    kind: "purchase",
    amountBasis: "purchase_commitment",
    amount: { currency: "ILS", amount: "-12.30" },
    originalAmount: null,
    description: null,
    counterpartyName: null,
    merchant: {
      name: "Synthetic Grocer",
      providerId: null,
      categoryCode: null,
      addressLine: null,
      city: null,
      phone: null,
      countryCode: null,
    },
    transactionDate: "2040-01-02",
    transactionDateTime: null,
    bookingDate: null,
    billingDate: null,
    cardPresent: null,
    authorizationMethod: null,
    wallet: null,
    threeDSecureUsed: null,
    recurring: null,
    currencyExchange: null,
    fxFee: null,
    providerTransactionCode: null,
    installmentCount: null,
    installmentNumber: null,
    purchaseId: null,
    supersededById: null,
    version: 1,
    review: { required: false, status: "unreviewed", stale: false },
    annotation: null,
    ...overrides,
  });
}

function page(data: Transaction[], nextCursor: string | null = null) {
  return transactionListOutputSchema.parse({
    data,
    hasMore: nextCursor !== null,
    nextCursor,
  });
}

const ESC = "\u001b";

describe("output mode", () => {
  it("is human only on a terminal without --json", () => {
    const terminal = { isTTY: true, columns: 90 } as NodeJS.WriteStream;
    const piped = {} as NodeJS.WriteStream;
    expect(presentation(false, terminal, {})).toMatchObject({
      human: true,
      width: 90,
      ascii: false,
    });
    expect(presentation(true, terminal, {}).human).toBe(false);
    expect(presentation(false, piped, {})).toMatchObject({
      human: false,
      width: 80,
    });
    expect(presentation(false, terminal, { TERM: "dumb" }).ascii).toBe(true);
  });

  it("escapes terminal controls from data, visibly, in views and terminal JSON", () => {
    expect(safe(`a${ESC}[31mb‮c\u0085d\ne`)).toBe(
      "a\\u001b[31mb\\u202ec\\u0085d\\u000ae",
    );
    const value = { name: `x‮y\u009bz ` };
    const terminal = jsonOutput(value, { isTTY: true });
    expect(terminal).toBe('{\n  "name": "x\\u202ey\\u009bz\\u2028"\n}\n');
    expect(JSON.parse(terminal)).toEqual(value);
    // Piped output stays the exact wire bytes.
    expect(jsonOutput(value, { isTTY: false })).toBe(
      `${JSON.stringify(value)}\n`,
    );
  });
});

describe("transaction list view", () => {
  it("shows money exactly with its basis, unknown as unknown, and every ID whole", () => {
    const rows = [
      transaction({
        id: "00000000-0000-4000-8000-0000000000aa",
        amount: null,
        amountBasis: "unknown",
      }),
      transaction({
        id: "00000000-0000-4000-8000-0000000000bb",
        amount: { currency: "KWD", amount: "-1000000.005" },
        amountBasis: "booked_entry",
        installmentCount: 12,
        installmentNumber: 2,
        purchaseId: "00000000-0000-4000-8000-0000000000cc",
      }),
      transaction({
        id: "00000000-0000-4000-8000-0000000000cc",
        amount: { currency: "ILS", amount: "-1200.00" },
        installmentCount: 12,
      }),
      transaction({
        id: "00000000-0000-4000-8000-0000000000dd",
        status: "pending",
        presence: "removed",
        amountBasis: "authorization",
        installmentNumber: 3,
        review: { required: true, status: "unreviewed", stale: false },
      }),
    ];
    for (const width of [30, 60, 80, 140]) {
      const text = transactionListView(page(rows), plain(width), context());
      expect(text).toContain("unknown");
      expect(text).toContain("-1000000.005 KWD");
      expect(text).toContain("-1200.00 ILS");
      expect(text).toContain("payment 2/12");
      expect(text).toContain("12-payment purchase");
      expect(text).toContain("payment 3/?");
      expect(text).toContain("removed");
      expect(text).toContain("needs review");
      expect(text).toContain("authorization");
      expect(text).toContain("booked");
      for (const row of rows) {
        expect(text).toContain(row.id);
      }
      // Never a multiplied or remaining amount for a plan.
      expect(text).not.toMatch(/-14400|-100\.00|remaining/);
    }
  });

  it("fits columns to the width and stacks when they cannot fit", () => {
    const rows = [
      transaction({
        merchant: {
          ...transaction().merchant,
          name: "בית עסק סינתטי עם שם ארוך מאוד שאינו נכנס בשורה אחת",
        },
      }),
    ];
    const wide = transactionListView(page(rows), plain(80), context());
    const tableLines = wide.split("\n").slice(0, 3);
    expect(tableLines[0]).toMatch(
      /^Date +Amount +Basis +Status +Kind +Description$/,
    );
    for (const line of tableLines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(tableLines[1]).toContain("…");
    const narrow = transactionListView(page(rows), plain(30), context());
    expect(narrow).not.toMatch(/^Date /);
    const lines = narrow.split("\n");
    // Exactly 30 columns still fits.
    expect(lines.slice(0, 2)).toEqual([
      "2040-01-02 · -12.30 ILS",
      "commitment · posted · purchase",
    ]);
    // Whole facts per line; only a single fact or ID may be wider.
    for (const line of lines) {
      expect(stringWidth(line) <= 30 || !line.includes(" · "), line).toBe(true);
    }
  });

  it("escapes source text and points to details, the next page and the perspective", () => {
    const text = transactionListView(
      page(
        [
          transaction({
            merchant: {
              ...transaction().merchant,
              name: `Shop${ESC}]0;x\u0007‮`,
            },
          }),
        ],
        "CURSOR-2",
      ),
      plain(),
      context({ perspective: "billing", dateRole: "billing" }),
    );
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("‮");
    expect(text).toContain("Shop\\u001b]0;x\\u0007\\u202e");
    expect(text).toContain("billing perspective");
    expect(text).toMatch(/^billing date /m);
    expect(text).toContain(
      "Details: fonds get --transaction-id 00000000-0000-4000-8000-000000000001",
    );
    expect(text).toContain("More: repeat with --cursor CURSOR-2");
    expect(transactionListView(page([]), plain(), context())).toBe(
      "No transactions match (spending perspective).\n",
    );
  });

  it("uses ASCII decorations for TERM=dumb", () => {
    const text = transactionListView(
      page([transaction()]),
      plain(30, true),
      context(),
    );
    expect(text).toMatch(/^2040-01-02 \| -12\.30 ILS$/m);
    expect(text).not.toMatch(/[·…]/);
  });
});

describe("transaction detail view", () => {
  it("shows versions, review state, supersession, evidence and shortening", () => {
    const detail = transactionDetailOutputSchema.parse({
      ...transaction({
        version: 7,
        supersededById: "00000000-0000-4000-8000-0000000000ee",
        review: { required: true, status: "stale", stale: true },
        fxFee: { currency: "ILS", amount: "-1.20" },
        currencyExchange: [
          {
            sourceCurrency: "USD",
            targetCurrency: "ILS",
            unitCurrency: "USD",
            exchangeRate: "3.7012",
            quotationDate: "2040-01-01",
          },
        ],
        detailsTruncated: true,
      }),
      additionalInformation: [],
      review: {
        required: true,
        status: "stale",
        stale: true,
        reasons: ["synthetic_reason"],
        sourceIssues: ["synthetic_issue"],
        pendingPostingCandidateIds: [],
        truncated: true,
        counts: {
          reasons: 150,
          sourceIssues: 1,
          pendingPostingCandidateIds: 0,
        },
      },
      source: {
        identityStrength: "weak",
        firstSeenAt: "2040-01-02T00:00:00Z",
        lastSeenAt: "2040-01-03T00:00:00Z",
        lastSyncRunId: "run-1",
      },
      annotation: {
        version: 3,
        notes: "Invented note",
        category: "groceries",
        tags: ["synthetic"],
        metadata: {},
        review: null,
        updatedAt: "2040-01-04T00:00:00Z",
      },
      postingMatch: null,
      evidence: [{ runId: "run-1", path: "$.items[0]" }],
    });
    const text = transactionView({ transaction: detail }, plain(), context());
    expect(text).toMatch(/Amount +-12\.30 ILS \(purchase commitment\)/);
    expect(text).toMatch(/Version +7/);
    expect(text).toMatch(/Superseded by +00000000-0000-4000-8000-0000000000ee/);
    expect(text).toMatch(/Review +stale · required/);
    expect(text).toContain("synthetic_reason");
    expect(text).toContain("synthetic_issue");
    expect(text).toContain("Invented note");
    expect(text).toMatch(/FX fee +-1\.20 ILS, already included in the amount/);
    expect(text).toContain("USD to ILS at 3.7012");
    expect(text).toContain("run-1 $.items[0]");
    expect(text).toContain("Shortened for output: source text, review lists.");
    expect(text).toContain(
      "JSON record: fonds get --transaction-id 00000000-0000-4000-8000-000000000001 --json",
    );
  });
});

describe("unknown detail money", () => {
  it("says an original amount is not stated and a converted row's fee is unknown", () => {
    const converted = transactionView(
      {
        transaction: transaction({
          originalAmount: { currency: "USD", amount: "-10.00" },
        }),
      },
      plain(),
      context(),
    );
    expect(converted).toMatch(/Original +-10\.00 USD/);
    expect(converted).toMatch(/FX fee +unknown/);
    const domestic = transactionView(
      { transaction: transaction() },
      plain(),
      context(),
    );
    expect(domestic).toMatch(/Original +not stated/);
    expect(domestic).not.toContain("FX fee");
    const zero = transactionView(
      {
        transaction: transaction({
          originalAmount: { currency: "USD", amount: "-10.00" },
          fxFee: { currency: "ILS", amount: "0.00" },
        }),
      },
      plain(),
      context(),
    );
    expect(zero).toMatch(/FX fee +0\.00 ILS, already included/);
  });
});

describe("totals view", () => {
  it("keeps every group separate and names exclusions and fees", () => {
    const totals = totalsOutputSchema.parse({
      totals: [
        {
          currency: "ILS",
          amount: "-350.00",
          amountBasis: "purchase_commitment",
        },
        { currency: "ILS", amount: "-200.00", amountBasis: "booked_entry" },
        { currency: "JPY", amount: "-100", amountBasis: "purchase_commitment" },
      ],
      fxFees: [{ currency: "ILS", amount: "-1.20" }],
      fxFeeUnknownCount: 2,
      includedCount: 5,
      excludedCount: 4,
      excluded: {
        pending: 3,
        transferOrIncome: 0,
        retiredOrRemoved: 0,
        unresolved: 1,
        authorization: 0,
      },
    });
    const text = totalsView(totals, plain(), context());
    expect(text).toContain("spending perspective");
    expect(text).toMatch(/^ILS +-350\.00 +purchase commitment$/m);
    expect(text).toMatch(/^ILS +-200\.00 +booked entry$/m);
    expect(text).toMatch(/^JPY +-100 +purchase commitment$/m);
    expect(text).not.toContain("-550");
    expect(text).toContain("5 included · 4 excluded (3 pending, 1 unresolved)");
    expect(text).toContain("FX fees, already in the amounts: -1.20 ILS");
    expect(text).toContain("2 converted transactions have an unknown FX fee");
  });

  it("stacks groups that do not fit, keeping each amount whole", () => {
    const text = totalsView(
      totalsOutputSchema.parse({
        totals: [
          {
            currency: "ILS",
            amount: "-350.00",
            amountBasis: "purchase_commitment",
          },
        ],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 1,
        excludedCount: 4,
        excluded: {
          pending: 3,
          transferOrIncome: 0,
          retiredOrRemoved: 0,
          unresolved: 1,
          authorization: 0,
        },
      }),
      plain(24),
      context(),
    );
    for (const line of text.split("\n")) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(24);
    }
    expect(text).not.toMatch(/^Currency/m);
    expect(text).toMatch(/^ILS · -350\.00$/m);
    expect(text).toMatch(/^purchase commitment$/m);
  });

  it("omits the basis for billing groups and never reads empty totals as zero", () => {
    const billing = totalsView(
      totalsOutputSchema.parse({
        totals: [{ currency: "ILS", amount: "-250.00" }],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 3,
        excludedCount: 0,
        excluded: {
          pending: 0,
          transferOrIncome: 0,
          retiredOrRemoved: 0,
          unresolved: 0,
          authorization: 0,
        },
      }),
      plain(),
      context({ perspective: "billing" }),
    );
    expect(billing).toMatch(/^Currency +Amount$/m);
    expect(billing).toMatch(/^ILS +-250\.00$/m);
    expect(billing).not.toMatch(/booked|commitment|FX fee/);
    const empty = totalsView(
      totalsOutputSchema.parse({
        totals: [],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 0,
        excludedCount: 0,
        excluded: {
          pending: 0,
          transferOrIncome: 0,
          retiredOrRemoved: 0,
          unresolved: 0,
          authorization: 0,
        },
      }),
      plain(),
      context(),
    );
    expect(empty).toContain("does not show that collection is complete");
    expect(empty).not.toMatch(/\b0\.00\b/);
  });
});

describe("refresh view", () => {
  const summary = {
    type: "refresh_summary" as const,
    status: "partial" as const,
    captures: 4,
    unchanged: 3,
    observed: 9,
    unchangedTransactions: 6,
    unlisted: 0,
    failures: 1,
    failureCodes: ["rate_limited" as const],
    created: 2,
    updated: 1,
    requestedRange: { from: "2040-01-01", to: "2040-03-31" },
  };

  it("reports collection counts, not spending, with the requested range", () => {
    const text = refreshView(
      plain(),
      summary,
      (args) => `fonds ${args.join(" ")}`,
      { connectionId: "cal", nothingToRefresh: false },
    );
    expect(text.split("\n")[0]).toBe("! Refresh partly completed");
    expect(text).toContain("Transactions: 2 added · 1 updated · 6 unchanged");
    expect(text).toContain("Captures: 4 (3 unchanged)");
    expect(text).toContain("Failures: 1 (rate limited)");
    expect(text).toContain("Requested range: 2040-01-01 to 2040-03-31");
    expect(text).not.toMatch(/covered|complete history/i);
    expect(text).toContain("Next: fonds list-refreshes --connection-id cal");
    // Without a named connection, the next step needs none.
    const all = refreshView(
      plain(),
      summary,
      (args) => `fonds ${args.join(" ")}`,
      { connectionId: undefined, nothingToRefresh: false },
    );
    expect(nextCommand(all)).toBe("fonds list-connections");
  });

  it("does not present a refresh without saved credentials as a success", () => {
    const text = refreshView(
      plain(),
      { ...summary, status: "completed", failures: 0, failureCodes: [] },
      (args) => `fonds ${args.join(" ")}`,
      { connectionId: undefined, nothingToRefresh: true },
    );
    expect(text).not.toContain("✓");
    expect(text).toContain("Nothing refreshed");
  });
});

/** Runs the CLI with stdout as a color terminal of the given width. */
async function inTerminal(
  args: string[],
  options: { columns?: number; env?: Record<string, string | undefined> } = {},
) {
  let stdout = "";
  let stderr = "";
  const keys = ["isTTY", "columns", "getColorDepth"] as const;
  const saved = keys.map(
    (key) =>
      [key, Object.getOwnPropertyDescriptor(process.stdout, key)] as const,
  );
  const define = (key: string, value: unknown) =>
    Object.defineProperty(process.stdout, key, { value, configurable: true });
  define("isTTY", true);
  define("columns", options.columns ?? 100);
  // A real terminal's color depth, which honors NO_COLOR and TERM.
  define("getColorDepth", (env?: NodeJS.ProcessEnv) =>
    tty.WriteStream.prototype.getColorDepth.call(process.stdout, env),
  );
  const env = {
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
    NODE_DISABLE_COLORS: undefined,
    TERM: "xterm-256color",
    ...options.env,
  };
  const previous = Object.keys(env).map(
    (name) => [name, process.env[name]] as const,
  );
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: unknown, ...rest) => {
      stdout += String(chunk);
      (
        rest.find((entry) => typeof entry === "function") as
          (() => void) | undefined
      )?.();
      return true;
    },
  );
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    return { status: await main(args), stdout, stderr };
  } finally {
    vi.restoreAllMocks();
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    for (const [key, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)[key];
      }
    }
  }
}

async function piped(args: string[]) {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: unknown, ...rest) => {
      stdout += String(chunk);
      (
        rest.find((entry) => typeof entry === "function") as
          (() => void) | undefined
      )?.();
      return true;
    },
  );
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return { status: await main(args), stdout };
  } finally {
    vi.restoreAllMocks();
  }
}

describe("commands in a terminal", () => {
  let root: string;
  let db: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "fonds-presentation-"));
    vi.stubEnv("FONDS_HOME", join(root, "home"));
    db = join(root, "home", "demo.sqlite");
    expect((await piped(["demo"])).status).toBe(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["list", "--limit", "3"],
    ["totals"],
    ["list-connections"],
    ["list-events", "--connection-id", "demo", "--limit", "2"],
  ])(
    "keeps %s JSON equal when piped or with --json, and text only in the terminal",
    async (...command) => {
      const args = [...command, "--db", db];
      const wire = await piped(args);
      expect(wire.status).toBe(0);
      expect(wire.stdout.endsWith("\n")).toBe(true);
      expect(wire.stdout.slice(0, -1)).not.toContain("\n");
      const value: unknown = JSON.parse(wire.stdout);
      expect((await piped([...args, "--json"])).stdout).toBe(wire.stdout);
      const explicit = await inTerminal([...args, "--json"]);
      expect(explicit.stdout).toBe(`${JSON.stringify(value, null, 2)}\n`);
      const human = await inTerminal(args);
      expect(human.status).toBe(0);
      if (command[0] === "list-events") {
        // No view yet: the same indented JSON.
        expect(human.stdout).toBe(explicit.stdout);
      } else {
        expect(() => JSON.parse(human.stdout)).toThrow();
      }
    },
  );

  it("colors only status marks, and honors NO_COLOR and TERM=dumb", async () => {
    const colored = await inTerminal([
      "init",
      "--db",
      join(root, "home", "own.sqlite"),
    ]);
    expect(colored.stdout).toContain(`${ESC}[32m✓${ESC}[39m Ledger ready`);
    const noColor = await inTerminal(
      ["init", "--db", join(root, "home", "own.sqlite")],
      {
        env: { NO_COLOR: "1" },
      },
    );
    expect(noColor.stdout).not.toContain(ESC);
    expect(noColor.stdout).toMatch(/^✓ Ledger ready$/m);
    const dumb = await inTerminal(
      ["init", "--db", join(root, "home", "own.sqlite")],
      {
        env: { TERM: "dumb" },
      },
    );
    expect(dumb.stdout).not.toContain(ESC);
    expect(dumb.stdout).toMatch(/^ok Ledger ready$/m);
  });

  it("reports an initialized ledger as ready, not created, on every run", async () => {
    const own = join(root, "home", "own.sqlite");
    const first = await inTerminal(["init", "--db", own], {
      env: { NO_COLOR: "1" },
    });
    const second = await inTerminal(["init", "--db", own], {
      env: { NO_COLOR: "1" },
    });
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toContain(`Data: ${own}`);
    expect(nextCommand(first.stdout)).toMatch(/ connect cal --db /);
    expect(first.stdout).not.toMatch(/created|initialized/i);
    expect((await piped(["init", "--db", own])).stdout).toBe(
      '{"initialized":true}\n',
    );
  });

  it("never lets a remote result drive the terminal, valid or not", async () => {
    const { createServer } = await import("node:http");
    const { writeFileSync } = await import("node:fs");
    const hostile = {
      connections: {
        data: [
          {
            id: `x${ESC}[2J`,
            provider: "cal\u202e",
            displayName: `name${ESC}]0;title\u0007`,
            createdAt: "2040-01-01T00:00:00Z",
            latestRefresh: null,
          },
        ],
        hasMore: false,
        nextCursor: null,
      },
      // Fails its schema (currency), so it is shown as escaped JSON.
      transactions: {
        data: [
          { ...transaction(), amount: { currency: `${ESC}[2J`, amount: "1" } },
        ],
        hasMore: false,
        nextCursor: null,
      },
    };
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.startsWith("/v1/connections")
            ? hostile.connections
            : hostile.transactions,
        ),
      );
    });
    await new Promise<void>((listening) =>
      server.listen(0, "127.0.0.1", listening),
    );
    const { port } = server.address() as { port: number };
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, `${"t".repeat(43)}\n`, { mode: 0o600 });
    try {
      for (const command of ["list-connections", "list"]) {
        const shown = await inTerminal([
          command,
          "--remote",
          `http://127.0.0.1:${port}`,
          "--token-file",
          tokenFile,
        ]);
        expect(shown.status, shown.stderr).toBe(0);
        // Colors come only from the CLI itself: SGR sequences around its own text.
        const unexpected = shown.stdout.replace(
          /\u001b\[(?:2|22|39|32|33|31)m/g,
          "",
        );
        expect(unexpected).not.toContain(ESC);
        expect(unexpected).not.toContain("\u202e");
        expect(unexpected).not.toContain("\u0007");
      }
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });

  it("refuses MCP setup for a path with control characters", async () => {
    const hostile = join(root, `ledger${ESC}[2J.sqlite`);
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(join(root, "home"), { recursive: true });
    copyFileSync(db, hostile);
    for (const flags of [[], ["--all"], ["--client", "codex"]]) {
      const result = await inTerminal([
        "mcp-config",
        "--db",
        hostile,
        ...flags,
      ]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Client setup cannot print paths that contain control characters; use a plain path.\n",
      );
    }
  });

  it("renders the demo ledger's list at a narrow width without losing IDs", async () => {
    const wire = JSON.parse(
      (await piped(["list", "--db", db, "--limit", "5"])).stdout,
    ) as {
      data: { id: string }[];
    };
    const human = await inTerminal(["list", "--db", db, "--limit", "5"], {
      columns: 40,
      env: { NO_COLOR: "1" },
    });
    for (const { id } of wire.data) {
      expect(human.stdout).toContain(id);
    }
    expect(human.stdout).toContain("More: repeat with --cursor ");
  });
});
