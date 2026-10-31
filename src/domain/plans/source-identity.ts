import type { TransactionFacts } from "../model.js";
import { canonicalJson } from "../observations.js";
import { currentSourceRows } from "../provider-evidence.js";
import type { Transaction } from "../records.js";
import type { SourceAdapter } from "../source-adapter.js";
import { retainedTransactionEvidence } from "../transaction-content.js";
import { type LedgerRow, providerIdentity } from "./state.js";

const financialFields = [
  "amountMinor",
  "currency",
  "amountBasis",
  "originalAmountMinor",
  "originalCurrency",
  "kind",
  "status",
  "transactionDate",
  "bookingDate",
  "billingDate",
  "installmentCount",
  "installmentNumber",
  "purchaseId",
  "merchantCategoryCode",
  "merchantName",
  "merchantProviderId",
  "description",
  "counterpartyName",
  "fxFeeMinor",
  "fxFeeCurrency",
] as const;

type FinancialFacts = Pick<TransactionFacts, (typeof financialFields)[number]>;

export function financialFacts(row: TransactionFacts): FinancialFacts {
  return Object.fromEntries(
    financialFields.map((field) => [field, row[field]]),
  ) as FinancialFacts;
}

export function financialState(row: TransactionFacts) {
  return {
    ...financialFacts(row),
    currencyExchange: row.details.currencyExchange ?? null,
  };
}

export function declaredIdentityBase(
  row: LedgerRow | Pick<TransactionFacts, "details">,
  provider: string,
): string | undefined {
  const identity = providerIdentity(row, provider);
  if (
    identity &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    typeof identity.baseKey === "string"
  ) {
    return identity.baseKey;
  }
  return undefined;
}

export function identityBase(
  row: LedgerRow | Pick<TransactionFacts, "sourceKey" | "details">,
  provider: string,
): string {
  return declaredIdentityBase(row, provider) ?? row.sourceKey;
}

export type SourceIdentityFacts = TransactionFacts &
  Pick<Transaction, "sourceEvidence">;

export function identitySourceRows(
  row: TransactionFacts,
  adapter: SourceAdapter,
) {
  const namespace = row.details.provider[adapter.provider] ?? {};
  return currentSourceRows({
    ...retainedTransactionEvidence(row, adapter),
    ...(namespace.identity === undefined
      ? {}
      : { identity: namespace.identity }),
  });
}

export function identityFingerprint(
  row: SourceIdentityFacts,
  includeSource: boolean,
  adapter: SourceAdapter,
): string {
  return canonicalJson({
    financial: row.sourceEvidence?.identity?.financialFingerprint ?? null,
    source: includeSource ? identitySourceRows(row, adapter) : undefined,
  });
}

export function groupSignature(
  rows: SourceIdentityFacts[],
  includeSource: boolean,
  adapter: SourceAdapter,
): string {
  return JSON.stringify(
    rows.map((row) => identityFingerprint(row, includeSource, adapter)).sort(),
  );
}
