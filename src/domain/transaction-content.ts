import {
  type JsonObject,
  providerStateFields,
  type TransactionFacts,
} from "./model.js";
import { canonicalJson } from "./observations.js";
import { sortedEvidence } from "./provider-evidence.js";
import type { SourceAdapter } from "./source-adapter.js";

/** Stored semantic fields also declare the public names used by change notifications. */
export const transactionContentFields = {
  cardId: "cardId",
  identityStrength: "source.identityStrength",
  amountMinor: "amount",
  currency: "amount",
  originalAmountMinor: "originalAmount",
  originalCurrency: "originalAmount",
  amountBasis: "amountBasis",
  kind: "kind",
  status: "status",
  transactionDate: "transactionDate",
  bookingDate: "bookingDate",
  billingDate: "billingDate",
  installmentCount: "installmentCount",
  installmentNumber: "installmentNumber",
  purchaseId: "purchaseId",
  merchantCategoryCode: "merchant.categoryCode",
  merchantName: "merchant.name",
  merchantProviderId: "merchant.providerId",
  description: "description",
  counterpartyName: "counterpartyName",
  fxFeeMinor: "fxFee",
  fxFeeCurrency: "fxFee",
  cardPresent: "cardPresent",
  authorizationMethod: "authorizationMethod",
  wallet: "wallet",
  threeDSecureUsed: "threeDSecureUsed",
  recurring: "recurring",
  providerTransactionCode: "providerTransactionCode",
} as const satisfies Record<
  Exclude<
    keyof TransactionFacts,
    "sourceScope" | "sourceKey" | "sourceAliases" | "details"
  >,
  string
>;

export const transactionDetailContent = {
  transactionDateTime: {
    name: "transactionDateTime",
    read: (row: TransactionFacts) => row.details.transactionDateTime ?? null,
  },
  merchantAddressLine: {
    name: "merchant.addressLine",
    read: (row: TransactionFacts) => row.details.merchant.address,
  },
  merchantPhone: {
    name: "merchant.phone",
    read: (row: TransactionFacts) => row.details.merchant.phone,
  },
  merchantCity: {
    name: "merchant.city",
    read: (row: TransactionFacts) => row.details.merchant.city ?? null,
  },
  merchantCountryCode: {
    name: "merchant.countryCode",
    read: (row: TransactionFacts) => row.details.merchant.countryCode ?? null,
  },
  additionalInformation: {
    name: "additionalInformation",
    read: (row: TransactionFacts) =>
      sortedEvidence(row.details.additionalInformation ?? []),
  },
  currencyExchange: {
    name: "currencyExchange",
    read: (row: TransactionFacts) => row.details.currencyExchange ?? null,
  },
  sourceIssues: {
    name: "review.sourceIssues",
    read: (row: TransactionFacts) =>
      sortedEvidence([...new Set(row.details.issues)]),
  },
} as const;

export const transactionChangedFields = {
  ...transactionContentFields,
  ...(Object.fromEntries(
    Object.entries(transactionDetailContent).map(([key, field]) => [
      key,
      field.name,
    ]),
  ) as {
    [
      Key in keyof typeof transactionDetailContent
    ]: (typeof transactionDetailContent)[Key]["name"];
  }),
  providerEvidence: "evidence",
  presence: "presence",
  supersededById: "supersededById",
} as const;

/** A provider's declaration, rather than raw capture shape, defines retained source content. */
export function retainedTransactionEvidence(
  row: TransactionFacts,
  adapter: Pick<SourceAdapter, "provider" | "retainProviderEvidence">,
): JsonObject {
  const namespace = row.details.provider[adapter.provider] ?? {};
  return (
    adapter.retainProviderEvidence?.(namespace) ??
    Object.fromEntries(
      Object.entries(namespace).filter(
        ([key]) => !providerStateFields.some((state) => state === key),
      ),
    )
  );
}

export function transactionContent(
  row: TransactionFacts,
  adapter: Pick<SourceAdapter, "provider" | "retainProviderEvidence">,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.keys(transactionContentFields).map((key) => [
        key,
        row[key as keyof typeof transactionContentFields],
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(transactionDetailContent).map(([key, field]) => [
        key,
        field.read(row),
      ]),
    ),
    providerEvidence: retainedTransactionEvidence(row, adapter),
  };
}

/** Missing and null remain distinguishable; unchanged subtrees need no duplicate history. */
function evidenceChanges(
  before: unknown,
  after: unknown,
  path: string[] = [],
  afterPath: string[] = path,
): { before: unknown[]; after: unknown[] } {
  if (canonicalJson(before) === canonicalJson(after)) {
    return { before: [], after: [] };
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const remaining = after.map((value, index) => ({ value, index }));
    const removed = [];
    for (const [indexBefore, value] of before.entries()) {
      const index = remaining.findIndex(
        (candidate) => canonicalJson(candidate.value) === canonicalJson(value),
      );
      if (index < 0) {
        removed.push({ value, index: indexBefore });
      } else {
        remaining.splice(index, 1);
      }
    }
    // A single replacement can be described by leaf values without assuming row identity.
    if (removed.length === 1 && remaining.length === 1) {
      return evidenceChanges(
        removed[0]!.value,
        remaining[0]!.value,
        [...path, String(removed[0]!.index)],
        [...afterPath, String(remaining[0]!.index)],
      );
    }
    if (removed.length > 0 || remaining.length > 0) {
      return {
        before: removed.map(({ value, index }) => ({
          path: [...path, String(index)],
          present: true,
          value,
        })),
        after: remaining.map(({ value, index }) => ({
          path: [...afterPath, String(index)],
          present: true,
          value,
        })),
      };
    }
    // A declaration may preserve meaningful order even when membership is unchanged.
    return {
      before: [{ path, present: true, value: before }],
      after: [{ path: afterPath, present: true, value: after }],
    };
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    const result = { before: [] as unknown[], after: [] as unknown[] };
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      const change = evidenceChanges(
        Reflect.get(before, key),
        Reflect.get(after, key),
        [...path, key],
        [...afterPath, key],
      );
      result.before.push(...change.before);
      result.after.push(...change.after);
    }
    return result;
  }
  const entry = (value: unknown, entryPath: string[]) =>
    value === undefined
      ? { path: entryPath, present: false }
      : { path: entryPath, present: true, value };
  return { before: [entry(before, path)], after: [entry(after, afterPath)] };
}

export function changedTransactionContent(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const change = {
    before: {} as Record<string, unknown>,
    after: {} as Record<string, unknown>,
  };
  for (const key of Object.keys(after)) {
    if (canonicalJson(before[key]) === canonicalJson(after[key])) {
      continue;
    }
    if (key === "providerEvidence") {
      const evidence = evidenceChanges(before[key], after[key]);
      change.before[key] = evidence.before;
      change.after[key] = evidence.after;
    } else {
      change.before[key] = before[key];
      change.after[key] = after[key];
    }
  }
  return change;
}
