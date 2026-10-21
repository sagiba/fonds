import type { z } from "zod";

import type {
  connectionListOutputSchema,
  totalsOutputSchema,
  transactionDetailOutputSchema,
  transactionListOutputSchema,
  transactionReadOutputSchema,
} from "../application/wire-output.js";
import type { SyncResult } from "../domain/plans/sync.js";
import {
  details,
  dim,
  flow,
  headline,
  joined,
  type Presentation,
  safe,
  table,
  wrap,
} from "./cli-output.js";
import type { collectionSummarySchema } from "./operator-cli.js";

/*
 * Pure renderers for a terminal. They restate only what the result states:
 * money stays the exact wire string with its currency and amount basis,
 * null stays unknown, and every source string passes through safe().
 */

type TransactionPage = z.infer<typeof transactionListOutputSchema>;

type Transaction = TransactionPage["data"][number];

type TransactionDetail = z.infer<typeof transactionDetailOutputSchema>;

type Money = { currency: string; amount: string } | null;

/** What a view knows about the request besides its result. */
export interface ViewContext {
  /** The validated input, with defaults applied. */
  input: Readonly<Record<string, unknown>>;
  /** A runnable follow-up command on the same database or deployment. */
  command(args: string[]): string;
}

export type View<T> = (
  value: T,
  p: Presentation,
  context: ViewContext,
) => string;

const basisShort: Record<string, string> = {
  booked_entry: "booked",
  authorization: "authorization",
  purchase_commitment: "commitment",
  unknown: "unknown",
};

const basisLong: Record<string, string> = {
  booked_entry: "booked entry",
  authorization: "authorization",
  purchase_commitment: "purchase commitment",
  unknown: "unknown basis",
};

const words = (value: string) => value.replaceAll("_", " ");

function money(value: Money): string {
  return value ? `${value.amount} ${value.currency}` : "unknown";
}

/** A row's own plan facts; never a schedule, remaining count or total. */
function installments(
  transaction: Pick<Transaction, "installmentCount" | "installmentNumber">,
): string | undefined {
  const { installmentCount: count, installmentNumber: number } = transaction;
  if (number !== null) {
    return `payment ${number}/${count ?? "?"}`;
  }
  return count !== null && count >= 2 ? `${count}-payment purchase` : undefined;
}

function reviewNote(review: Transaction["review"]): string | undefined {
  if (review.stale) {
    return "review stale";
  }
  return review.status === "needs_review" ||
    (review.required && review.status === "unreviewed")
    ? "needs review"
    : undefined;
}

function notes(transaction: Transaction): string[] {
  return [
    transaction.presence === "seen" ? undefined : words(transaction.presence),
    installments(transaction),
    transaction.supersededById !== null ? "superseded" : undefined,
    reviewNote(transaction.review),
    transaction.detailsTruncated ? "clipped" : undefined,
  ].filter((note) => note !== undefined);
}

function label(transaction: Transaction): string {
  return safe(
    transaction.merchant.name ??
      transaction.counterpartyName ??
      transaction.description ??
      "—",
  );
}

const dateFields = {
  transaction: "transactionDate",
  booking: "bookingDate",
  billing: "billingDate",
} as const;

