import type { TransactionFacts } from "../../domain/model.js";
import { canonicalJson } from "../../domain/observations.js";
import {
  currentSourceRows,
  evidenceObject,
  scalarFields,
} from "../../domain/provider-evidence.js";
import type {
  ExtractionResult,
  FinancialAuthority,
} from "../../domain/source-adapter.js";
import { isracardEvidenceGeneration } from "./evidence.js";

// Equality is continuity of this exact component, not a claim that legacy
// dealSum supplies the original-money role or proves a purchase classification.
const legacyFinancialShape =
  scalarFields(`voucherNumber voucherNumberRatz voucherNumberRatzOutbound
  fullPurchaseDate fullPurchaseDateOutbound purchaseDate purchaseDateOutbound
  paymentSum paymentSumOutbound paymentSumSign dealSum dealSumOutbound dealSumType
  currencyId currentPaymentCurrency kodMatbeaMekori moreInfo`);

/** Pure declaration from the current parsed row; source coverage is not authority. */
export function isracardFinancialAuthority(
  input: Readonly<TransactionFacts>,
  extraction: Pick<ExtractionResult, "warnings">,
): FinancialAuthority {
  if (
    input.status !== "posted" ||
    input.identityStrength !== "native" ||
    input.purchaseId !== null ||
    input.installmentNumber !== null ||
    (input.installmentCount !== null && input.installmentCount > 1)
  ) {
    return { kind: "asserted" };
  }
  const namespace = input.details.provider.isracard ?? {};
  const rows = currentSourceRows(namespace);
  const legacy = rows.filter(
    (row) => isracardEvidenceGeneration(row) === "legacy",
  );
  if (
    legacy.length !== 1 ||
    input.amountMinor === null ||
    input.currency === null
  ) {
    return { kind: "asserted" };
  }
  const continuitySignature = canonicalJson({
    legacy: evidenceObject(legacy[0], legacyFinancialShape),
  });
  const unavailable = [
    "missing_required_digital_response",
    "invalid_digital_response",
  ].find((reason) => extraction.warnings.includes(reason));
  if (unavailable === undefined) {
    return { kind: "asserted", continuitySignature };
  }
  const expectedIssues = new Set([
    "isracard_unverified_semantics",
    "unsupported_transaction_type",
    "unverified_amount_basis",
    "source_derived_amount_direction",
    "conflicting_payment_context",
    "conflicting_billing_date",
    "invalid_transaction_detail",
    "ambiguous_transaction_detail",
  ]);
  if (
    rows.length !== 1 ||
    input.providerTransactionCode !== null ||
    input.details.issues.some((issue) => !expectedIssues.has(issue))
  ) {
    return { kind: "conflicting" };
  }
  return {
    kind: "incomplete",
    reason: unavailable,
    continuitySignature,
  };
}
