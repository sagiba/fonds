import { describe, expect, it } from "vitest";

import type { Account } from "../../src/domain/accounts.js";
import type { Card, CardDiscovery } from "../../src/domain/cards.js";
import { storedPaymentContext } from "../../src/domain/model.js";
import {
  planCardDiscovery,
  resolveTransaction,
} from "../../src/domain/plans/catalog.js";
import { FinancialPlan } from "../../src/domain/plans/state.js";
import { row } from "../helpers/storage-harness.js";

const card = { cardKey: "card", last4: "0012" };
const now = "2041-01-01T00:00:00Z";

interface Catalog {
  cards: Card[];
  accounts: Account[];
}

function catalogPlan(previous: Catalog) {
  return new FinancialPlan({
    connection: {
      id: "connection",
      provider: "synthetic",
      displayName: "Synthetic",
      config: { schemaVersion: 1 },
      createdAt: now,
    },
    rows: [],
    annotations: [],
    priorRuns: [],
    removals: [],
    catalog: previous,
  });
}

/** Discovery result as the stored catalog: previous rows overlaid by writes. */
function discover(
  previous: Catalog | Card[],
  discovery: CardDiscovery,
): Catalog & { writes: number } {
  const catalog = Array.isArray(previous)
    ? { cards: previous, accounts: [] }
    : previous;
  const plan = catalogPlan(catalog);
  // IDs continue after those already in the catalog, like random UUIDs never repeat.
  let next = catalog.cards.length + catalog.accounts.length;
  planCardDiscovery(plan, discovery, now, () => `id-${++next}`);
  const overlay = <Row extends { id: string }>(
    rows: Row[],
    writes: Map<string, Row>,
  ) => [
    ...rows.map((row) => writes.get(row.id) ?? row),
    ...[...writes.values()].filter(
      (write) => !rows.some((row) => row.id === write.id),
    ),
  ];
  return {
    cards: overlay(catalog.cards, plan.cardWrites),
    accounts: overlay(catalog.accounts, plan.accountWrites),
    writes: plan.cardWrites.size + plan.accountWrites.size,
  };
}

function mergeDiscovery(previous: Card[], discovery: CardDiscovery) {
  return discover(previous, discovery).cards;
}

const observedAt = "2040-01-01T00:00:00.000Z";

