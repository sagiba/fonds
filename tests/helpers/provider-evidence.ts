import type { JsonValue, TransactionDetails } from "../../src/domain/model.js";

/** Untyped provider evidence retained across observations (`provider.<name>.retained`). */
export function retained(
  details: TransactionDetails,
  key: "comments" | "paymentHistory",
  provider = "cal",
): JsonValue[] {
  const evidence = details.provider[provider]?.retained;
  const items =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? evidence[key]
      : undefined;
  return Array.isArray(items) ? items : [];
}