export const transactionListView: View<TransactionPage> = (
  page,
  p,
  context,
) => {
  const perspective = String(context.input.perspective);
  const role =
    (context.input.dateRole as keyof typeof dateFields | undefined) ??
    "transaction";
  if (!page.data.length) {
    return `No transactions match (${perspective} perspective).\n`;
  }
  const rows = page.data.map((transaction) => ({
    cells: [
      transaction[dateFields[role]] ?? "—",
      money(transaction.amount),
      basisShort[transaction.amountBasis]!,
      transaction.status,
      words(transaction.kind),
      label(transaction),
    ],
    // The whole ID, never shortened, with what the columns leave out.
    detail: dim(
      p,
      flow(p, [safe(transaction.id), ...notes(transaction)], "  "),
    ),
  }));
  const header = role === "transaction" ? "Date" : `${words(role)} date`;
  const lines = table(
    p,
    [
      { header },
      { header: "Amount", align: "right" },
      { header: "Basis" },
      { header: "Status" },
      { header: "Kind" },
      { header: "Description", flexible: true },
    ],
    rows.map((row) => row.cells),
  )?.split("\n");
  const rendered = lines
    ? [
        lines[0]!,
        ...rows.flatMap((row, index) => [lines[index + 1]!, row.detail]),
      ].join("\n")
    : // Too narrow for columns: each transaction's facts, then its description.
      rows
        .map((row) =>
          [
            flow(p, row.cells.slice(0, -1)),
            wrap(row.cells.at(-1)!, p.width, "  "),
            row.detail,
          ].join("\n"),
        )
        .join("\n");
  return [
    rendered,
    "",
    dim(
      p,
      joined(p, [
        `${page.data.length} shown`,
        `${perspective} perspective`,
        ...(role === "transaction" ? [] : [`${words(role)} dates`]),
      ]),
    ),
    `Details: ${safe(context.command(["get", "--transaction-id", page.data[0]!.id]))}`,
    ...(page.nextCursor !== null
      ? [`More: repeat with --cursor ${safe(page.nextCursor)}`]
      : []),
    "",
  ].join("\n");
};

/** Converted as totals count it: stated steps, or original money in another currency. */
function converted(
  transaction: Pick<
    Transaction,
    "currencyExchange" | "originalAmount" | "amount"
  >,
): boolean {
  return (
    transaction.currencyExchange !== null ||
    (transaction.originalAmount !== null &&
      transaction.amount !== null &&
      transaction.originalAmount.currency !== transaction.amount.currency)
  );
}

function exchange(steps: NonNullable<Transaction["currencyExchange"]>): string {
  return steps
    .map(
      (step) =>
        `${step.sourceCurrency} to ${step.targetCurrency} at ${step.exchangeRate} (unit ${step.unitCurrency}${
          step.quotationDate ? `, quoted ${step.quotationDate}` : ""
        })`,
    )
    .join("; ");
}

function annotation(
  p: Presentation,
  value: TransactionDetail["annotation"],
): string | undefined {
  if (!value) {
    return undefined;
  }
  return joined(p, [
    ...(value.category !== null ? [safe(value.category)] : []),
    ...(value.tags.length ? [value.tags.map(safe).join(", ")] : []),
    ...(value.notes !== null ? [safe(value.notes)] : []),
  ]);
}

export const transactionView: View<
  z.infer<typeof transactionReadOutputSchema>
