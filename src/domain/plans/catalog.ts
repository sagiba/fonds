import type { Account } from "../accounts.js";
import {
  type Card,
  type CardDiscovery,
  cardDiscoverySchema,
} from "../cards.js";
import {
  isBilledLine,
  parsedLedgerFacts,
  type TransactionFacts,
  type TransactionInput,
  unknownLedgerFacts,
} from "../model.js";
import { canonicalJson } from "../observations.js";
import type { Transaction } from "../records.js";
import type { FinancialPlan } from "./state.js";

/**
 * Replace an adapter's provider card key with the connection's service card ID.
 * A billed line's `purchaseKey` is resolved separately, against the plan's
 * current rows (`purchaseResolver`), so `purchaseId` starts unknown here.
 */
export function resolveTransaction(
  plan: FinancialPlan,
  input: TransactionInput,
  now: string,
  newId: () => string,
): TransactionFacts {
  const { cardKey, purchaseKey: _purchaseKey, ...facts } = input;
  return {
    ...facts,
    counterpartyName: input.counterpartyName ?? null,
    ...unknownLedgerFacts(
      cardKey === null
        ? null
        : plan.referenceCard(plan.snapshot.connection.id, cardKey, now, newId),
    ),
    // Parsed facts pass through; only references are resolved here.
    ...parsedLedgerFacts(input),
  };
}

/**
 * Resolves a purchase source key, within one collection scope, to the current
 * surviving purchase ID: a key retired by a pending/posted link follows
 * `supersededById`. The target must be a purchase commitment that is not
 * itself a billed line; anything else, or more than one survivor, is null.
 */
export function purchaseResolver(plan: FinancialPlan, rows: Transaction[]) {
  const idsByKey = new Map<string, Set<string>>();
  const add = (row: Transaction) => {
    for (const key of [row.sourceKey, ...row.sourceAliases]) {
      const ids = idsByKey.get(key) ?? new Set<string>();
      ids.add(row.id);
      idsByKey.set(key, ids);
    }
  };
  rows.forEach(add);
  return {
    add,
    resolve(sourceScope: string, purchaseKey: string): string | null {
      const survivors = new Set<string>();
      for (const id of idsByKey.get(purchaseKey) ?? []) {
        let row = plan.transaction(id);
        if (
          !row ||
          (row.sourceKey !== purchaseKey &&
            !row.sourceAliases.includes(purchaseKey))
        ) {
          continue;
        }
        const visited = new Set<string>();
        while (row?.supersededById && !visited.has(row.id)) {
          visited.add(row.id);
          row = plan.transaction(row.supersededById);
        }
        if (
          row &&
          !row.supersededById &&
          row.sourceScope === sourceScope &&
          row.amountBasis === "purchase_commitment" &&
          !isBilledLine(row)
        ) {
          survivors.add(row.id);
        }
      }
      return survivors.size === 1 ? survivors.values().next().value! : null;
    },
  };
}

/**
 * Positive observations only: omission never closes or deletes a card or
 * account, and an omitted billing account keeps the card's known one. Accounts
 * are created only here, from a card's billing account.
 */
export function planCardDiscovery(
  plan: FinancialPlan,
  input: CardDiscovery,
  now: string,
  newId: () => string,
): void {
  const discovery = cardDiscoverySchema.parse(input);
  const connectionId = plan.snapshot.connection.id;
  const observedAt = discovery.observedAt;
  const fresh = (lastSeenAt: string | null) =>
    !lastSeenAt || Date.parse(observedAt) > Date.parse(lastSeenAt);
  const accountIds = new Map<string, string>();
  for (const { billingAccount: observed } of discovery.cards) {
    if (!observed || accountIds.has(observed.providerKey)) {
      continue;
    }
    const retained = plan.accountByProviderKey(observed.providerKey);
    accountIds.set(observed.providerKey, retained?.id ?? newId());
    if (retained && !fresh(retained.lastSeenAt)) {
      continue;
    }
    const account: Account = {
      id: accountIds.get(observed.providerKey)!,
      connectionId,
      providerKey: observed.providerKey,
      type: retained?.type ?? "depository",
      institutionName:
        observed.institutionName ?? retained?.institutionName ?? null,
      mask: observed.mask ?? retained?.mask ?? null,
      displayName: retained?.displayName ?? null,
      createdAt: retained?.createdAt ?? now,
      lastSeenAt: observedAt,
    };
    if (!retained || canonicalJson(retained) !== canonicalJson(account)) {
      plan.setAccount(account);
    }
  }
  for (const observed of discovery.cards) {
    const retained = plan.cardByProviderKey(observed.cardKey);
    if (retained && !fresh(retained.lastSeenAt)) {
      continue;
    }
    const card: Card = {
      id: retained?.id ?? newId(),
      connectionId,
      providerKey: observed.cardKey,
      billingAccountId: observed.billingAccount
        ? accountIds.get(observed.billingAccount.providerKey)!
        : (retained?.billingAccountId ?? null),
      last4: observed.last4 ?? retained?.last4 ?? null,
      displayName: observed.displayName ?? retained?.displayName ?? null,
      attributes: observed.attributes ?? retained?.attributes ?? null,
      createdAt: retained?.createdAt ?? now,
      lastSeenAt: observedAt,
    };
    plan.setCard(card);
  }
}
