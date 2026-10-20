import type { TransactionFacts } from "../../src/domain/model.js";
import type { PostingMatchEvidence } from "../../src/domain/source-adapter.js";

/** Invented provider evidence; individual tests override fields without CAL details. */
export function postingEvidence(
  row: Pick<
    TransactionFacts,
    "merchantName" | "merchantCategoryCode" | "merchantProviderId"
  >,
): PostingMatchEvidence {
  return {
    merchantName: row.merchantName,
    categoryCode: row.merchantCategoryCode ?? "5411",
    sourceTypeCode: "5",
    cardPresent: false,
    tokenCode: "0",
    paymentCount: 0,
    abroad: null,
    merchantProviderId: row.merchantProviderId,
  };
}
