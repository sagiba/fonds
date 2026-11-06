import type { JsonObject, TransactionFacts } from "../../domain/model.js";
import { decimalToMinor } from "../../domain/money.js";
import {
  merchantPresentation,
  merchantText,
} from "../../domain/plans/auto-posting.js";
import { currentSourceRows } from "../../domain/provider-evidence.js";
import { isracardEvidenceGeneration } from "./evidence.js";
import { legacyCurrency } from "./extract.js";

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const POSTING_ISSUES = [
  "source_derived_amount_direction",
  "possible_pending_posted_match",
];

const onlyPostingIssues = (row: TransactionFacts) =>
  row.details.issues.every((issue) => POSTING_ISSUES.includes(issue));

function approvalMerchant(row: TransactionFacts): string | null {
  const rows = currentSourceRows(row.details.provider.isracard ?? {});
  if (rows.length !== 1 || !object(rows[0])) {
    return null;
  }
  const approval = rows[0];
  const location = approval.confirmationLocation;
  const sequence = approval.seqConfirmationNumber;
  const timestamp = approval.confirmationTimeStamp;
  if (
    typeof location !== "string" ||
    !/^\d+$/.test(location) ||
    !Number.isSafeInteger(Number(location)) ||
    typeof sequence !== "string" ||
    !sequence.trim() ||
    typeof timestamp !== "string" ||
    !timestamp.trim() ||
    /[\u0000-\u001f\u007f]/.test(sequence + timestamp)
  ) {
    return null;
  }
  if (
    row.sourceKey !==
    `isracard:pending:${JSON.stringify([row.sourceScope, Number(location), sequence, timestamp])}`
  ) {
    return null;
  }
  const date =
    typeof approval.purchaseDate === "string"
      ? approval.purchaseDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
      : null;
  if (
    !date ||
    row.transactionDate !== `${date[3]}-${date[2]}-${date[1]}` ||
    approval.currencyIso !== row.currency ||
    typeof approval.originalAmount !== "string" ||
    row.currency === null
  ) {
    return null;
  }
  try {
    if (
      -decimalToMinor(approval.originalAmount, row.currency) !== row.amountMinor
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return merchantText(approval.businessName);
}

function postedMerchant(row: TransactionFacts): string | null {
  const namespace = row.details.provider.isracard ?? {};
  const rows = currentSourceRows(namespace);
  const observations = namespace.observations;
  if (
    !Array.isArray(observations) ||
    observations.length !== rows.length ||
    observations.some(
      (item) =>
        !object(item) ||
        (item.generation !== "digital" && item.generation !== "legacy"),
    )
  ) {
    return null;
  }
  if (
    rows.some(
      (item) =>
        !object(item) || isracardEvidenceGeneration(item) === "approval",
    )
  ) {
    return null;
  }
  const knownVoucher = (value: unknown) =>
    typeof value === "string" && value.trim() !== "";
  if (
    rows.some(
      (item) =>
        object(item) &&
        (isracardEvidenceGeneration(item) === "digital"
          ? !knownVoucher(item.seqVoucherNumber)
          : !knownVoucher(item.voucherNumberRatz) &&
            !knownVoucher(item.voucherNumberRatzOutbound)),
    )
  ) {
    return null;
  }
  const digital = rows.filter(
    (item) => object(item) && isracardEvidenceGeneration(item) === "digital",
  );
  // A legacy row with digital-looking keys cannot substitute for a digital source observation.
  if (
    digital.length === 0 ||
    digital.length !==
      observations.filter(
        (item) => object(item) && item.generation === "digital",
      ).length
  ) {
    return null;
  }
  let name: string | null = null;
  for (const observation of digital) {
    if (
      !object(observation) ||
      !["1", "7"].includes(String(observation.transactionCode))
    ) {
      return null;
    }
    const current = merchantText(observation.businessName);
    if (current === null || (name !== null && name !== current)) {
      return null;
    }
    name = current;
  }
  return name;
}

/**
 * Authorization classification is unstated; only a singleton may continue to a
 * verified purchase. Source sign provenance is informational, not a kind claim.
 * Shared matching still owns money/date/card equality, blockers and lifecycle.
 */
export function compatibleIsracardPostingGroups(
  pending: readonly TransactionFacts[],
  posted: readonly TransactionFacts[],
): boolean {
  if (pending.length !== 1 || posted.length !== 1) {
    return false;
  }
  const approval = pending[0]!;
  const purchase = posted[0]!;
  if (
    approval.kind !== "unknown" ||
    purchase.kind !== "purchase" ||
    ![approval, purchase].every(onlyPostingIssues)
  ) {
    return false;
  }
  const name = approvalMerchant(approval);
  return name !== null && name === postedMerchant(purchase);
}

/**
 * Observed processor presentation: an approval writes `PAYPAL *` and may repeat
 * the merchant's short first token at its end. No other token is removed.
 */
export function settledIsracardMerchant(
  pending: string | null,
  posted: string | null,
): boolean {
  const presented = (name: string | null) =>
    merchantPresentation(name)?.replace(/^PAYPAL\s*\*\s*/u, "PAYPAL ") ?? null;
  const shortened = (name: string) => {
    const tokens = name.split(" ");
    const last = tokens.pop()!;
    return tokens.length >= 4 &&
      new Set(tokens).size >= 4 &&
      /^[\p{L}\p{N}]{2,4}$/u.test(last) &&
      tokens.includes(last)
      ? tokens.join(" ")
      : undefined;
  };
  const left = presented(pending);
  const right = presented(posted);
  return (
    left !== null &&
    right !== null &&
    (left === right || shortened(left) === right)
  );
}

/**
 * Narrow identity-risk opt-in, not a new financial interpretation. Legacy rows
 * retain unknown kind/basis and every warning. Explicit contradictions and
 * unsupported source roles remain ineligible even when their names look alike.
 */
export function compatibleIsracardSettledPair(
  pending: TransactionFacts,
  posted: TransactionFacts,
): boolean {
  if (
    pending.kind !== "unknown" ||
    approvalMerchant(pending) === null ||
    !onlyPostingIssues(pending)
  ) {
    return false;
  }
  if (posted.kind === "purchase") {
    return postedMerchant(posted) !== null && onlyPostingIssues(posted);
  }
  if (
    posted.kind !== "unknown" ||
    posted.amountBasis !== "unknown" ||
    posted.currency !== "ILS" ||
    posted.providerTransactionCode !== null ||
    posted.counterpartyName !== null ||
    posted.description !== null ||
    posted.originalAmountMinor !== null ||
    posted.originalCurrency !== null ||
    posted.details.issues.some(
      (issue) =>
        ![
          "isracard_unverified_semantics",
          "unsupported_transaction_type",
          "unverified_amount_basis",
          "source_derived_amount_direction",
          "possible_pending_posted_match",
        ].includes(issue),
    ) ||
    ![
      "isracard_unverified_semantics",
      "unsupported_transaction_type",
      "unverified_amount_basis",
      "source_derived_amount_direction",
    ].every((issue) => posted.details.issues.includes(issue))
  ) {
    return false;
  }
  const namespace = posted.details.provider.isracard ?? {};
  const rows = currentSourceRows(namespace);
  const observations = namespace.observations;
  if (
    rows.length !== 1 ||
    !object(rows[0]) ||
    isracardEvidenceGeneration(rows[0]) !== "legacy" ||
    !Array.isArray(observations) ||
    observations.length !== 1 ||
    !object(observations[0]) ||
    observations[0].generation !== "legacy" ||
    typeof observations[0].path !== "string" ||
    !/\.txn(?:Israel|Abroad)\[/u.test(observations[0].path)
  ) {
    return false;
  }
  const row = rows[0];
  // Legacy keeps a domestic row's facts in plain fields and an abroad-section
  // row's in `Outbound` fields, even when that row is stated in local currency.
  const abroad = observations[0].path.includes(".txnAbroad[");
  const payment = abroad ? row.paymentSumOutbound : row.paymentSum;
  const deal = abroad ? row.dealSumOutbound : row.dealSum;
  const name = abroad ? row.fullSupplierNameOutbound : row.fullSupplierNameHeb;
  const empty = (value: unknown) =>
    value === undefined || value === null || value === "";
  const local = (value: unknown) => legacyCurrency(value) === "ILS";
  if (
    !local(row.currencyId) ||
    !(empty(row.currentPaymentCurrency) || local(row.currentPaymentCurrency)) ||
    !(empty(row.kodMatbeaMekori) || local(row.kodMatbeaMekori)) ||
    !empty(row.moreInfo) ||
    !empty(row.dealSumType) ||
    !(empty(row.paymentSumSign) || row.paymentSumSign === "+") ||
    (!abroad && !empty(row.paymentSumOutbound)) ||
    (!abroad && !empty(row.dealSumOutbound)) ||
    merchantText(name) !== merchantText(posted.merchantName)
  ) {
    return false;
  }
  try {
    return (
      typeof payment === "string" &&
      typeof deal === "string" &&
      -decimalToMinor(payment, "ILS") === posted.amountMinor &&
      decimalToMinor(payment, "ILS") === decimalToMinor(deal, "ILS")
    );
  } catch {
    return false;
  }
}

/** Applies only where the deployment enables settled posting. */
export const isracardSettlementPolicy = {
  compatiblePair: compatibleIsracardSettledPair,
  sameMerchant: settledIsracardMerchant,
};
