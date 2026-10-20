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