> = ({ transaction }, p, context) => {
  const detail =
    "source" in transaction ? (transaction as TransactionDetail) : undefined;
  const merchant = transaction.merchant;
  const review = transaction.review;
  const truncated = [
    transaction.detailsTruncated && "source text",
    detail?.review.truncated && "review lists",
    detail?.diagnosticsTruncated && "evidence",
    detail?.additionalInformationCount !== undefined &&
      "additional information",
  ].filter((entry) => typeof entry === "string");
  const rows: ([string, string] | undefined)[] = [
    [
      "Amount",
      `${money(transaction.amount)} (${basisLong[transaction.amountBasis]})`,
    ],
    [
      "Original",
      transaction.originalAmount
        ? money(transaction.originalAmount)
        : "not stated",
    ],
    [
      "Status",
      joined(p, [
        transaction.status,
        words(transaction.presence),
        words(transaction.kind),
      ]),
    ],
    [
      "Date",
      transaction.transactionDateTime?.replace("T", " ") ??
        transaction.transactionDate ??
        "unknown",
    ],
    transaction.bookingDate ? ["Booked", transaction.bookingDate] : undefined,
    transaction.billingDate ? ["Billed", transaction.billingDate] : undefined,
    transaction.description !== null
      ? ["Description", safe(transaction.description)]
      : undefined,
    merchant.name !== null || merchant.categoryCode !== null
      ? [
          "Merchant",
          joined(p, [
            ...(merchant.name !== null ? [safe(merchant.name)] : []),
            ...(merchant.categoryCode !== null
              ? [`MCC ${merchant.categoryCode}`]
              : []),
            ...(merchant.city !== null ? [safe(merchant.city)] : []),
            ...(merchant.countryCode !== null ? [merchant.countryCode] : []),
          ]),
        ]
      : undefined,
    transaction.counterpartyName !== null
      ? ["Counterparty", safe(transaction.counterpartyName)]
      : undefined,
    installments(transaction)
      ? ["Installments", installments(transaction)!]
      : undefined,
    transaction.purchaseId !== null
      ? ["Purchase", safe(transaction.purchaseId)]
      : undefined,
    transaction.supersededById !== null
      ? ["Superseded by", safe(transaction.supersededById)]
      : undefined,
    transaction.currencyExchange
      ? ["Exchange", exchange(transaction.currencyExchange)]
      : undefined,
    transaction.fxFee
      ? [
          "FX fee",
          `${money(transaction.fxFee)}, already included in the amount`,
        ]
      : converted(transaction)
        ? ["FX fee", "unknown"]
        : undefined,
    [
      "Card",
      transaction.cardId !== null ? safe(transaction.cardId) : "unknown",
    ],
    ["Connection", safe(transaction.connectionId)],
    [
      "Review",
      joined(p, [
        words(review.status),
        ...(review.required ? ["required"] : []),
        ...(review.stale ? ["stale"] : []),
      ]),
    ],
    detail?.review.reasons.length
      ? ["Reasons", detail.review.reasons.map(safe).join("; ")]
      : undefined,
    detail?.review.sourceIssues.length
      ? ["Source issues", detail.review.sourceIssues.map(safe).join("; ")]
      : undefined,
    detail?.review.pendingPostingCandidateIds.length
      ? [
          "Candidates",
          detail.review.pendingPostingCandidateIds.map(safe).join(", "),
        ]
      : undefined,
    detail && annotation(p, detail.annotation)
      ? ["Annotation", annotation(p, detail.annotation)!]
      : undefined,
    [
      "Version",
      `${transaction.version}${
        transaction.annotation
          ? ` (annotation ${transaction.annotation.version})`
          : " (no annotation)"
      }`,
    ],
    detail
      ? [
          "Source",
          joined(p, [
            `${detail.source.identityStrength} identity`,
            `first seen ${safe(detail.source.firstSeenAt)}`,
            `last seen ${safe(detail.source.lastSeenAt)}`,
          ]),
        ]
      : undefined,
    detail?.evidence?.length
      ? [
          "Evidence",
          detail.evidence
            .map((entry) => `${safe(entry.runId)} ${safe(entry.path)}`)
            .join("\n"),
        ]
      : undefined,
  ];
  return [
    `Transaction ${safe(transaction.id)}`,
    details(rows, p.width),
    ...(truncated.length
      ? [
          "",
          headline(
            p,
            "attention",
            `Shortened for output: ${truncated.join(", ")}.`,
          ),
        ]
      : []),
    "",
    `JSON record: ${safe(context.command(["get", "--transaction-id", transaction.id, "--json"]))}`,
    "",
  ].join("\n");
};

const exclusions = {
  pending: "pending",
  transferOrIncome: "transfer or income",
  retiredOrRemoved: "retired or removed",
  unresolved: "unresolved",
  authorization: "authorization",
} as const;

export const totalsView: View<z.infer<typeof totalsOutputSchema>> = (
  totals,
  p,
  context,
) => {
  const perspective = String(context.input.perspective);
  const billing = totals.totals.every(
    (group) => group.amountBasis === undefined,
  );
  const groups = totals.totals.map((group) => [
    group.currency,
    group.amount,
    ...(billing ? [] : [basisLong[group.amountBasis!]!]),
  ]);
  const excluded = Object.entries(exclusions)
    .filter(([key]) => totals.excluded[key as keyof typeof exclusions] > 0)
    .map(
      ([key, name]) =>
        `${totals.excluded[key as keyof typeof exclusions]} ${name}`,
    );
  const unknownFees = totals.fxFeeUnknownCount;
  return [
    wrap(joined(p, ["Totals", `${perspective} perspective`]), p.width),
    totals.totals.length
      ? (table(
          p,
          [
            { header: "Currency" },
            { header: "Amount", align: "right" },
            ...(billing ? [] : [{ header: "Basis" }]),
          ],
          groups,
        ) ?? groups.map((group) => flow(p, group)).join("\n"))
      : wrap(
          "No eligible transactions match; this does not show that collection is complete.",
          p.width,
        ),
    "",
    wrap(
      joined(p, [
        `${totals.includedCount} included`,
        `${totals.excludedCount} excluded${excluded.length ? ` (${excluded.join(", ")})` : ""}`,
      ]),
      p.width,
    ),
    ...(totals.fxFees.length
      ? [
          wrap(
            `FX fees, already in the amounts: ${totals.fxFees.map(money).join(", ")}`,
            p.width,
          ),
        ]
      : []),
    ...(unknownFees
      ? [
          wrap(
            `${unknownFees} converted transaction${unknownFees === 1 ? " has" : "s have"} an unknown FX fee`,
            p.width,
          ),
        ]
      : []),
    dim(
      p,
      wrap(
        "Each currency and basis is a separate total; they are never added together.",
        p.width,
      ),
    ),
    "",
  ].join("\n");
};

