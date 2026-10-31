import {
  detailsSchema,
  type JsonValue,
  providerStateFields,
  sourceAbsenceSchema,
  sourceEvidenceSchema,
} from "../domain/model.js";
import { canonicalJson } from "../domain/observations.js";
import type { FinancialPlan, NarrowRow } from "../domain/plans/state.js";
import { sortedEvidence } from "../domain/provider-evidence.js";
import type { TransactionListFacts } from "../domain/read-model.js";
import type { Transaction } from "../domain/records.js";
import type { LedgerColumn, LedgerFlags, ListColumn } from "./sql.js";

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
  | "details"
  | "lastSeenAt"
  | "lastSeenRunId"
  | "sourceAbsence"
  | "sourceEvidence"
> & {
  sourceAbsence: NonNullable<Transaction["sourceAbsence"]> | null;
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
  sourceEvidence: NonNullable<Transaction["sourceEvidence"]> | null;
  paymentContextConflicts: NonNullable<
    Details["paymentContextConflicts"]
  > | null;
  pendingPostingCandidates: string[] | null;
  rejectedPostingKeys: string[] | null;
  postingOverlap: NonNullable<Details["postingOverlap"]> | null;
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
    sourceEvidence: _sourceEvidence,
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
    sourceAbsence: row.sourceAbsence
      ? sourceAbsenceSchema.parse(row.sourceAbsence)
      : null,
    transactionDateTime: details.transactionDateTime ?? null,
    merchantAddressLine: details.merchant.address,
    merchantPhone: details.merchant.phone,
    merchantCity: details.merchant.city ?? null,
    merchantCountryCode: details.merchant.countryCode ?? null,
    additionalInformation: details.additionalInformation?.length
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
    sourceEvidence: row.sourceEvidence
      ? sourceEvidenceSchema.parse(row.sourceEvidence)
      : null,
    paymentContextConflicts: row.details.paymentContextConflicts ?? null,
    pendingPostingCandidates: row.details.pendingPostingCandidates ?? null,
    rejectedPostingKeys: row.details.rejectedPostingKeys ?? null,
    postingOverlap: row.details.postingOverlap ?? null,
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

/** The details a list item presents; full and list decodes share them. */
function listedDetails(
  row: Pick<
    StoredRow,
    | "transactionDateTime"
    | "merchantAddressLine"
    | "merchantPhone"
    | "merchantCity"
    | "merchantCountryCode"
    | "currencyExchange"
    | "sourceIssues"
  >,
  {
    pendingPostingCandidates,
  }: Pick<Reconciliation, "pendingPostingCandidates">,
) {
  return {
    ...(row.transactionDateTime === null
      ? {}
      : { transactionDateTime: row.transactionDateTime }),
    merchant: {
      address: row.merchantAddressLine,
      phone: row.merchantPhone,
      ...(row.merchantCity === null ? {} : { city: row.merchantCity }),
      ...(row.merchantCountryCode === null
        ? {}
        : { countryCode: row.merchantCountryCode }),
    },
    ...(row.currencyExchange === null
      ? {}
      : { currencyExchange: row.currencyExchange }),
    issues: row.sourceIssues,
    ...(pendingPostingCandidates === null ? {} : { pendingPostingCandidates }),
  };
}

export function decodeTransaction(input: {
  row: StoredRow;
  observation: Observation;
  reconciliation: Reconciliation;
  posting: PostingLink;
}): Transaction {
  const {
    sourceAbsence,
    transactionDateTime: _transactionDateTime,
    merchantAddressLine: _merchantAddressLine,
    merchantPhone: _merchantPhone,
    merchantCity: _merchantCity,
    merchantCountryCode: _merchantCountryCode,
    additionalInformation,
    currencyExchange: _currencyExchange,
    sourceIssues: _sourceIssues,
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
    ...(sourceAbsence === null
      ? {}
      : { sourceAbsence: sourceAbsenceSchema.parse(sourceAbsence) }),
    ...(input.reconciliation.sourceEvidence == null
      ? {}
      : {
          sourceEvidence: sourceEvidenceSchema.parse(
            input.reconciliation.sourceEvidence,
          ),
        }),
    lastSeenAt: input.observation.lastSeenAt,
    lastSeenRunId: input.observation.lastSeenRunId,
    details: detailsSchema.parse({
      schemaVersion: 1,
      ...listedDetails(input.row, input.reconciliation),
      ...(additionalInformation?.length ? { additionalInformation } : {}),
      sourceRefs: input.observation.sourceRefs,
      provider: evidence,
      ...(input.reconciliation.paymentContextConflicts === null
        ? {}
        : {
            paymentContextConflicts:
              input.reconciliation.paymentContextConflicts,
          }),
      ...(input.reconciliation.rejectedPostingKeys === null
        ? {}
        : { rejectedPostingKeys: input.reconciliation.rejectedPostingKeys }),
      ...(input.reconciliation.postingOverlap === null
        ? {}
        : { postingOverlap: input.reconciliation.postingOverlap }),
      ...(input.posting.postingLink === null
        ? {}
        : { postingLink: input.posting.postingLink }),
    }),
  };
}

const listDetailsSchema = detailsSchema.pick({
  transactionDateTime: true,
  merchant: true,
  currencyExchange: true,
  issues: true,
  pendingPostingCandidates: true,
});

type StoredListRow = Pick<StoredRow, ListColumn>;

/** Decodes only what a list item presents; omitted evidence stays absent. */
export function decodeTransactionListFacts(input: {
  row: StoredListRow;
  reconciliation: Pick<Reconciliation, "pendingPostingCandidates">;
}): TransactionListFacts {
  const {
    sourceAbsence,
    transactionDateTime: _transactionDateTime,
    merchantAddressLine: _merchantAddressLine,
    merchantPhone: _merchantPhone,
    merchantCity: _merchantCity,
    merchantCountryCode: _merchantCountryCode,
    currencyExchange: _currencyExchange,
    sourceIssues: _sourceIssues,
    ...facts
  } = input.row;
  return {
    ...facts,
    ...(sourceAbsence === null
      ? {}
      : { sourceAbsence: sourceAbsenceSchema.parse(sourceAbsence) }),
    details: listDetailsSchema.parse(
      listedDetails(input.row, input.reconciliation),
    ),
  };
}

/** State-only writes must not update the canonical transaction row. */
export function transactionContentWrites(plan: FinancialPlan): StoredRow[] {
  return plan.orderedTransactionWrites().flatMap((row) => {
    const encoded = encodeTransaction(row);
    const before = plan.original(row.id);
    return before &&
      canonicalJson(encodeTransaction(before)) === canonicalJson(encoded)
      ? []
      : [encoded];
  });
}

const ledgerDetailsSchema = detailsSchema.pick({
  issues: true,
  pendingPostingCandidates: true,
  rejectedPostingKeys: true,
  postingOverlap: true,
});

/**
 * A narrow ledger row, and whether its stored text left a fact in doubt; a
 * row in doubt must be hydrated before planning. Shared fields decode as
 * `decodeTransaction` decodes them.
 */
export function decodeLedgerRow(
  input: {
    row: Pick<StoredRow, LedgerColumn>;
    observation: Pick<Observation, "lastSeenAt" | "lastSeenRunId">;
    reconciliation: Pick<
      Reconciliation,
      | "pendingPostingCandidates"
      | "rejectedPostingKeys"
      | "postingOverlap"
      | "providerIdentity"
    >;
    flags: LedgerFlags;
  },
  connectionId: string,
): { row: NarrowRow; doubt: boolean } {
  const { sourceAbsence, sourceIssues, ...facts } = input.row;
  // Only proofs of `ledgerFlags` decide; every other case is in doubt.
  const { flags } = input;
  const retiredKnown =
    flags.evidenceEscapes === 0 &&
    (flags.retiredMentions === 0 ||
      (flags.retiredMentions === 1 &&
        flags.retiredTrue + flags.retiredFalse === 1));
  const linkKnown = flags.linkAbsent + flags.linkObject === 1;
  const identityKnown =
    flags.providerIdentityMentions === 0 && flags.providerEscapes === 0;
  const { reconciliation } = input;
  return {
    doubt: !retiredKnown || !linkKnown || !identityKnown,
    row: {
      ...facts,
      connectionId,
      ...(sourceAbsence === null
        ? {}
        : { sourceAbsence: sourceAbsenceSchema.parse(sourceAbsence) }),
      lastSeenAt: input.observation.lastSeenAt,
      lastSeenRunId: input.observation.lastSeenRunId,
      hydration: "narrow",
      retired: retiredKnown && flags.retiredTrue === 1,
      providerIdentity: reconciliation.providerIdentity ?? {},
      details: {
        ...ledgerDetailsSchema.parse({
          issues: sourceIssues,
          ...(reconciliation.pendingPostingCandidates === null
            ? {}
            : {
                pendingPostingCandidates:
                  reconciliation.pendingPostingCandidates,
              }),
          ...(reconciliation.rejectedPostingKeys === null
            ? {}
            : { rejectedPostingKeys: reconciliation.rejectedPostingKeys }),
          ...(reconciliation.postingOverlap === null
            ? {}
            : { postingOverlap: reconciliation.postingOverlap }),
        }),
        ...(flags.linkObject === 1
          ? { postingLink: { present: true } as const }
          : {}),
      },
    },
  };
}

/** The narrow projection of a complete row, for checking a narrow decode. */
export function narrowFacts(row: Transaction): NarrowRow {
  const {
    sourceEvidence,
    details,
    description: _description,
    counterpartyName: _counterpartyName,
    merchantProviderId: _merchantProviderId,
    merchantCategoryCode: _merchantCategoryCode,
    cardPresent: _cardPresent,
    authorizationMethod: _authorizationMethod,
    wallet: _wallet,
    threeDSecureUsed: _threeDSecureUsed,
    recurring: _recurring,
    providerTransactionCode: _providerTransactionCode,
    fxFeeMinor: _fxFeeMinor,
    fxFeeCurrency: _fxFeeCurrency,
    ...facts
  } = row;
  const providerIdentity: Record<string, JsonValue> = {};
  for (const [provider, namespace] of Object.entries(details.provider)) {
    if (namespace.identity !== undefined) {
      providerIdentity[provider] = namespace.identity;
    }
  }
  return {
    ...facts,
    hydration: "narrow",
    retired: sourceEvidence?.identity?.retiredFromMatching === true,
    providerIdentity,
    details: {
      issues: details.issues,
      ...(details.pendingPostingCandidates === undefined
        ? {}
        : { pendingPostingCandidates: details.pendingPostingCandidates }),
      ...(details.rejectedPostingKeys === undefined
        ? {}
        : { rejectedPostingKeys: details.rejectedPostingKeys }),
      ...(details.postingOverlap === undefined
        ? {}
        : { postingOverlap: details.postingOverlap }),
      ...(details.postingLink === undefined
        ? {}
        : { postingLink: { present: true } as const }),
    },
  };
}
