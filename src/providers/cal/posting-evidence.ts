import type { JsonObject, TransactionFacts } from "../../domain/model.js";
import { canonicalJson } from "../../domain/observations.js";
import { currentSourceRows } from "../../domain/provider-evidence.js";

/** Opaque CAL discriminators; null is missing evidence, never false or zero. */
export interface CalPostingEvidence {
  merchantName: string | null;
  categoryCode: string | null;
  sourceTypeCode: string | null;
  cardPresent: boolean | null;
  tokenCode: string | null;
  paymentCount: number | null;
  abroad: boolean | null;
  merchantProviderId: string | null;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : undefined;
}

function name(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    value = Number(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function code(value: unknown): string | undefined {
  const number = integer(value);
  return number === undefined ? undefined : String(number);
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function known<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Undefined is malformed/conflicting; null is missing. Never coerce null to zero. */
function aliases<T>(
  row: JsonObject,
  keys: string[],
  decode: (value: unknown) => T | undefined,
): T | null | undefined {
  const values = keys
    .filter((key) => Object.hasOwn(row, key))
    .map((key) => (row[key] === null ? null : decode(row[key])));
  if (values.some((value) => value === undefined) || new Set(values).size > 1) {
    return undefined;
  }
  return values[0] ?? null;
}

function rowEvidence(
  raw: JsonObject,
): { card: string; evidence: CalPostingEvidence } | null {
  const card = aliases(raw, ["cardUniqueID", "cardUniqueId"], identifier);
  const merchantName = aliases(raw, ["merchantName"], name);
  const categoryCode = aliases(raw, ["internationalBranchID"], code);
  const sourceTypeCode = aliases(
    raw,
    ["trnTypeCode", "transactionTypeCode"],
    code,
  );
  const cardPresent = aliases(raw, ["transCardPresentInd"], boolean);
  const tokenCode = aliases(raw, ["walletTranInd", "tokenInd"], code);
  const paymentCount = aliases(
    raw,
    ["numberOfPayments", "numOfPayments"],
    integer,
  );
  const abroad = aliases(
    raw,
    ["isAbroadApproval", "isAbroadTransaction"],
    boolean,
  );
  const merchantProviderId = aliases(raw, ["merchantId"], identifier);
  if (
    !known(card) ||
    !known(merchantName) ||
    !known(categoryCode) ||
    !known(sourceTypeCode) ||
    !known(cardPresent) ||
    !known(tokenCode) ||
    !known(paymentCount) ||
    // Abroad and merchant ID may be missing (null), but not malformed.
    abroad === undefined ||
    merchantProviderId === undefined ||
    // CAL type 8 is an installment even when its raw count is zero.
    sourceTypeCode === "8" ||
    paymentCount !== 0
  ) {
    return null;
  }
  return {
    card,
    evidence: {
      merchantName,
      categoryCode,
      sourceTypeCode,
      cardPresent,
      tokenCode,
      paymentCount,
      abroad,
      merchantProviderId,
    },
  };
}

/**
 * Decode the current CAL source statements; sticky canonical enrichment is not
 * evidence. Every current observation must name the same card, the card the
 * extractor derived the row's card key from.
 */
export function calPostingEvidence(
  row: Pick<TransactionFacts, "details">,
): CalPostingEvidence | null {
  const rows = currentSourceRows(row.details.provider.cal ?? {});
  if (rows.length === 0) {
    return null;
  }
  const evidence = rows.map((raw) => (object(raw) ? rowEvidence(raw) : null));
  const representative = evidence[0];
  return representative &&
    evidence.every(
      (item) =>
        item !== null && canonicalJson(item) === canonicalJson(representative),
    )
    ? representative.evidence
    : null;
}

/** NFC only: preserve case, punctuation, quotes and compatibility distinctions. */
function normalizedEvidence(evidence: CalPostingEvidence | null) {
  if (
    evidence === null ||
    evidence.merchantName === null ||
    evidence.categoryCode === null ||
    evidence.sourceTypeCode === null ||
    evidence.cardPresent === null ||
    evidence.tokenCode === null ||
    evidence.paymentCount === null
  ) {
    return null;
  }
  const merchantName = evidence.merchantName
    .normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(merchantName)
    ? { ...evidence, merchantName }
    : null;
}

function homogeneousEvidence(rows: readonly TransactionFacts[]) {
  const evidence = rows.map((row) =>
    (row.kind === "purchase" || row.kind === "refund") &&
    row.details.issues.every(
      (issue) => issue === "possible_pending_posted_match",
    )
      ? normalizedEvidence(calPostingEvidence(row))
      : null,
  );
  const representative = evidence[0];
  return representative &&
    evidence.every(
      (item) =>
        item !== null && canonicalJson(item) === canonicalJson(representative),
    )
    ? representative
    : null;
}

/** CAL's observed merchant truncation and source discriminators admit whole twins. */
export function compatibleCalPostingGroups(
  pending: readonly TransactionFacts[],
  posted: readonly TransactionFacts[],
): boolean {
  const left = homogeneousEvidence(pending);
  const right = homogeneousEvidence(posted);
  if (!left || !right) {
    return false;
  }
  const compatibleName =
    left.merchantName === right.merchantName ||
    (left.merchantName.startsWith(right.merchantName + " ") &&
      right.merchantName
        .split(" ")
        .filter((token) => /[\p{L}\p{N}]/u.test(token)).length >= 2);
  return (
    compatibleName &&
    left.categoryCode === right.categoryCode &&
    left.sourceTypeCode === right.sourceTypeCode &&
    left.cardPresent === right.cardPresent &&
    left.tokenCode === right.tokenCode &&
    left.paymentCount === right.paymentCount &&
    (["abroad", "merchantProviderId"] as const).every(
      (field) =>
        left[field] === null ||
        right[field] === null ||
        left[field] === right[field],
    )
  );
}