type ConnectionPage = z.infer<typeof connectionListOutputSchema>;

function lastRefresh(
  refresh: ConnectionPage["data"][number]["latestRefresh"],
): string {
  if (!refresh) {
    return "never";
  }
  const when = refresh.finishedAt ?? refresh.startedAt ?? refresh.createdAt;
  return `${words(refresh.status)} ${safe(when.slice(0, 10))}${
    refresh.requiresAttention ? ", needs attention" : ""
  }`;
}

export const connectionListView: View<ConnectionPage> = (page, p, context) => {
  if (!page.data.length) {
    return `No connections yet. Add one: ${safe(context.command(["connect", "cal"]))}\n`;
  }
  const rows = page.data.map((connection) => [
    safe(connection.id),
    safe(connection.provider),
    safe(connection.displayName),
    lastRefresh(connection.latestRefresh),
  ]);
  return `${
    table(
      p,
      [
        { header: "ID" },
        { header: "Provider" },
        { header: "Name", flexible: true },
        { header: "Last refresh" },
      ],
      rows,
    ) ?? rows.map((row) => joined(p, row)).join("\n")
  }\n`;
};

/** Operation results with a terminal view; the rest stay JSON. */
export const operationViews: Readonly<Record<string, View<never>>> = {
  list_transactions: transactionListView,
  get_transaction: transactionView,
  get_transaction_totals: totalsView,
  list_connections: connectionListView,
};

type Next = (args: string[]) => string;

function nextStep(next: string): string {
  return `\nNext: ${safe(next)}\n`;
}

export function initView(
  p: Presentation,
  location: string | undefined,
  next: Next,
  providers: readonly string[],
): string {
  return [
    headline(p, "ok", "Ledger ready"),
    ...(location ? [`  Data: ${safe(location)}`] : []),
    nextStep(
      `${next(["connect", providers[0]!])}  (providers: ${providers.join(", ")})`,
    ),
  ].join("\n");
}

export function connectView(
  p: Presentation,
  result: { connectionId: string; provider: string; credentials: string },
  next: Next,
): string {
  const id = safe(result.connectionId);
  const provider = safe(result.provider);
  return result.credentials === "stored"
    ? [
        headline(
          p,
          "ok",
          `Saved credentials for connection ${id} (${provider})`,
        ),
        "  Not yet checked with the provider; a refresh signs in.",
        nextStep(next(["refresh", "--connection", result.connectionId])),
      ].join("\n")
    : [
        headline(
          p,
          "ok",
          `Added offline connection ${id} (${provider}), without credentials`,
        ),
        nextStep(next(["help", "ingest"])),
      ].join("\n");
}

export function disconnectView(
  p: Presentation,
  result: { connectionId: string; credentials: string },
): string {
  const id = safe(result.connectionId);
  return `${
    result.credentials === "removed"
      ? headline(
          p,
          "ok",
          `Removed saved credentials for ${id}; its transactions are kept`,
        )
      : headline(p, "ok", `No saved credentials for ${id}; nothing changed`)
  }\n`;
}

