import {
  detailsSchema,
  type JsonValue,
  providerStateFields,
} from "../domain/model.js";
import { canonicalJson } from "../domain/observations.js";
import type { FinancialPlan } from "../domain/plans/state.js";
import { sortedEvidence } from "../domain/provider-evidence.js";
import type { Transaction } from "../domain/records.js";

export { decodeScalarText, encodeScalarText } from "./scalar-text.js";

const providerStateColumns = {
  identity: "providerIdentity",
  observations: "providerObservations",
  monetaryEvidence: "providerMonetaryEvidence",
  billingMonth: "providerBillingMonth",
  currencyMapping: "providerCurrencyMapping",
} as const satisfies Record<
  (typeof providerStateFields)[number],
  keyof TransactionReconciliationRow
>;
const operationalProviderFields = providerStateFields.map(
  (field) => [field, providerStateColumns[field]] as const,
);

type Details = Transaction["details"];

export type StoredTransactionRow = Omit<
  Transaction,
  "details" | "lastSeenAt" | "lastSeenRunId"
> & {
  transactionDateTime: string | null;
  merchantAddressLine: string | null;
  merchantPhone: string | null;
  merchantCity: string | null;
  merchantCountryCode: string | null;
  additionalInformation: NonNullable<Details["additionalInformation"]> | null;
  currencyExchange: NonNullable<Details["currencyExchange"]> | null;
  sourceIssues: string[];
  provider: Details["provider"];
};

type StoredRow = StoredTransactionRow;

export interface TransactionObservationRow {
  transactionId: string;
  lastSeenAt: string;
  lastSeenRunId: string;
  sourceRefs: Details["sourceRefs"];
}

type Observation = TransactionObservationRow;

export interface TransactionReconciliationRow {
  transactionId: string;
  paymentContextConflicts: NonNullable<
    Details["paymentContextConflicts"]
  > | null;
  pendingPostingCandidates: string[] | null;
  rejectedPostingKeys: string[] | null;
  providerIdentity: Record<string, JsonValue> | null;
  providerObservations: Record<string, JsonValue> | null;
  providerMonetaryEvidence: Record<string, JsonValue> | null;
  providerBillingMonth: Record<string, JsonValue> | null;
  providerCurrencyMapping: Record<string, JsonValue> | null;
}

type Reconciliation = TransactionReconciliationRow;

export interface TransactionPostingLinkRow {
  transactionId: string;
  postingLink: NonNullable<Details["postingLink"]> | null;
}

type PostingLink = TransactionPostingLinkRow;

export function encodeTransaction(row: Transaction): StoredRow {
  const {
    details,
    lastSeenAt: _lastSeenAt,
    lastSeenRunId: _lastSeenRunId,
    ...facts
  } = row;
  const provider = structuredClone(details.provider);
  for (const evidence of Object.values(provider)) {
    for (const [field] of operationalProviderFields) {
      delete evidence[field];
    }
  }
  return {
    ...facts,
    transactionDateTime: details.transactionDateTime ?? null,
    merchantAddressLine: details.merchant.address,
    merchantPhone: details.merchant.phone,
    merchantCity: details.merchant.city ?? null,
    merchantCountryCode: details.merchant.countryCode ?? null,
    additionalInformation: details.additionalInformation
      ? sortedEvidence(details.additionalInformation)
      : null,
    currencyExchange: details.currencyExchange ?? null,
    sourceIssues: sortedEvidence([...new Set(details.issues)]),
    provider,
  };
}

export function encodeObservation(row: Transaction): Observation {
  return {
    transactionId: row.id,
    lastSeenAt: row.lastSeenAt,
    lastSeenRunId: row.lastSeenRunId,
    sourceRefs: row.details.sourceRefs,
  };
}

export function encodeReconciliation(row: Transaction): Reconciliation {
  const result: Reconciliation = {
    transactionId: row.id,
    paymentContextConflicts: row.details.paymentContextConflicts ?? null,
    pendingPostingCandidates: row.details.pendingPostingCandidates ?? null,
    rejectedPostingKeys: row.details.rejectedPostingKeys ?? null,
    providerIdentity: null,
    providerObservations: null,
    providerMonetaryEvidence: null,
    providerBillingMonth: null,
    providerCurrencyMapping: null,
  };
  for (const [provider, evidence] of Object.entries(row.details.provider)) {
    for (const [field, column] of operationalProviderFields) {
      if (evidence[field] !== undefined) {
        (result[column] ??= {})[provider] = evidence[field];
      }
    }
  }
  return result;
}

export function decodeTransaction(input: {
  row: StoredRow;
  observation: Observation;
  reconciliation: Reconciliation;
  posting: PostingLink;
}): Transaction {
  const {
    transactionDateTime,
    merchantAddressLine,
    merchantPhone,
    merchantCity,
    merchantCountryCode,
    additionalInformation,
    currencyExchange,
    sourceIssues,
    provider,
    ...facts
  } = input.row;
  const evidence = structuredClone(provider);
  for (const [field, column] of operationalProviderFields) {
    for (const [provider, value] of Object.entries(
      input.reconciliation[column] ?? {},
    )) {
      (evidence[provider] ??= {})[field] = value as JsonValue;
    }
  }
  return {
    ...facts,
    lastSeenAt: input.observation.lastSeenAt,
    lastSeenRunId: input.observation.lastSeenRunId,
    details: detailsSchema.parse({
      schemaVersion: 1,
      ...(transactionDateTime === null ? {} : { transactionDateTime }),
      merchant: {
        address: merchantAddressLine,
        phone: merchantPhone,
        ...(merchantCity === null ? {} : { city: merchantCity }),
        ...(merchantCountryCode === null
          ? {}
          : { countryCode: merchantCountryCode }),
      },
      ...(additionalInformation === null ? {} : { additionalInformation }),
      ...(currencyExchange === null ? {} : { currencyExchange }),
      sourceRefs: input.observation.sourceRefs,
      issues: sourceIssues,
      provider: evidence,
      ...(input.reconciliation.paymentContextConflicts === null
        ? {}
        : {
            paymentContextConflicts:
              input.reconciliation.paymentContextConflicts,
          }),
      ...(input.reconciliation.pendingPostingCandidates === null
        ? {}
        : {
            pendingPostingCandidates:
              input.reconciliation.pendingPostingCandidates,
          }),
      ...(input.reconciliation.rejectedPostingKeys === null
        ? {}
        : { rejectedPostingKeys: input.reconciliation.rejectedPostingKeys }),
      ...(input.posting.postingLink === null
        ? {}
        : { postingLink: input.posting.postingLink }),
    }),
  };
}

/** State-only writes must not update the canonical transaction row. */
export function transactionContentWrites(plan: FinancialPlan): StoredRow[] {
  const previous = new Map(plan.snapshot.rows.map((row) => [row.id, row]));
  return plan.orderedTransactionWrites().flatMap((row) => {
    const encoded = encodeTransaction(row);
    const before = previous.get(row.id);
    return before &&
      canonicalJson(encodeTransaction(before)) === canonicalJson(encoded)
      ? []
      : [encoded];
  });
}