describe("retained card identity", () => {
  it("rejects duplicate card keys in one discovery batch", () => {
    expect(() =>
      mergeDiscovery([], {
        observedAt,
        cards: [card, { ...card, last4: "9999" }],
      }),
    ).toThrow("each card key once");
  });

  it.each(["", "card\0suffix", "x".repeat(1025)])(
    "rejects invalid card identity %j",
    (cardKey) => {
      expect(() =>
        mergeDiscovery([], { observedAt, cards: [{ ...card, cardKey }] }),
      ).toThrow();
    },
  );

  it("enriches a transaction-only placeholder without changing its ID or catalog creation time", () => {
    const createdAt = "2039-01-01T00:00:00Z";
    const placeholder: Card = {
      id: "service-card",
      connectionId: "connection",
      providerKey: "card",
      billingAccountId: null,
      last4: null,
      displayName: null,
      attributes: null,
      createdAt,
      lastSeenAt: null,
    };
    expect(
      mergeDiscovery([placeholder], { observedAt, cards: [card] }),
    ).toEqual([{ ...placeholder, last4: "0012", lastSeenAt: observedAt }]);
  });

  it("retains a known display name through missing or null discovery and replaces it only with newer evidence", () => {
    const original = mergeDiscovery([], {
      observedAt,
      cards: [{ ...card, displayName: "Synthetic Everyday" }],
    });
    for (const display of [{}, { displayName: null }]) {
      const refreshed = mergeDiscovery(original, {
        observedAt: "2040-02-01T00:00:00Z",
        cards: [{ ...card, ...display }],
      });
      expect(refreshed[0]?.displayName).toBe("Synthetic Everyday");
      expect(refreshed[0]?.lastSeenAt).toBe("2040-02-01T00:00:00Z");
    }
    const renamed = { ...card, displayName: "Synthetic Travel" };
    expect(
      mergeDiscovery(original, {
        observedAt: "2039-12-01T00:00:00Z",
        cards: [renamed],
      }),
    ).toEqual(original);
    expect(
      mergeDiscovery(original, {
        observedAt: "2040-02-01T00:00:00Z",
        cards: [renamed],
      })[0]?.displayName,
    ).toBe("Synthetic Travel");
    expect(original[0]?.displayName).toBe("Synthetic Everyday");
  });

  it.each([
    "",
    "   ",
    "x".repeat(129),
    "Synthetic\nCard",
    "Synthetic‮Card",
    "4111111111111111",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
  ])("rejects unsafe card display text %j", (displayName) => {
    expect(() =>
      mergeDiscovery([], { observedAt, cards: [{ ...card, displayName }] }),
    ).toThrow();
  });

  it("keeps leading zeros and duplicate suffixes under independent card identities", () => {
    const cards = mergeDiscovery([], {
      observedAt,
      cards: [card, { ...card, cardKey: "other" }],
    });
    expect(cards).toHaveLength(2);
    expect(cards.every((entry) => entry.last4 === "0012")).toBe(true);
    expect(cards[0]).toEqual({
      id: "id-1",
      connectionId: "connection",
      providerKey: "card",
      billingAccountId: null,
      last4: "0012",
      displayName: null,
      attributes: null,
      createdAt: now,
      lastSeenAt: observedAt,
    });
    expect(cards[1]?.id).toBe("id-2");
  });

  it("retains omitted cards and known digits when a fresh discovery has unknown digits", () => {
    const original = mergeDiscovery([], { observedAt, cards: [card] });
    expect(
      mergeDiscovery(original, {
        observedAt: "2040-02-01T00:00:00Z",
        cards: [],
      }),
    ).toEqual(original);
    const updated = mergeDiscovery(original, {
      observedAt: "2040-02-01T00:00:00Z",
      cards: [{ ...card, last4: null }],
    });
    expect(updated[0]).toEqual({
      ...original[0],
      lastSeenAt: "2040-02-01T00:00:00Z",
    });
    expect(
      mergeDiscovery(updated, {
        observedAt: "2040-03-01T00:00:00Z",
        cards: [{ ...card, last4: "9999" }],
      })[0]?.last4,
    ).toBe("9999");
  });

  it("does not overwrite newer or equal-time evidence", () => {
    const original = mergeDiscovery([], { observedAt, cards: [card] });
    for (const stale of ["2039-12-31T00:00:00Z", "2040-01-01T00:00:00Z"]) {
      const result = discover(original, {
        observedAt: stale,
        cards: [{ ...card, last4: "9999" }],
      });
      expect(result.cards).toEqual(original);
      expect(result.writes).toBe(0);
    }
  });

  it("rejects non-allowlisted metadata and malformed suffixes", () => {
    for (const last4 of ["123", "12345", "1234\n", "１２３４", "****1234"]) {
      expect(() =>
        mergeDiscovery([], { observedAt, cards: [{ ...card, last4 }] }),
      ).toThrow();
    }
    const unsafe = { ...card, token: "SYNTHETIC-SECRET" };
    expect(() => mergeDiscovery([], { observedAt, cards: [unsafe] })).toThrow();
  });

  it("keeps private allowlisted attributes and retains them when omitted", () => {
    const attributes = { cardStatus: "active", isVirtualCard: false };
    const original = mergeDiscovery([], {
      observedAt,
      cards: [{ ...card, attributes }],
    });
    expect(original[0]?.attributes).toEqual(attributes);
    expect(
      mergeDiscovery(original, {
        observedAt: "2040-02-01T00:00:00Z",
        cards: [card],
      })[0]?.attributes,
    ).toEqual(attributes);
    expect(() =>
      mergeDiscovery([], {
        observedAt,
        cards: [{ ...card, attributes: { nested: { value: 1 } } as never }],
      }),
    ).toThrow();
  });
});