export function backupView(
  p: Presentation,
  result: { backupPath: string; stateDirectory?: string | undefined },
): string {
  return [
    headline(p, "ok", `Backup written to ${safe(result.backupPath)}`),
    `  Back up the state directory with it; the copy holds no secrets${
      result.stateDirectory ? `: ${safe(result.stateDirectory)}` : "."
    }`,
    "",
  ].join("\n");
}

function transactionCounts(
  p: Presentation,
  counts: { created: number; updated: number; unchanged?: number | undefined },
): string {
  return `Transactions: ${joined(p, [
    `${counts.created} added`,
    `${counts.updated} updated`,
    ...(counts.unchanged !== undefined
      ? [`${counts.unchanged} unchanged`]
      : []),
  ])}`;
}

export function ingestView(p: Presentation, result: SyncResult): string {
  const tone =
    result.status === "completed"
      ? "ok"
      : result.status === "partial"
        ? "attention"
        : "error";
  return [
    headline(
      p,
      tone,
      `Ingest ${result.status}${result.replayed ? " (already applied; nothing changed)" : ""}`,
    ),
    `  ${transactionCounts(p, result)}`,
    ...(result.failureCode ? [`  Failure: ${words(result.failureCode)}`] : []),
    "",
  ].join("\n");
}

type RefreshSummary = z.infer<typeof collectionSummarySchema>;

const refreshHeadlines = {
  completed: ["ok", "Refresh completed"],
  partial: ["attention", "Refresh partly completed"],
  busy: [
    "attention",
    "Refresh busy: another refresh of a connection is running",
  ],
  blocked: ["error", "Refresh blocked: the provider needs your attention"],
  failed: ["error", "Refresh failed"],
} as const;

function diagnosticLine(
  entry: NonNullable<RefreshSummary["diagnostics"]>["entries"][number],
): string {
  const counts = Object.entries(entry.counts ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );
  return [
    entry.stage,
    entry.outcome,
    ...(entry.reason ? [words(entry.reason)] : []),
    ...(entry.failureCategory ? [words(entry.failureCategory)] : []),
    ...(entry.requiresAttention ? ["needs attention"] : []),
    ...counts,
    ...(entry.durationMs !== undefined ? [`${entry.durationMs}ms`] : []),
  ].join(" ");
}

/**
 * Counts describe collection, not spending or coverage: added rows may be
 * historical, and a requested range is not proof of complete history.
 */
export function refreshView(
  p: Presentation,
  summary: RefreshSummary,
  next: Next,
  options: { connectionId: string | undefined; nothingToRefresh: boolean },
): string {
  if (options.nothingToRefresh) {
    return [
      headline(
        p,
        "attention",
        "Nothing refreshed: no connection has saved credentials",
      ),
      nextStep(next(["connect", "cal"])),
    ].join("\n");
  }
  const [tone, title] = refreshHeadlines[summary.status];
  const diagnostics = summary.diagnostics;
  return [
    headline(p, tone, title),
    `  ${transactionCounts(p, {
      created: summary.created,
      updated: summary.updated,
      unchanged: summary.unchangedTransactions,
    })}`,
    `  Captures: ${summary.captures}${summary.unchanged ? ` (${summary.unchanged} unchanged)` : ""}`,
    ...(summary.failures
      ? [
          `  Failures: ${summary.failures}${
            summary.failureCodes?.length
              ? ` (${summary.failureCodes.map(words).join(", ")})`
              : ""
          }`,
        ]
      : []),
    ...(summary.requestedRange
      ? [
          `  Requested range: ${summary.requestedRange.from} to ${summary.requestedRange.to}`,
        ]
      : []),
    ...(diagnostics
      ? [
          "",
          `Diagnostics (${diagnostics.entries.length}${
            diagnostics.truncated ? `, ${diagnostics.dropped} dropped` : ""
          }):`,
          ...diagnostics.entries.map((entry) => `  ${diagnosticLine(entry)}`),
        ]
      : []),
    ...(summary.status === "completed"
      ? [""]
      : [
          nextStep(
            options.connectionId === undefined
              ? `${next(["list-connections"])}  (each connection's latest refresh)`
              : next([
                  "list-refreshes",
                  "--connection-id",
                  options.connectionId,
                ]),
          ),
        ]),
  ].join("\n");
}
