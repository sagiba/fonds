import type { JsonObject, TransactionFacts } from "../../domain/model.js";
import { canonicalJson } from "../../domain/observations.js";
import type { PostingMatchEvidence } from "../../domain/source-adapter.js";

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
): { card: string; evidence: PostingMatchEvidence } | null {
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
 * Decode retained CAL observations only; sticky canonical enrichment is not
 * evidence. Every retained observation must name the same card, the card the
 * extractor derived the row's card key from.
 */
export function calPostingEvidence(
  row: Pick<TransactionFacts, "details">,
): PostingMatchEvidence | null {
  const rows = row.details.provider.cal?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
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
