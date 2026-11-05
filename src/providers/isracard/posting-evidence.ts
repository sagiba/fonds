import type { JsonObject, TransactionFacts } from "../../domain/model.js";
import { decimalToMinor } from "../../domain/money.js";
import { currentSourceRows } from "../../domain/provider-evidence.js";
import { isracardEvidenceGeneration } from "./evidence.js";

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Match only presentation whitespace and canonical Unicode, preserving case and punctuation. */
function merchant(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : null;
}

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
  return merchant(approval.businessName);
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
    const current = merchant(observation.businessName);
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
    ![approval, purchase].every((row) =>
      row.details.issues.every(
        (issue) =>
          issue === "source_derived_amount_direction" ||
          issue === "possible_pending_posted_match",
      ),
    )
  ) {
    return false;
  }
  const name = approvalMerchant(approval);
  return name !== null && name === postedMerchant(purchase);
}

/** Processor presentation only; no submerchant token or punctuation is removed. */
export function settledIsracardMerchant(name: string | null): string | null {
  return (
    name
      ?.normalize("NFC")
      .replace(/\p{White_Space}+/gu, " ")
      .trim()
      .toUpperCase()
      .replace(/^PAYPAL\s*\*\s*/u, "PAYPAL ") ?? null
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
    pending.details.issues.some(
      (issue) =>
        ![
          "source_derived_amount_direction",
          "possible_pending_posted_match",
        ].includes(issue),
    )
  ) {
    return false;
  }
  if (posted.kind === "purchase") {
    return (
      postedMerchant(posted) !== null &&
      posted.details.issues.every((issue) =>
        [
          "source_derived_amount_direction",
          "possible_pending_posted_match",
        ].includes(issue),
      )
    );
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
    !observations[0].path.includes(".txnIsrael[")
  ) {
    return false;
  }
  const row = rows[0];
  const empty = (value: unknown) =>
    value === undefined || value === null || value === "";
  if (
    typeof row.voucherNumberRatz !== "string" ||
    !row.voucherNumberRatz.trim() ||
    row.currencyId !== "ILS" ||
    row.currentPaymentCurrency !== "ILS" ||
    ![
      row.moreInfo,
      row.dealSumType,
      row.paymentSumOutbound,
      row.dealSumOutbound,
      row.fullPurchaseDateOutbound,
    ].every(empty) ||
    !(empty(row.kodMatbeaMekori) || row.kodMatbeaMekori === "ILS") ||
    !(empty(row.paymentSumSign) || row.paymentSumSign === "+") ||
    merchant(row.fullSupplierNameHeb) !== merchant(posted.merchantName)
  ) {
    return false;
  }
  const date =
    typeof row.fullPurchaseDate === "string"
      ? row.fullPurchaseDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/u)
      : null;
  if (!date || posted.transactionDate !== `${date[3]}-${date[2]}-${date[1]}`) {
    return false;
  }
  try {
    return (
      typeof row.paymentSum === "string" &&
      typeof row.dealSum === "string" &&
      -decimalToMinor(row.paymentSum, "ILS") === posted.amountMinor &&
      decimalToMinor(row.paymentSum, "ILS") ===
        decimalToMinor(row.dealSum, "ILS")
    );
  } catch {
    return false;
  }
}

/** Applies only where the deployment enables settled posting. */
export const isracardSettlementPolicy = {
  compatiblePair: compatibleIsracardSettledPair,
  merchantName: settledIsracardMerchant,
};
