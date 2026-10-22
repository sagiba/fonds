import type { SourceEvidence, TransactionFacts } from "../model.js";
import { canonicalJson } from "../observations.js";
import type { Transaction } from "../records.js";
import type { FinancialAuthority } from "../source-adapter.js";
import {
  DUPLICATE_ORDINAL,
  INSTALLMENT_CONFLICT,
  LINE_CONFLICT,
  RESTATEMENT_CONFLICT,
} from "./installments.js";

export const RETAINED_FINANCIAL_EVIDENCE = "retained_financial_evidence";

/** These facts form one interpretation; incomplete reads never fill them piecemeal. */
const bundleFields = [
  "amountMinor",
  "currency",
  "amountBasis",
  "kind",
  "originalAmountMinor",
  "originalCurrency",
  "fxFeeMinor",
  "fxFeeCurrency",
  "installmentCount",
  "installmentNumber",
  "purchaseId",
  "providerTransactionCode",
] as const;

type FinancialReceipt = NonNullable<SourceEvidence["financial"]>;

function hasSupportedMoney(row: TransactionFacts): boolean {
  return (
    row.amountMinor !== null &&
    row.currency !== null &&
    row.amountBasis !== "unknown" &&
    row.kind !== "unknown"
  );
}

function ordinary(row: TransactionFacts): boolean {
  return (
    row.status === "posted" &&
    row.purchaseId === null &&
    row.installmentNumber === null &&
    (row.installmentCount === null || row.installmentCount <= 1)
  );
}

// Source-specific financial conflicts belong in the adapter's authority declaration.
// Independent detail, payment-context and billing-date uncertainty is not a money hold.
const financialHolds = new Set([
  DUPLICATE_ORDINAL,
  INSTALLMENT_CONFLICT,
  LINE_CONFLICT,
  RESTATEMENT_CONFLICT,
  "ambiguous_identity",
  "ambiguous_source_identity",
  "conflicting_installment_facts",
  "unresolved_purchase",
]);

function conflicted(row: TransactionFacts): boolean {
  return row.details.issues.some((issue) => financialHolds.has(issue));
}

function copyBundle(
  input: TransactionFacts,
  previous: TransactionFacts,
): TransactionFacts {
  const { currencyExchange: _incoming, ...details } = input.details;
  const bundle = Object.fromEntries(
    bundleFields.map((field) => [field, previous[field]]),
  );
  return {
    ...input,
    ...bundle,
    details: {
      ...details,
      ...(previous.details.currencyExchange === undefined
        ? {}
        : {
            currencyExchange: structuredClone(
              previous.details.currencyExchange,
            ),
          }),
    },
  };
}

function compatibleAssertions(
  input: TransactionFacts,
  previous: TransactionFacts,
): boolean {
  return (
    bundleFields.every((field) => {
      const value = input[field];
      return value === null || value === "unknown" || value === previous[field];
    }) &&
    (input.details.currencyExchange === undefined ||
      canonicalJson(input.details.currencyExchange) ===
        canonicalJson(previous.details.currencyExchange ?? null))
  );
}

/**
 * Reconcile only financial interpretation. The caller owns source chronology,
 * unique identity resolution, owner decisions and plan/lifecycle eligibility.
 * An opaque component witness establishes continuity, never new money semantics.
 */
export function reconcileFinancialBundle(options: {
  previous?: Transaction;
  input: TransactionFacts;
  authority: FinancialAuthority;
  /** Only for a legacy row without an accepted financial receipt. */
  previousAuthority?: FinancialAuthority;
  receipt: { runId: string; capturedAt: string };
  /** Unique same-native binding with no owner/lifecycle hold or associated billed lines. */
  retainEligible: boolean;
  /** Caller accepted current-source priority over a historical-only import. */
  currentOverHistorical?: boolean;
}): {
  facts: TransactionFacts;
  financialReceipt: FinancialReceipt | undefined;
  retained: boolean;
  stale: boolean;
} {
  const { previous, input, authority, receipt } = options;
  if (
    previous &&
    receipt.capturedAt < previous.lastSeenAt &&
    !options.currentOverHistorical
  ) {
    return {
      facts: previous,
      financialReceipt: previous.sourceEvidence?.financial,
      retained: false,
      stale: true,
    };
  }
  const signature = authority.continuitySignature;
  const priorReceipt = previous?.sourceEvidence?.financial;
  const previousSignature = priorReceipt
    ? priorReceipt.continuitySignature
    : options.previousAuthority?.continuitySignature;
  const retain =
    options.retainEligible &&
    !options.currentOverHistorical &&
    previous !== undefined &&
    authority.kind === "incomplete" &&
    signature !== undefined &&
    signature === previousSignature &&
    input.identityStrength === "native" &&
    previous.identityStrength === "native" &&
    input.sourceScope === previous.sourceScope &&
    input.cardId === previous.cardId &&
    input.cardId !== null &&
    input.transactionDate !== null &&
    input.transactionDate === previous.transactionDate &&
    ordinary(input) &&
    ordinary(previous) &&
    hasSupportedMoney(previous) &&
    input.amountMinor !== null &&
    input.currency !== null &&
    !conflicted(previous) &&
    !conflicted(input) &&
    compatibleAssertions(input, previous);
  if (retain) {
    const facts = copyBundle(input, previous);
    facts.details.issues = [
      ...new Set([...facts.details.issues, RETAINED_FINANCIAL_EVIDENCE]),
    ];
    return {
      facts,
      financialReceipt: priorReceipt,
      retained: true,
      stale: false,
    };
  }
  return {
    facts:
      authority.kind === "asserted"
        ? input
        : { ...input, amountBasis: "unknown" },
    financialReceipt:
      authority.kind === "asserted" && hasSupportedMoney(input)
        ? {
            ...receipt,
            ...(signature === undefined
              ? {}
              : { continuitySignature: signature }),
          }
        : undefined,
    retained: false,
    stale: false,
  };
}