describe("billing accounts from discovery", () => {
  const billingAccount = { providerKey: "bank-account", mask: "0042" };

  it("creates one depository account shared by the cards it bills", () => {
    const result = discover([], {
      observedAt,
      cards: [
        { ...card, billingAccount },
        { cardKey: "other", last4: "3456", billingAccount },
      ],
    });
    expect(result.accounts).toEqual([
      {
        id: "id-1",
        connectionId: "connection",
        providerKey: "bank-account",
        type: "depository",
        institutionName: null,
        mask: "0042",
        displayName: null,
        createdAt: now,
        lastSeenAt: observedAt,
      },
    ]);
    expect(result.cards.map((entry) => entry.billingAccountId)).toEqual([
      "id-1",
      "id-1",
    ]);
  });

  it("keeps account and card IDs stable and retains known metadata", () => {
    const first = discover([], {
      observedAt,
      cards: [{ ...card, billingAccount }],
    });
    const later = discover(first, {
      observedAt: "2040-02-01T00:00:00Z",
      cards: [{ ...card, billingAccount: { providerKey: "bank-account" } }],
    });
    expect(later.accounts).toEqual([
      { ...first.accounts[0], lastSeenAt: "2040-02-01T00:00:00Z" },
    ]);
    expect(later.cards[0]?.id).toBe(first.cards[0]?.id);
    expect(later.cards[0]?.billingAccountId).toBe(first.accounts[0]?.id);
  });

  it("keeps a card's billing account when a discovery omits it, and follows a new one", () => {
    const first = discover([], {
      observedAt,
      cards: [{ ...card, billingAccount }],
    });
    const omitted = discover(first, {
      observedAt: "2040-02-01T00:00:00Z",
      cards: [card],
    });
    expect(omitted.cards[0]?.billingAccountId).toBe(first.accounts[0]?.id);
    const moved = discover(omitted, {
      observedAt: "2040-03-01T00:00:00Z",
      cards: [{ ...card, billingAccount: { providerKey: "second-account" } }],
    });
    expect(moved.accounts).toHaveLength(2);
    expect(moved.cards[0]?.billingAccountId).toBe(moved.accounts[1]?.id);
  });

  it("never creates accounts from cards without billing evidence", () => {
    expect(discover([], { observedAt, cards: [card] }).accounts).toEqual([]);
  });

  it("rejects conflicting metadata for one billing account and unsafe masks", () => {
    expect(() =>
      discover([], {
        observedAt,
        cards: [
          { ...card, billingAccount },
          {
            cardKey: "other",
            last4: null,
            billingAccount: { ...billingAccount, mask: "9999" },
          },
        ],
      }),
    ).toThrow("agree on its metadata");
    for (const mask of ["123", "12345", "00-1", "１２３４"]) {
      expect(() =>
        discover([], {
          observedAt,
          cards: [
            { ...card, billingAccount: { providerKey: "account", mask } },
          ],
        }),
      ).toThrow();
    }
  });
});

describe("transaction card references", () => {
  it("resolves known provider keys and mints one placeholder per unknown card, written only when referenced", () => {
    const known = mergeDiscovery([], { observedAt, cards: [card] });
    const plan = catalogPlan({ cards: known, accounts: [] });
    let next = 0;
    const newId = () => `minted-${++next}`;
    const resolved = resolveTransaction(plan, row("one"), now, newId);
    expect(resolved.cardId).toBe(known[0]!.id);
    expect(resolved).not.toHaveProperty("cardKey");
    const first = resolveTransaction(
      plan,
      row("two", { cardKey: "new-card" }),
      now,
      newId,
    );
    const second = resolveTransaction(
      plan,
      row("three", { cardKey: "new-card" }),
      now,
      newId,
    );
    expect(first.cardId).toBe("minted-1");
    expect(second.cardId).toBe("minted-1");
    expect(
      resolveTransaction(plan, row("four", { cardKey: null }), now, newId),
    ).toMatchObject({ cardId: null });
    expect(plan.cardWrites.size).toBe(0);
    plan.insertTransaction({
      ...first,
      ...storedPaymentContext(first, undefined),
      id: "transaction",
      connectionId: "connection",
      presence: "seen",
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenRunId: "run",
      version: 1,
      supersededById: null,
    });
    expect([...plan.cardWrites.values()]).toEqual([
      {
        id: "minted-1",
        connectionId: "connection",
        providerKey: "new-card",
        billingAccountId: null,
        last4: null,
        displayName: null,
        attributes: null,
        createdAt: now,
        lastSeenAt: null,
      },
    ]);
  });

  it("requires the catalog before resolving provider keys", () => {
    const { catalog: _catalog, ...snapshot } = catalogPlan({
      cards: [],
      accounts: [],
    }).snapshot;
    const plan = new FinancialPlan(snapshot);
    expect(() => resolveTransaction(plan, row("one"), now, () => "id")).toThrow(
      "card catalog",
    );
  });
});
