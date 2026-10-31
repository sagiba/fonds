import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import tty from "node:tty";
import { parseArgs } from "node:util";

import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import {
  transactionDetailOutputSchema,
  transactionListOutputSchema,
  transactionOutputSchema,
  ungroupedTotalsOutputSchema,
} from "../../src/application/wire-output.js";
import { main } from "../../src/cli.js";
import { commandLine } from "../../src/runtime/cli-invocation.js";
import {
  type Presentation,
  presentation,
  safe,
  safeId,
} from "../../src/runtime/cli-output.js";
import {
  connectionListView,
  connectView,
  ingestView,
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
  again: (args: string[]) =>
    ["fonds", "list", "--limit", "1", ...args].join(" "),
  local: (args: string[]) => ["fonds", ...args].join(" "),
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
    sourceAbsence: null,
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
  const parsed = transactionListOutputSchema.parse({
    data,
    hasMore: nextCursor !== null,
    nextCursor,
    filters: {},
  });
  return { ...parsed, data };
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
    // Deprecated shaping controls too; a supplementary character keeps its pair.
    const deprecated = { name: "a\u206ab\u{1bca0}" };
    const shaped = jsonOutput(deprecated, { isTTY: true });
    expect(shaped).toContain("a\\u206ab\u{1bca0}");
    expect(JSON.parse(shaped)).toEqual(deprecated);
    expect(safe("a\u206ab")).toBe("a\\u206ab");
    expect(safeId("id\u{1bca0}\u200f\u3164")).toBe(
      "id\\ud82f\\udca0\\u200f\\u3164",
    );
    // Hebrew prose keeps its bidi marks; identifiers show them.
    expect(safe("שלום\u200f 1")).toBe("שלום\u200f 1");
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
    expect(text).toContain("More: fonds list --limit 1 --cursor CURSOR-2");
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
  it("says an original amount is not established and a converted row's fee is unknown", () => {
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
    expect(domestic).toMatch(/Original +not established$/m);
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

describe("every detailed field", () => {
  it("is shown, so a new wire field must be given a place before it ships", () => {
    const detail = transactionDetailOutputSchema.parse({
      ...transaction({
        cardId: "card-7",
        status: "pending",
        presence: "not_returned",
        sourceAbsence: {
          runId: "run-absent",
          capturedAt: "2040-01-05T00:00:00Z",
        },
        amountBasis: "booked_entry",
        amount: { currency: "ILS", amount: "-36.10" },
        originalAmount: { currency: "USD", amount: "-10.00" },
        description: "Invented description",
        counterpartyName: "Invented counterparty",
        merchant: {
          name: "Synthetic Grocer",
          providerId: "M-1",
          categoryCode: "5411",
          addressLine: "1 Example Street",
          city: "Testville",
          phone: "000-0000",
          countryCode: "USA",
        },
        transactionDateTime: "2040-01-02T10:11:12",
        bookingDate: "2040-01-03",
        billingDate: "2040-02-10",
        cardPresent: false,
        authorizationMethod: "keyed_in",
        wallet: "apple_pay",
        threeDSecureUsed: true,
        recurring: true,
        currencyExchange: [
          {
            sourceCurrency: "USD",
            targetCurrency: "ILS",
            unitCurrency: "USD",
            exchangeRate: "3.61",
            quotationDate: null,
          },
        ],
        fxFee: { currency: "ILS", amount: "-0.50" },
        providerTransactionCode: "CODE-9",
        installmentCount: 3,
        installmentNumber: 1,
        purchaseId: "purchase-1",
        supersededById: "posted-2",
        version: 4,
        detailsTruncated: true,
      }),
      additionalInformation: ["Invented information"],
      additionalInformationCount: 12,
      review: {
        required: true,
        status: "needs_review",
        stale: false,
        reasons: ["synthetic_reason"],
        sourceIssues: ["synthetic_issue"],
        pendingPostingCandidateIds: ["candidate-1"],
        truncated: true,
        counts: { reasons: 3, sourceIssues: 1, pendingPostingCandidateIds: 1 },
      },
      source: {
        identityStrength: "weak",
        firstSeenAt: "2040-01-02T00:00:00Z",
        lastSeenAt: "2040-01-04T00:00:00Z",
        lastSyncRunId: "run-9",
      },
      annotation: {
        version: 2,
        notes: "Invented note",
        category: "groceries",
        tags: ["synthetic"],
        metadata: {},
        review: null,
        updatedAt: "2040-01-04T00:00:00Z",
      },
      postingMatch: {
        supersededTransactionId: "posted-2",
        automatic: true,
        policyVersion: "policy-1",
        evidence: { runId: "run-match", capturedAt: "2040-01-03T00:00:00Z" },
        unlinked: false,
      },
      diagnosticsTruncated: true,
      diagnosticCounts: { evidence: 5 },
      evidence: [{ runId: "run-1", path: "$.items[0]" }],
    });
    const text = transactionView(
      { transaction: detail },
      plain(240),
      context(),
    );
    // Hand-written, one entry per wire field: the keys must match the schema.
    const shown: Record<keyof typeof detail, RegExp> = {
      id: /^Transaction 00000000-0000-4000-8000-000000000001$/m,
      connectionId: /Connection +synthetic$/m,
      cardId: /Card +card-7$/m,
      status: /Status +pending · /,
      presence: /Status +pending · not returned · purchase$/m,
      sourceAbsence:
        /Absence +proven by run run-absent, captured 2040-01-05T00:00:00Z$/m,
      kind: / · purchase$/m,
      amountBasis: /Amount +-36\.10 ILS \(booked entry\)$/m,
      amount: /Amount +-36\.10 ILS/,
      originalAmount: /Original +-10\.00 USD$/m,
      description: /Description +Invented description$/m,
      counterpartyName: /Counterparty +Invented counterparty$/m,
      merchant:
        /Merchant +Synthetic Grocer · MCC 5411 · 1 Example Street · Testville · USA · 000-0000 · merchant ID M-1$/m,
      transactionDate: /Date +2040-01-02/,
      transactionDateTime: /Date +2040-01-02 10:11:12$/m,
      bookingDate: /Booked +2040-01-03$/m,
      billingDate: /Billed +2040-02-10$/m,
      cardPresent: /Payment +card not present · /,
      authorizationMethod: /Payment .* · keyed in · /,
      wallet: /Payment .* · Apple Pay · /,
      threeDSecureUsed: /Payment .* · 3-D Secure · /,
      recurring: /Payment .* · recurring$/m,
      currencyExchange: /Exchange +USD to ILS at 3\.61 \(unit USD\)$/m,
      fxFee: /FX fee +-0\.50 ILS, already included in the amount$/m,
      providerTransactionCode: /Provider code +CODE-9$/m,
      installmentCount: /Installments +payment 1\/3$/m,
      installmentNumber: /Installments +payment 1\//,
      purchaseId: /Purchase +purchase-1$/m,
      supersededById: /Superseded by +posted-2$/m,
      version: /Version +4 \(annotation 2\)$/m,
      review: /Review +needs review · required$/m,
      annotation: /Annotation +groceries · synthetic · Invented note$/m,
      detailsTruncated: /Shortened for output: source text, /,
      additionalInformation: /Information \(1 of 12\) +Invented information$/m,
      additionalInformationCount:
        /Shortened for output: .*additional information\.$/m,
      source:
        /Source +weak identity · first seen 2040-01-02T00:00:00Z · last seen 2040-01-04T00:00:00Z · last run run-9$/m,
      postingMatch:
        /Posting match +matched automatically, retiring posted row posted-2 · policy policy-1 · run run-match captured 2040-01-03T00:00:00Z$/m,
      diagnosticsTruncated: /Shortened for output: .*evidence/,
      diagnosticCounts: /Evidence \(1 of 5\) +run-1 \$\.items\[0\]$/m,
      evidence: /run-1 \$\.items\[0\]/,
    };
    expect(Object.keys(shown).sort()).toEqual(
      Object.keys(transactionDetailOutputSchema.shape).sort(),
    );
    for (const [field, pattern] of Object.entries(shown)) {
      expect(text, field).toMatch(pattern);
    }
    expect(text).toMatch(/Reasons \(1 of 3\) +synthetic_reason$/m);
    expect(text).toMatch(/Source issues +synthetic_issue$/m);
    expect(text).toMatch(/Candidates +candidate-1$/m);
  });

  it("keeps an owner's split and a stated-only original visible", () => {
    const split = transactionView(
      {
        transaction: {
          ...transactionDetailOutputSchema.parse({
            ...transaction(),
            additionalInformation: [],
            review: {
              required: false,
              status: "unreviewed",
              stale: false,
              reasons: [],
              sourceIssues: [],
              pendingPostingCandidateIds: [],
              truncated: false,
              counts: {
                reasons: 0,
                sourceIssues: 0,
                pendingPostingCandidateIds: 0,
              },
            },
            source: {
              identityStrength: "native",
              firstSeenAt: "2040-01-02T00:00:00Z",
              lastSeenAt: "2040-01-02T00:00:00Z",
              lastSyncRunId: "run-1",
            },
            annotation: null,
            postingMatch: {
              supersededTransactionId: "posted-2",
              automatic: false,
              policyVersion: "policy-1",
              evidence: null,
              unlinked: true,
            },
          }),
        },
      },
      plain(),
      context(),
    );
    expect(split).toMatch(
      /Posting match +split by the owner from posted row posted-2 · policy policy-1$/m,
    );
    expect(split).not.toContain("Shortened");
  });
});

describe("list notes", () => {
  it("shows stated original money, proven absence and the facts the columns leave out", () => {
    const text = transactionListView(
      page([
        transaction({
          id: "00000000-0000-4000-8000-0000000000a1",
          amount: null,
          originalAmount: { currency: "USD", amount: "-10.00" },
        }),
        transaction({
          id: "00000000-0000-4000-8000-0000000000a2",
          amount: { currency: "ILS", amount: "-36.10" },
          originalAmount: { currency: "USD", amount: "-10.00" },
          presence: "not_returned",
          sourceAbsence: { runId: "run-1", capturedAt: "2040-01-05T00:00:00Z" },
        }),
        transaction({
          id: "00000000-0000-4000-8000-0000000000a3",
          originalAmount: { currency: "ILS", amount: "-12.30" },
        }),
        transaction({
          id: "00000000-0000-4000-8000-0000000000a4",
          amount: { currency: "ILS", amount: "-36.10" },
          originalAmount: { currency: "USD", amount: "-10.00" },
          fxFee: { currency: "ILS", amount: "-0.50" },
        }),
        transaction({
          id: "00000000-0000-4000-8000-0000000000a5",
          purchaseId: "purchase-1",
          installmentCount: 3,
          installmentNumber: 1,
        }),
      ]),
      plain(160),
      context({ presence: "all" }),
    );
    const notes = (id: string) =>
      text.split("\n").find((line) => line.includes(id))!;
    expect(notes("0000000000a1")).toContain("from -10.00 USD");
    expect(notes("0000000000a2")).toMatch(
      /from -10\.00 USD · not returned · proven absent/,
    );
    // Approval does not clear a review requirement.
    const approved = transactionListView(
      page([
        transaction({
          review: { required: true, status: "approved", stale: false },
        }),
      ]),
      plain(120),
      context(),
    );
    expect(approved).toContain("review still required");
    // The same money as the amount column is not repeated.
    expect(notes("0000000000a3")).not.toContain("from");
    expect(notes("0000000000a4")).toContain(
      "from -10.00 USD · FX fee -0.50 ILS",
    );
    // A billed line names its purchase, which spending counts instead.
    expect(notes("0000000000a5")).toContain(
      "payment 1/3 · line of purchase purchase-1",
    );
    // Cautionary notes are not dimmed with the ID.
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);
    const styled = transactionListView(
      page([transaction({ supersededById: "posted-2" })]),
      plain(120),
      context(),
    );
    vi.unstubAllEnvs();
    expect(styled).toMatch(/\u001b\[22m · superseded$/m);
  });
});

describe("display width", () => {
  it("keeps IDs whole and fits combining and invisible characters", () => {
    // Niqqud are zero-width combining marks; an RLM is invisible.
    const id = "חֶשְׁבּוֹן-1";
    const connections = {
      data: [
        {
          id,
          provider: "cal",
          displayName: "מַכּוֹלֶת\u200f סניף תל אביב",
          createdAt: "2040-01-01T00:00:00Z",
          latestRefresh: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
    for (const width of [40, 80]) {
      const text = connectionListView(connections, plain(width), context());
      expect(text).toContain(id);
      for (const line of text.split("\n")) {
        expect(stringWidth(line), line).toBeLessThanOrEqual(width);
      }
    }
    const wide = connectionListView(connections, plain(80), context());
    expect(wide).toContain("סניף תל אביב");
    // A look-alike ID shows its invisible character.
    const lookalike = connectionListView(
      { ...connections, data: [{ ...connections.data[0]!, id: "cal\u200b" }] },
      plain(80),
      context(),
    );
    expect(lookalike).toContain("cal\\u200b");
  });

  it("prints no command it would have to escape", () => {
    const text = transactionListView(
      page([transaction({ id: "id\u001b[2J" })], "next\u200b"),
      plain(),
      context(),
    );
    expect(text).toContain("id\\u001b[2J");
    expect(text).not.toMatch(/^(Details|More):/m);
  });
});

describe("printed commands", () => {
  it("attaches a value that looks like a flag, so it parses as typed", () => {
    const text = connectView(
      plain(),
      { connectionId: "--cal", provider: "cal", credentials: "stored" },
      (args) => commandLine("fonds", args),
    );
    const command = nextCommand(text);
    expect(command).toBe("fonds refresh --connection=--cal");
    const { values } = parseArgs({
      args: command.split(" ").slice(2),
      options: { connection: { type: "string" } },
      strict: true,
    });
    expect(values.connection).toBe("--cal");
  });
});

describe("connections view", () => {
  it("suggests connect only where an operator command can run", () => {
    const empty = { data: [], hasMore: false, nextCursor: null };
    expect(connectionListView(empty, plain(), context())).toBe(
      "No connections yet. Add one: fonds connect cal\n",
    );
    expect(
      connectionListView(empty, plain(), { ...context(), local: undefined }),
    ).toBe("No connections yet.\n");
  });
});

describe("totals view", () => {
  it("keeps every group separate and names exclusions and fees", () => {
    const totals = ungroupedTotalsOutputSchema.parse({
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
        sourceAbsent: 0,
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

  it("names every exclusion, including proven source absence", () => {
    const text = totalsView(
      ungroupedTotalsOutputSchema.parse({
        totals: [],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 0,
        excludedCount: 3,
        excluded: {
          pending: 1,
          transferOrIncome: 0,
          retiredOrRemoved: 0,
          sourceAbsent: 2,
          unresolved: 0,
          authorization: 0,
        },
      }),
      plain(),
      context(),
    );
    expect(text).toContain(
      "0 included · 3 excluded (1 pending, 2 absent from source)",
    );
  });

  it("stacks groups that do not fit, keeping each amount whole", () => {
    const text = totalsView(
      ungroupedTotalsOutputSchema.parse({
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
          sourceAbsent: 0,
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
    expect(text).toMatch(/^-350\.00 ILS$/m);
    expect(text).toMatch(/^purchase commitment$/m);
  });

  it("omits the basis for billing groups and never reads empty totals as zero", () => {
    const billing = totalsView(
      ungroupedTotalsOutputSchema.parse({
        totals: [{ currency: "ILS", amount: "-250.00" }],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 3,
        excludedCount: 0,
        excluded: {
          pending: 0,
          transferOrIncome: 0,
          retiredOrRemoved: 0,
          sourceAbsent: 0,
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
    // Billing groups mix bases on purpose; the footer must not deny it.
    expect(billing).toContain("Billing totals mix bases within a currency");
    expect(billing).not.toContain(
      "Each currency and basis is a separate total",
    );
    const empty = totalsView(
      ungroupedTotalsOutputSchema.parse({
        totals: [],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 0,
        excludedCount: 0,
        excluded: {
          pending: 0,
          transferOrIncome: 0,
          retiredOrRemoved: 0,
          sourceAbsent: 0,
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

  it("counts rows the provider no longer returned", () => {
    const text = refreshView(
      plain(),
      { ...summary, unlisted: 5 },
      (args) => `fonds ${args.join(" ")}`,
      { connectionId: "cal", nothingToRefresh: false },
    );
    expect(text).toContain(
      "Transactions: 2 added · 1 updated · 6 unchanged · 5 no longer returned",
    );
    expect(
      ingestView(plain(), {
        runId: "run-1",
        replayed: false,
        created: 0,
        updated: 0,
        unchanged: 12,
        unlisted: 5,
        status: "completed",
      }),
    ).toContain(
      "Transactions: 0 added · 0 updated · 12 unchanged · 5 no longer returned",
    );
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

  it("suggests no operator command for a remote deployment", async () => {
    const { createServer } = await import("node:http");
    const { writeFileSync } = await import("node:fs");
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ data: [], hasMore: false, nextCursor: null }),
      );
    });
    await new Promise<void>((listening) =>
      server.listen(0, "127.0.0.1", listening),
    );
    const { port } = server.address() as { port: number };
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, `${"t".repeat(43)}\n`, { mode: 0o600 });
    try {
      const shown = await inTerminal([
        "list-connections",
        "--remote",
        `http://127.0.0.1:${port}`,
        "--token-file",
        tokenFile,
      ]);
      expect(shown).toMatchObject({
        status: 0,
        stdout: "No connections yet.\n",
      });
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });

  it("prints no demo command for a path it would have to escape", async () => {
    const hidden = join(root, "demo\u200b.sqlite");
    const result = await inTerminal(["demo", "--db", hidden], {
      env: { NO_COLOR: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "ledger " + join(root, "demo\\u200b.sqlite"),
    );
    expect(result.stdout).not.toMatch(/^Try:|--db/m);
    expect(result.stdout).toContain("Commands for this ledger are not shown");
  });

  it.each([
    ["control", `ledger${ESC}[2J.sqlite`],
    ["invisible", "ledger\u200f.sqlite"],
  ])("refuses MCP setup for a path with %s characters", async (_kind, file) => {
    const hostile = join(root, file);
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
        "Client setup cannot print paths that contain control or invisible characters; use a plain path.\n",
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
    // The command as typed, on the same ledger, from the next page; a
    // trailing "--" must not turn the cursor into a positional.
    for (const typed of [[], ["--"]]) {
      const shown = await inTerminal(
        ["list", "--db", db, "--limit", "5", ...typed],
        { columns: 40, env: { NO_COLOR: "1" } },
      );
      const more = /^More: (.+)$/m.exec(shown.stdout)?.[1];
      expect(more).toMatch(/ list --db .+ --limit 5 --cursor \S+$/);
      const args = more!.split(" ");
      const next = await piped(args.slice(args.indexOf("list")));
      expect(next.status).toBe(0);
      const ids = (JSON.parse(next.stdout) as { data: { id: string }[] }).data;
      expect(ids[0]!.id).not.toBe(wire.data[0]!.id);
    }
  });
});
