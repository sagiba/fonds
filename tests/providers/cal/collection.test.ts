import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { collectFromStore } from "../../../src/application/collection.js";
import { presentCard } from "../../../src/application/wire-output.js";
import type { CollectionEvent } from "../../../src/domain/source-adapter.js";
import { calAdapter } from "../../../src/providers/cal/adapter.js";
import {
  calHistoryMonths,
  calHistoryWindows,
  calPaddedSearchWindow,
  type CalSearchFilters,
  collectCal,
  type CollectCalOptions,
} from "../../../src/providers/cal/collect.js";
import {
  CAL_EMPTY_SEARCH_DESCRIPTION,
  normalizeCalSearchFilters,
} from "../../../src/providers/cal/search.js";
import {
  CAL_ENDPOINTS,
  CAL_WEB_HEADERS,
  createCalTransport,
} from "../../../src/providers/cal/transport.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";
import { syncRuns } from "../../../src/storage/sqlite/schema.js";

// Invented credentials and identifiers. No private source or live CAL requests.
const credentials = {
  username: "SYNTHETIC-USER-SECRET",
  password: "SYNTHETIC-PASSWORD-SECRET",
};
const token = "SYNTHETIC-AUTH-TOKEN-SECRET";
const accountId = "SYNTHETIC-ACCOUNT-A";
const cardId = "SYNTHETIC-CARD-A";
const envelope = (result: unknown) => ({
  statusCode: 1,
  result,
  groupPid: "SYNTHETIC-GROUP",
});
const recent = () =>
  envelope({
    daysRange: 90,
    transactions: [],
    clearanceRequests: [],
    sourceUnknown: { preserved: true },
  });
const monthly = () =>
  envelope({
    bankAccounts: [
      {
        debitDates: [{ transactions: [] }],
        immidiateDebits: { debitDays: [] },
      },
    ],
    blockedCardInd: false,
  });
const response = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

function syntheticFetch(
  financial?: (
    endpoint: string,
    body: Record<string, string>,
  ) => Response | Promise<Response>,
  accounts = [accountId],
  cards: Array<{
    cardUniqueId: string;
    bankAccountUniqueId: string;
    [key: string]: unknown;
  }> = [{ cardUniqueId: cardId, bankAccountUniqueId: accountId }],
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const endpoint = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    if (endpoint === CAL_ENDPOINTS.login) {
      return response({ token });
    }
    if (endpoint === CAL_ENDPOINTS.init) {
      return response(
        envelope({
          bankAccounts: accounts.map((id) => ({ bankAccountUniqueId: id })),
          cards,
        }),
      );
    }
    return financial
      ? financial(endpoint, body)
      : response(
          endpoint === CAL_ENDPOINTS.recent
            ? recent()
            : endpoint === CAL_ENDPOINTS.search
              ? envelope({ transArr: [] })
              : monthly(),
        );
  });
}

async function collect(
  options: Partial<CollectCalOptions> = {},
): Promise<CollectionEvent[]> {
  return collectFinancialEvents(
    collectCal({ credentials, fetch: syntheticFetch(), ...options }),
  );
}

async function collectFinancialEvents(
  iterable: AsyncIterable<CollectionEvent>,
): Promise<CollectionEvent[]> {
  const events: CollectionEvent[] = [];
  for await (const event of iterable) {
    // Callers assert the ordering of financial capture and failure events.
    if (event.type !== "card_discovery") {
      events.push(event);
    }
  }
  return events;
}

/** Mock responses describe nominal windows; requests deliberately contain one-day padding. */
function nominalSearchRange(
  body: Record<string, string>,
): { from: string; to: string } | undefined {
  if (!body.fromTransDate || !body.toTransDate) {
    return undefined;
  }
  const shift = (date: string, days: number) => {
    const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  return {
    from: shift(body.fromTransDate, 1),
    to: shift(body.toTransDate, -1),
  };
}

describe("CAL calendar history plan", () => {
  it("covers full years without a recent-history cutoff and uses documented unpadded month strings", () => {
    const months = [
      ...calHistoryMonths({ from: "2019-01-31", to: "2026-10-13" }),
    ];
    expect(months).toHaveLength(94);
    expect(months[0]).toEqual({ month: "1", year: "2019", key: "2019-01" });
    expect(months.at(-1)).toEqual({
      month: "10",
      year: "2026",
      key: "2026-10",
    });
    expect(new Set(months.map((month) => month.key)).size).toBe(94);
  });

  it("handles leap day, inclusive boundary months and December rollover", () => {
    expect(
      [...calHistoryMonths({ from: "2023-12-31", to: "2024-03-01" })].map(
        (month) => month.key,
      ),
    ).toEqual(["2023-12", "2024-01", "2024-02", "2024-03"]);
    expect([
      ...calHistoryMonths({ from: "2024-02-29", to: "2024-02-29" }),
    ]).toHaveLength(1);
    for (const range of [
      { from: "2023-02-29", to: "2023-03-01" },
      { from: "2024-04-31", to: "2024-05-01" },
      { from: "2024-01-02", to: "2024-01-01" },
    ]) {
      expect(() => [...calHistoryMonths(range)]).toThrow("invalid_response");
    }
  });
});

describe("CAL synthetic direct collection", () => {
  it("projects the evidenced card description and allowlisted card facts from the synthetic discovery shape without personal metadata", async () => {
    const source = JSON.parse(
      readFileSync(
        new URL("./fixtures/card-discovery.json", import.meta.url),
        "utf8",
      ),
    );
    const raw = source.result.cards[0];
    const fetcher = syntheticFetch(
      undefined,
      [raw.bankAccountUniqueId],
      [
        {
          ...raw,
          holderName: "SYNTHETIC-PRIVATE-HOLDER",
          cardNumber: "4111111111111111",
          token,
        },
      ],
    );
    const generator = collectCal({ credentials, fetch: fetcher });
    const event = (await generator.next()).value;
    expect(event).toEqual({
      type: "card_discovery",
      discovery: {
        observedAt: expect.any(String),
        cards: [
          {
            cardKey: raw.cardUniqueId,
            last4: "0012",
            displayName: "כרטיס דוגמה סינתטי",
            billingAccount: { providerKey: raw.bankAccountUniqueId },
            // Exactly the allowlist; never the cardOwner* fields or limits.
            attributes: {
              cardStatus: 0,
              statusForDisplay: "Synthetic active status",
              isDebitCard: false,
              isVirtualCard: false,
              isDigitalCard: true,
              isTemporaryCard: false,
              cardType: "Synthetic product type",
              cardTypeCode: 7,
              companyDescription: "Synthetic card company",
              issuerName: "Synthetic issuer",
              currentDebitDay: 10,
              isCreditLimited: true,
            },
          },
        ],
      },
    });
    expect(
      Object.keys(raw).filter((key) => key.startsWith("cardOwner")),
    ).toHaveLength(7);
    expect(JSON.stringify(event)).not.toMatch(
      /PRIVATE|cardOwner|example\.invalid|creditLimit|99999|4111/,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    await generator.return(undefined);
  });

  it.each([
    undefined,
    null,
    "",
    "x".repeat(129),
    "Synthetic\nCard",
    "4111 1111 1111 1111",
    credentials.password,
    token,
  ])(
    "omits invalid or secret-bearing card description %j",
    async (cardDescription) => {
      const generator = collectCal({
        credentials,
        fetch: syntheticFetch(
          undefined,
          [accountId],
          [
            {
              cardUniqueId: cardId,
              bankAccountUniqueId: accountId,
              last4Digits: "0012",
              cardDescription,
            },
          ],
        ),
      });
      const event = (await generator.next()).value;
      expect(event).toMatchObject({
        type: "card_discovery",
        discovery: { cards: [{ last4: "0012" }] },
      });
      expect(JSON.stringify(event)).not.toContain('"displayName"');
      await generator.return(undefined);
    },
  );

  it("marks conflicting duplicate card descriptions unknown without replacing the previously retained name", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await db.recordCardDiscovery("synthetic", {
        observedAt: "2000-01-01T00:00:00Z",
        cards: [
          { cardKey: cardId, last4: "0012", displayName: "Synthetic Earlier" },
        ],
      });
      const fetcher = syntheticFetch(
        undefined,
        [accountId],
        ["Synthetic Everyday", "Synthetic Travel"].map((cardDescription) => ({
          cardUniqueId: cardId,
          bankAccountUniqueId: accountId,
          last4Digits: "0012",
          cardDescription,
        })),
      );
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          collect: () => collectCal({ credentials, fetch: fetcher }),
        },
        calAdapter,
      );
      expect(
        (await db.listCards({ connectionId: "synthetic" })).cards[0]
          ?.displayName,
      ).toBe("Synthetic Earlier");
    } finally {
      await db.close();
    }
  });

  it("does not persist a last-four value reflecting a four-character credential", async () => {
    const generator = collectCal({
      credentials: { ...credentials, password: "0012" },
      fetch: syntheticFetch(
        undefined,
        [accountId],
        [
          {
            cardUniqueId: cardId,
            bankAccountUniqueId: accountId,
            last4Digits: "0012",
          },
        ],
      ),
    });
    expect((await generator.next()).value).toMatchObject({
      type: "card_discovery",
      discovery: { cards: [{ last4: null }] },
    });
    await generator.return(undefined);
  });

  it("stops before financial requests when discovered metadata cannot be persisted", async () => {
    const db = await openDatabase(":memory:");
    const fetcher = syntheticFetch();
    try {
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await expect(
        collectFromStore(
          {
            ...db,
            async recordCardDiscovery() {
              throw new Error("synthetic persistence failure");
            },
          },
          { connectionId: "synthetic" },
          {
            provider: "cal",
            collectorVersion: "synthetic-v1",
            collect: () => collectCal({ credentials, fetch: fetcher }),
          },
          calAdapter,
        ),
      ).rejects.toThrow("synthetic persistence failure");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect((await db.listCards({ connectionId: "synthetic" })).cards).toEqual(
        [],
      );
    } finally {
      await db.close();
    }
  });

  it("emits only allowlisted discovery before financial requests, preserving duplicate last-four strings", async () => {
    const cards = [
      {
        cardUniqueId: cardId,
        bankAccountUniqueId: accountId,
        last4Digits: "0012",
        token,
        cardNumber: "SYNTHETIC-PRIVATE-PAN",
        cardName: "SYNTHETIC-PRIVATE-NAME",
      },
      {
        cardUniqueId: "other",
        bankAccountUniqueId: accountId,
        last4Digits: "0012",
      },
    ];
    const fetcher = syntheticFetch(undefined, [accountId], cards);
    const generator = collectCal({ credentials, fetch: fetcher });
    const first = await generator.next();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.value).toEqual({
      type: "card_discovery",
      discovery: {
        observedAt: expect.any(String),
        cards: [
          {
            cardKey: cardId,
            last4: "0012",
            billingAccount: { providerKey: accountId },
          },
          {
            cardKey: "other",
            last4: "0012",
            billingAccount: { providerKey: accountId },
          },
        ],
      },
    });
    expect(JSON.stringify(first.value)).not.toContain("PRIVATE");
    expect(JSON.stringify(first.value)).not.toContain(token);
    await generator.return(undefined);
  });

  it("stores allowlisted init card facts privately and drops secret-bearing, oversized or conflicting values", async () => {
    const db = await openDatabase(":memory:");
    const fetcher = syntheticFetch(
      undefined,
      [accountId],
      [
        {
          cardUniqueId: cardId,
          bankAccountUniqueId: accountId,
          last4Digits: "0012",
          cardStatus: 0,
          issuerName: `Synthetic ${token}`,
          companyDescription: "x".repeat(257),
          isDebitCard: false,
          cardOwnerFullName: "SYNTHETIC-PRIVATE-FULL",
        },
        {
          cardUniqueId: "SYNTHETIC-CARD-DUPLICATE",
          bankAccountUniqueId: accountId,
          cardStatus: 0,
        },
        {
          cardUniqueId: "SYNTHETIC-CARD-DUPLICATE",
          bankAccountUniqueId: accountId,
          cardStatus: 1,
        },
      ],
    );
    try {
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          collect: () => collectCal({ credentials, fetch: fetcher }),
        },
        calAdapter,
      );
      const cards = (await db.listCards({ connectionId: "synthetic" })).cards;
      const card = (providerKey: string) =>
        cards.find((entry) => entry.providerKey === providerKey)!;
      expect(card(cardId).attributes).toEqual({
        cardStatus: 0,
        isDebitCard: false,
      });
      expect(card("SYNTHETIC-CARD-DUPLICATE").attributes).toBeNull();
      expect(JSON.stringify(cards)).not.toMatch(/PRIVATE|cardOwner/);
      expect(JSON.stringify(cards)).not.toContain(token);
      // Attributes are private: the public card omits them.
      expect(presentCard(card(cardId))).not.toHaveProperty("attributes");
    } finally {
      await db.close();
    }
  });

  it("resolves cards to the billing accounts CAL init names, sharing one account between its cards", async () => {
    const db = await openDatabase(":memory:");
    const otherAccount = "SYNTHETIC-ACCOUNT-B";
    const fixtureText = readFileSync(
      new URL("./fixtures/recent-01.json", import.meta.url),
      "utf8",
    );
    const fetcher = syntheticFetch(
      (endpoint, body) =>
        response(
          endpoint === CAL_ENDPOINTS.recent &&
            body.bankAccountUniqueID === accountId
            ? JSON.parse(fixtureText)
            : recent(),
        ),
      [accountId, otherAccount],
      [
        { cardUniqueId: cardId, bankAccountUniqueId: accountId },
        { cardUniqueId: "SYNTHETIC-CARD-A2", bankAccountUniqueId: accountId },
        { cardUniqueId: "SYNTHETIC-CARD-B", bankAccountUniqueId: otherAccount },
      ],
    );
    try {
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          collect: () => collectCal({ credentials, fetch: fetcher }),
        },
        calAdapter,
      );
      const accounts = (await db.listAccounts({ connectionId: "synthetic" }))
        .accounts;
      expect(accounts.map((account) => account.providerKey).sort()).toEqual([
        accountId,
        otherAccount,
      ]);
      const accountOf = (providerKey: string) =>
        accounts.find((account) => account.providerKey === providerKey)!.id;
      const cards = (await db.listCards({ connectionId: "synthetic" })).cards;
      const card = (providerKey: string) =>
        cards.find((entry) => entry.providerKey === providerKey)!;
      expect(card(cardId).billingAccountId).toBe(accountOf(accountId));
      expect(card("SYNTHETIC-CARD-A2").billingAccountId).toBe(
        accountOf(accountId),
      );
      expect(card("SYNTHETIC-CARD-B").billingAccountId).toBe(
        accountOf(otherAccount),
      );
      const billed = await db.listTransactions({
        connectionId: "synthetic",
        billingAccountId: accountOf(accountId),
      });
      expect(billed.length).toBeGreaterThan(0);
      expect(billed.every((row) => row.cardId === card(cardId).id)).toBe(true);
      // The private collection scope stays the source account; it is not public.
      expect(billed.every((row) => row.sourceScope === accountId)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("skips a NUL-containing discovery key while retaining valid cards and continuing collection", async () => {
    const db = await openDatabase(":memory:");
    const fetcher = syntheticFetch(
      undefined,
      [accountId],
      [
        {
          cardUniqueId: cardId,
          bankAccountUniqueId: accountId,
          last4Digits: "0012",
        },
        {
          cardUniqueId: "synthetic\0invalid-card",
          bankAccountUniqueId: accountId,
          last4Digits: "3456",
          holderName: credentials.username,
          token,
        },
      ],
    );
    try {
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        {
          provider: "cal",
          collectorVersion: "synthetic-v1",
          collect: () => collectCal({ credentials, fetch: fetcher }),
        },
        calAdapter,
      );
      const page = await db.listCards({ connectionId: "synthetic" });
      const [account] = (await db.listAccounts({ connectionId: "synthetic" }))
        .accounts;
      expect(page.cards).toEqual([
        {
          id: expect.any(String),
          connectionId: "synthetic",
          providerKey: cardId,
          billingAccountId: account!.id,
          last4: "0012",
          displayName: null,
          attributes: null,
          createdAt: expect.any(String),
          lastSeenAt: expect.any(String),
        },
      ]);
      // CAL accounts are known only by their opaque ID: no name or mask.
      expect(account).toMatchObject({
        providerKey: accountId,
        type: "depository",
        institutionName: null,
        mask: null,
        displayName: null,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(await db.listSyncRuns("synthetic", { limit: 10 })).toHaveLength(1);
      expect(JSON.stringify(page)).not.toContain("invalid-card");
      for (const secret of [
        credentials.username,
        credentials.password,
        token,
      ]) {
        expect(JSON.stringify(page)).not.toContain(secret);
      }
    } finally {
      await db.close();
    }
  });

  it.each([
    ["NUL-containing", "SYNTHETIC\0ACCOUNT"],
    ["blank", "  "],
    ["secret-reflecting", token],
  ])(
    "rejects a %s billing account key before financial requests",
    async (_label, invalidAccount) => {
      const fetcher = syntheticFetch(
        undefined,
        [accountId, invalidAccount],
        [
          { cardUniqueId: cardId, bankAccountUniqueId: accountId },
          {
            cardUniqueId: "SYNTHETIC-CARD-B",
            bankAccountUniqueId: invalidAccount,
          },
        ],
      );
      expect(await collect({ fetch: fetcher })).toEqual([
        expect.objectContaining({
          type: "failure",
          failure: expect.objectContaining({
            code: "invalid_response",
            endpoint: CAL_ENDPOINTS.init,
          }),
          fatal: true,
        }),
      ]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("leaves invalid, missing, numeric and wallet-token digits unknown and excludes ambiguous owners", async () => {
    const invalidDigits = [
      undefined,
      null,
      12,
      1234,
      "123",
      "12345",
      "1234\n",
      "１２３４",
      token,
    ];
    const otherAccount = "other-account";
    const cards = invalidDigits.map((last4Digits, index) => ({
      cardUniqueId: `card-${index}`,
      bankAccountUniqueId: accountId,
      last4Digits,
      tokenNumberPart4: "9999",
    }));
    const fetcher = syntheticFetch(
      undefined,
      [accountId, otherAccount],
      [
        ...cards,
        {
          cardUniqueId: "conflict",
          bankAccountUniqueId: accountId,
          last4Digits: "0012",
        },
        {
          cardUniqueId: "conflict",
          bankAccountUniqueId: otherAccount,
          last4Digits: "0012",
        },
        {
          cardUniqueId: "digits-conflict",
          bankAccountUniqueId: accountId,
          last4Digits: "0012",
        },
        {
          cardUniqueId: "digits-conflict",
          bankAccountUniqueId: accountId,
          last4Digits: "3456",
        },
      ],
    );
    const generator = collectCal({ credentials, fetch: fetcher });
    const first: CollectionEvent | undefined = (await generator.next()).value;
    expect(first?.type).toBe("card_discovery");
    if (first?.type === "card_discovery") {
      expect(first.discovery.cards).toHaveLength(invalidDigits.length + 1);
      expect(first.discovery.cards.every((card) => card.last4 === null)).toBe(
        true,
      );
      expect(
        first.discovery.cards.some((card) => card.cardKey === "conflict"),
      ).toBe(false);
    }
    await generator.return(undefined);
  });

  it("incremental collection rereads the whole recent overlap without a saved cursor or date watermark", async () => {
    const previous = envelope({
      daysRange: 90,
      transactions: [
        {
          cardUniqueId: cardId,
          trnIntId: "SYNTHETIC-OVERLAP-PURCHASE",
          merchantName: "Synthetic overlapping purchase",
          amountForDisplay: 12.25,
        },
      ],
      clearanceRequests: [],
    });
    const corrected = envelope({
      ...(previous.result as Record<string, unknown>),
      transactions: [
        {
          cardUniqueId: cardId,
          trnIntId: "SYNTHETIC-OVERLAP-PURCHASE",
          merchantName: "Synthetic overlapping purchase",
          amountForDisplay: 10.25,
        },
      ],
    });
    let reads = 0;
    const fetcher = syntheticFetch(() =>
      response(reads++ === 0 ? previous : corrected),
    );
    const first = await collect({ fetch: fetcher });
    const second = await collect({ fetch: fetcher });
    expect(first[0]).toMatchObject({
      type: "capture",
      capture: {
        responseText: JSON.stringify(previous),
        scope: { kind: "recent" },
      },
    });
    expect(second[0]).toMatchObject({
      type: "capture",
      capture: {
        responseText: JSON.stringify(corrected),
        scope: { kind: "recent" },
      },
    });
    const recentCalls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.recent,
    );
    expect(recentCalls).toHaveLength(2);
    for (const [, init] of recentCalls) {
      expect(JSON.parse(String(init?.body))).toEqual({
        bankAccountUniqueID: accountId,
      });
    }
    expect(
      fetcher.mock.calls.filter(
        ([endpoint]) => endpoint === CAL_ENDPOINTS.login,
      ),
    ).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(
        ([endpoint]) =>
          endpoint === CAL_ENDPOINTS.search ||
          endpoint === CAL_ENDPOINTS.monthly,
      ),
    ).toEqual([]);
  });

  it("uses exact successful headers, fresh-token web auth and uppercase-D recent account key", async () => {
    const fetcher = syntheticFetch();
    const events = await collect({ fetch: fetcher });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "capture",
      capture: {
        accountKey: accountId,
        endpoint: CAL_ENDPOINTS.recent,
        scope: { kind: "recent" },
      },
    });
    const first = events[0]!;
    expect(
      JSON.parse(
        first.type === "capture" ? first.capture.responseText : "null",
      ),
    ).toEqual(recent());
    expect(fetcher).toHaveBeenCalledTimes(3);
    const calls = fetcher.mock.calls;
    expect(calls[0]).toMatchObject([
      CAL_ENDPOINTS.login,
      { headers: CAL_WEB_HEADERS, redirect: "manual", method: "POST" },
    ]);
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({
      ...credentials,
      recaptcha: "",
    });
    expect(calls[1]![1]?.headers).toEqual({
      ...CAL_WEB_HEADERS,
      Authorization: `CALAuthScheme ${token}`,
    });
    expect(JSON.parse(String(calls[1]![1]?.body))).toEqual({ tokenGuid: "" });
    expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({
      bankAccountUniqueID: accountId,
    });
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain(credentials.password);
  });

  it("streams recent once per account then every requested month per card, retaining boundary month rows", async () => {
    const secondAccount = "SYNTHETIC-ACCOUNT-B";
    const fetcher = syntheticFetch(
      undefined,
      [accountId, secondAccount],
      [
        { cardUniqueId: cardId, bankAccountUniqueId: accountId },
        {
          cardUniqueId: "SYNTHETIC-CARD-B",
          bankAccountUniqueId: secondAccount,
        },
      ],
    );
    const generator = collectCal({
      credentials,
      fetch: fetcher,
      range: { from: "2019-01-31", to: "2026-10-13" },
      historyMode: "monthly",
    });
    expect((await generator.next()).value).toMatchObject({
      type: "card_discovery",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = await generator.next();
    expect(first.value).toMatchObject({
      type: "capture",
      capture: { accountKey: accountId },
    });
    expect(fetcher).toHaveBeenCalledTimes(3); // No history prefetched while archive sink consumes.
    const remaining = await collectFinancialEvents(generator);
    expect(remaining.filter((event) => event.type === "capture")).toHaveLength(
      189,
    );
    const historical = remaining.filter(
      (event) =>
        event.type === "capture" && event.capture.scope?.kind === "history",
    );
    expect(historical).toHaveLength(188);
    expect(historical[0]).toMatchObject({
      capture: {
        scope: {
          month: "2019-01",
          cardKey: cardId,
          from: "2019-01-31",
          to: "2026-10-13",
        },
      },
    });
    const monthlyCalls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.monthly,
    );
    expect(JSON.parse(String(monthlyCalls[0]![1]?.body))).toEqual({
      cardUniqueId: cardId,
      month: "1",
      year: "2019",
    });
    expect(JSON.parse(String(monthlyCalls.at(-1)![1]?.body))).toEqual({
      cardUniqueId: "SYNTHETIC-CARD-B",
      month: "10",
      year: "2026",
    });
  });

  it("continues after bounded monthly failure and does not lose already yielded units", async () => {
    const fetcher = syntheticFetch((endpoint, body) => {
      if (endpoint === CAL_ENDPOINTS.monthly && body.month === "2") {
        return response({ error: credentials.password }, 503);
      }
      return response(endpoint === CAL_ENDPOINTS.recent ? recent() : monthly());
    });
    const events = await collect({
      fetch: fetcher,
      range: { from: "2024-01-01", to: "2024-03-31" },
      historyMode: "monthly",
      limits: { retryDelayMs: 1 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "failure",
      "capture",
    ]);
    expect(events[2]).toMatchObject({
      failure: { code: "network_error", scope: { month: "2024-02" } },
      fatal: false,
    });
    expect(
      fetcher.mock.calls.filter(
        ([endpoint, init]) =>
          endpoint === CAL_ENDPOINTS.monthly &&
          JSON.parse(String(init?.body)).month === "2",
      ),
    ).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(credentials.password);
  });

  it("stops after three consecutively failed financial windows and preserves earlier captures", async () => {
    const fetcher = syntheticFetch((endpoint, body) =>
      response(
        endpoint === CAL_ENDPOINTS.recent
          ? recent()
          : nominalSearchRange(body)?.from.startsWith("2040-01")
            ? envelope({ transArr: [] })
            : { syntheticFailure: true },
        endpoint === CAL_ENDPOINTS.recent ||
          nominalSearchRange(body)?.from.startsWith("2040-01")
          ? 200
          : 503,
      ),
    );
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-01-01", to: "2040-06-30" },
      limits: { retryDelayMs: 1 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "failure",
      "failure",
      "failure",
    ]);
    const failures = events.filter((event) => event.type === "failure");
    expect(failures.map((event) => event.fatal)).toEqual([false, false, true]);
    expect(failures.map((event) => event.failure.scope?.windowFrom)).toEqual([
      "2040-02-01",
      "2040-03-01",
      "2040-04-01",
    ]);
    expect(
      failures.every((event) => event.failure.code === "network_error"),
    ).toBe(true);
    const historyCalls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(historyCalls).toHaveLength(10); // One successful window plus three windows of three attempts.
    expect(
      historyCalls.some(([, init]) =>
        nominalSearchRange(JSON.parse(String(init?.body)))?.from.startsWith(
          "2040-05",
        ),
      ),
    ).toBe(false);
  });

  it.each([
    ["unrecognized JSON", envelope({ unexpectedShape: [] }), true],
    ["unsupported pagination", envelope({ transArr: [], hasMore: true }), true],
    ["transport-rejected JSON shape", null, false],
  ])(
    "stops after three invalid financial windows: %s",
    async (_, raw, captured) => {
      const fetcher = syntheticFetch((endpoint) =>
        response(endpoint === CAL_ENDPOINTS.recent ? recent() : raw),
      );
      const events = await collect({
        fetch: fetcher,
        range: { from: "2040-01-01", to: "2040-08-31" },
      });
      const failures = events.filter((event) => event.type === "failure");
      expect(failures.map((event) => event.fatal)).toEqual([
        false,
        false,
        true,
      ]);
      expect(failures.map((event) => event.failure.scope?.windowFrom)).toEqual([
        "2040-01-01",
        "2040-02-01",
        "2040-03-01",
      ]);
      expect(
        failures.every((event) => event.failure.code === "invalid_response"),
      ).toBe(true);
      const captures = events.filter((event) => event.type === "capture");
      expect(captures).toHaveLength(captured ? 4 : 1);
      if (captured) {
        expect(
          captures.slice(1).map((event) => event.capture.responseText),
        ).toEqual(Array(3).fill(JSON.stringify(raw)));
      }
      expect(
        fetcher.mock.calls.filter(
          ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
        ),
      ).toHaveLength(3);
    },
  );

  it.each(["network_error", "invalid_response"] as const)(
    "stops mixed failures when the third %s arrives, within five failed windows",
    async (firstCode) => {
      let windows = 0;
      const fetcher = syntheticFetch((endpoint) => {
        if (endpoint === CAL_ENDPOINTS.recent) {
          return response(recent());
        }
        const code =
          windows++ % 2 === 0
            ? firstCode
            : firstCode === "network_error"
              ? "invalid_response"
              : "network_error";
        return response(
          { syntheticFailure: true },
          code === "network_error" ? 503 : 200,
        );
      });
      const events = await collect({
        fetch: fetcher,
        range: { from: "2040-01-01", to: "2040-08-31" },
        limits: { maxAttempts: 1 },
      });
      const failures = events.filter((event) => event.type === "failure");
      expect(windows).toBe(5);
      expect(failures.map((event) => event.fatal)).toEqual([
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(failures.at(-1)).toMatchObject({
        failure: { code: firstCode, scope: { windowFrom: "2040-05-01" } },
      });
    },
  );

  it.each([
    ["recognized empty search", envelope({ transArr: [] })],
    [
      "recognized no-data search",
      {
        statusCode: 93,
        result: null,
        statusDescription: CAL_EMPTY_SEARCH_DESCRIPTION,
      },
    ],
  ])("resets both failure counters after %s", async (_, successful) => {
    let windows = 0;
    const fetcher = syntheticFetch((endpoint) => {
      if (endpoint === CAL_ENDPOINTS.recent) {
        return response(recent());
      }
      const index = windows++;
      if (index === 4) {
        return response(successful);
      }
      return response(
        { syntheticFailure: true },
        (index < 4 ? index : index - 5) % 2 === 0 ? 503 : 200,
      );
    });
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-01-01", to: "2040-09-30" },
      limits: { maxAttempts: 1 },
    });
    const failures = events.filter((event) => event.type === "failure");
    expect(windows).toBe(9);
    expect(failures).toHaveLength(8);
    expect(failures.every((event) => !event.fatal)).toBe(true);
    expect(events.filter((event) => event.type === "capture")).toHaveLength(6);
  });

  it("retains invalid-response evidence and broad uncertainty after stopping history", async () => {
    const raw = envelope({ unexpectedShape: [{ syntheticEvidence: true }] });
    const range = { from: "2040-01-01", to: "2040-08-31" };
    const fetcher = syntheticFetch((endpoint) =>
      response(endpoint === CAL_ENDPOINTS.recent ? recent() : raw),
    );
    const db = await openDatabase(":memory:");
    await db.ensureConnection({ id: "synthetic-invalid", provider: "cal" });
    try {
      const summary = await collectFromStore(
        db,
        { connectionId: "synthetic-invalid", range },
        {
          provider: "cal",
          collectorVersion: "synthetic-invalid-v1",
          collect: (options) =>
            collectCal({ credentials, fetch: fetcher, ...options }),
        },
        calAdapter,
      );
      expect(summary).toMatchObject({
        status: "partial",
        captures: 4,
        requestedRange: range,
      });
      const runs = await db.orm.select().from(syncRuns).all();
      expect(
        runs
          .flatMap((run) => run.snapshot.responses)
          .filter((capture) => capture.responseText === JSON.stringify(raw)),
      ).toHaveLength(3);
      const failures = runs.flatMap((run) => run.snapshot.failures ?? []);
      expect(failures).toHaveLength(4);
      expect(failures.at(-1)).toEqual({
        accountKey: null,
        endpoint: "collection",
        code: "invalid_response",
        scope: { kind: "history", ...range },
      });
      expect(
        failures.slice(0, 3).map((failure) => failure.scope?.windowFrom),
      ).toEqual(["2040-01-01", "2040-02-01", "2040-03-01"]);
    } finally {
      await db.close();
    }
  });

  it("resets consecutive network failures only after a valid financial response", async () => {
    const fetcher = syntheticFetch((endpoint, body) => {
      const success =
        endpoint === CAL_ENDPOINTS.recent ||
        nominalSearchRange(body)?.from.startsWith("2040-02");
      return response(
        success
          ? endpoint === CAL_ENDPOINTS.recent
            ? recent()
            : envelope({ transArr: [] })
          : { syntheticFailure: true },
        success ? 200 : 503,
      );
    });
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-01-01", to: "2040-04-30" },
      limits: { retryDelayMs: 1 },
    });
    const failures = events.filter((event) => event.type === "failure");
    expect(failures).toHaveLength(3);
    expect(failures.every((event) => !event.fatal)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "failure",
      "capture",
      "failure",
      "failure",
    ]);
  });

  it("does not let an archived HTTP error reset the consecutive network failure limit", async () => {
    const fetcher = syntheticFetch((endpoint, body) => {
      if (endpoint === CAL_ENDPOINTS.recent) {
        return response(recent());
      }
      if (nominalSearchRange(body)?.from.startsWith("2040-02")) {
        return response(
          { statusCode: 7, result: null, syntheticError: true },
          400,
        );
      }
      return response({ syntheticFailure: true }, 503);
    });
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-01-01", to: "2040-06-30" },
      limits: { retryDelayMs: 1 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "failure",
      "capture",
      "failure",
      "failure",
      "failure",
    ]);
    expect(events[2]).toMatchObject({ capture: { httpStatus: 400 } });
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      fatal: true,
      failure: { code: "network_error", scope: { windowFrom: "2040-04-01" } },
    });
  });

  it("retries transient financial HTTP and network failures at most three attempts", async () => {
    let attempt = 0;
    const fetcher = syntheticFetch(() => {
      attempt++;
      if (attempt === 1) {
        throw new Error(`fetch failed ${credentials.password} ${token}`);
      }
      if (attempt === 2) {
        return response({ reflected: token }, 429);
      }
      return response(recent());
    });
    expect(
      (await collect({ fetch: fetcher, limits: { retryDelayMs: 1 } }))[0]?.type,
    ).toBe("capture");
    expect(attempt).toBe(3);
  });

  it("never retries login and sanitizes reflected exceptions", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(
        `${credentials.username} ${credentials.password} ${token}`,
      );
    });
    const events = await collect({ fetch: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        type: "failure",
        failure: {
          accountKey: null,
          endpoint: CAL_ENDPOINTS.login,
          code: "network_error",
        },
        fatal: true,
      },
    ]);
  });

  it.each([401, 403])(
    "hard stops HTTP auth status %s without additional months or retries",
    async (status) => {
      const fetcher = syntheticFetch(() =>
        response({ reflected: token }, status),
      );
      const events = await collect({
        fetch: fetcher,
        range: { from: "2019-01-01", to: "2026-12-31" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "failure",
        fatal: true,
        failure: {
          code:
            status === 401
              ? "authentication_failed"
              : "authentication_challenge",
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(events)).not.toContain(token);
    },
  );

  it("hard stops explicit OTP and password-change challenge bodies without archiving them", async () => {
    for (const payload of [
      { result: { requiresOtp: true, calConnectToken: token } },
      { statusTitle: "change password", token },
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => response(payload));
      const events = await collect({ fetch: fetcher });
      expect(events[0]).toMatchObject({
        type: "failure",
        fatal: true,
        failure: { code: "authentication_challenge" },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(events)).not.toContain(token);
    }
  });

  it("rejects malicious redirects without forwarding credentials to another URL", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 307,
          headers: {
            location: `https://attacker.example/${credentials.password}`,
          },
        }),
    );
    const events = await collect({ fetch: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("manual");
    expect(events[0]).toMatchObject({
      type: "failure",
      failure: { code: "invalid_response" },
      fatal: true,
    });
    expect(JSON.stringify(events)).not.toContain("attacker");
  });

  it("archives unknown successful financial shapes and pagination signals without guessing further requests", async () => {
    const raw = envelope({
      newProviderShape: [{ retained: "whole response" }],
      nextCursor: "SYNTHETIC-UNSUPPORTED-CURSOR",
    });
    const fetcher = syntheticFetch(() => response(raw));
    const events = await collect({ fetch: fetcher });
    expect(events.map((event) => event.type)).toEqual(["capture", "failure"]);
    expect(events[0]).toMatchObject({
      capture: { responseText: JSON.stringify(raw) },
    });
    expect(events[1]).toMatchObject({
      failure: { code: "invalid_response" },
      fatal: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("recognizes nested monthly shape but retains unrecognized monthly responses", async () => {
    const raw = envelope({ transArr: [{ amountForDisplay: 1.23 }] });
    const events = await collect({
      fetch: syntheticFetch((endpoint) =>
        response(endpoint === CAL_ENDPOINTS.recent ? recent() : raw),
      ),
      range: { from: "2024-02-29", to: "2024-02-29" },
      historyMode: "monthly",
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "failure",
    ]);
    expect(events[1]).toMatchObject({
      capture: {
        responseText: JSON.stringify(raw),
        scope: { kind: "history", month: "2024-02" },
      },
    });
  });

  it("does not archive credentials or tokens reflected in successful financial responses", async () => {
    for (const secret of [credentials.username, credentials.password, token]) {
      const raw = envelope({
        transactions: [],
        clearanceRequests: [],
        providerMessage: `reflected ${secret}`,
      });
      const events = await collect({
        fetch: syntheticFetch(() => response(raw)),
      });
      expect(events.map((event) => event.type)).toEqual(["failure"]);
      expect(events[0]).toMatchObject({
        failure: { code: "invalid_response" },
        fatal: true,
      });
      expect(JSON.stringify(events)).not.toContain(secret);
    }
    const events = await collect({
      fetch: syntheticFetch(() =>
        response(
          envelope({
            transactions: [],
            clearanceRequests: [],
            [credentials.password]: "secret field name",
          }),
        ),
      ),
    });
    expect(events[0]).toMatchObject({ type: "failure", fatal: true });
    expect(JSON.stringify(events)).not.toContain(credentials.password);
  });

  it("validates range before authentication and still retrieves recent data with unusable card mappings", async () => {
    const fetcher = syntheticFetch();
    expect(
      (
        await collect({
          fetch: fetcher,
          range: { from: "2023-02-29", to: "2024-01-01" },
        })
      )[0],
    ).toMatchObject({ type: "failure", failure: { code: "invalid_response" } });
    expect(fetcher).not.toHaveBeenCalled();
    const invalid = syntheticFetch(
      undefined,
      [accountId],
      [
        {
          cardUniqueId: cardId,
          bankAccountUniqueId: "SYNTHETIC-UNKNOWN-ACCOUNT",
        },
      ],
    );
    expect((await collect({ fetch: invalid }))[0]).toMatchObject({
      type: "capture",
      capture: { accountKey: accountId },
    });
    expect(invalid).toHaveBeenCalledTimes(3);
  });

  it("reports requested history missing card mappings rather than silently completing with recent only", async () => {
    const fetcher = syntheticFetch(undefined, [accountId], []);
    const events = await collect({
      fetch: fetcher,
      range: { from: "2019-01-01", to: "2026-10-13" },
    });
    expect(events.map((event) => event.type)).toEqual(["capture", "failure"]);
    expect(events[1]).toMatchObject({
      failure: {
        accountKey: accountId,
        endpoint: CAL_ENDPOINTS.init,
        code: "invalid_response",
        scope: { kind: "history", from: "2019-01-01", to: "2026-10-13" },
      },
      fatal: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects overwritten, nested, escaped and equal duplicate JSON keys before archival", async () => {
    const jsonSecret = JSON.stringify(credentials.password);
    for (const raw of [
      `{"statusCode":1,"result":{"transactions":[],"clearanceRequests":[],"m":${jsonSecret},"m":"x"}}`,
      `{"statusCode":1,"result":{"transactions":[],"clearanceRequests":[],"m":${jsonSecret},"\\u006d":"x"}}`,
      `{"statusCode":1,"result":{"transactions":[],"clearanceRequests":[],"nested":[{"m":${jsonSecret},"m":"x"}]}}`,
      '{"statusCode":1,"result":{"transactions":[],"clearanceRequests":[],"m":"x","m":"x"}}',
    ]) {
      const fetcher = syntheticFetch(() => new Response(raw));
      const events = await collect({ fetch: fetcher });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "failure",
        fatal: true,
        failure: { code: "invalid_response" },
      });
      expect(JSON.stringify(events)).not.toContain(credentials.password);
      expect(fetcher).toHaveBeenCalledTimes(3);
    }
  });

  it.each([200, 400, 404, 422])(
    "archives bounded safe financial error JSON with HTTP%s",
    async (status) => {
      const raw = {
        statusCode: 7,
        statusDescription: "Synthetic financial history unavailable",
        result: null,
        unknownErrorContext: { retained: true },
      };
      const events = await collect({
        fetch: syntheticFetch(() => response(raw, status)),
      });
      expect(events.map((event) => event.type)).toEqual(["capture", "failure"]);
      expect(events[0]).toMatchObject({
        capture: {
          responseText: JSON.stringify(raw),
          ...(status !== 200 ? { httpStatus: status } : {}),
        },
      });
      expect(events[1]).toMatchObject({
        failure: { code: "invalid_response" },
        fatal: false,
      });
    },
  );

  it("rejects auth challenges and secret reflections in non-successful JSON instead of archiving them", async () => {
    for (const [payload, expected] of [
      [
        {
          statusCode: 2,
          result: { requiresOtp: true },
          statusDescription: credentials.password,
        },
        "authentication_challenge",
      ],
      [
        { statusCode: 2, result: null, reflected: credentials.password },
        "invalid_response",
      ],
      [{ statusCode: 2, result: null, token }, "invalid_response"],
      [
        { statusCode: 2, result: null, statusDescription: "Invalid token" },
        "authentication_failed",
      ],
    ] as const) {
      const events = await collect({
        fetch: syntheticFetch(() => response(payload, 400)),
      });
      expect(events.map((event) => event.type)).toEqual(["failure"]);
      expect(events[0]).toMatchObject({
        failure: { code: expected },
        fatal: true,
      });
      expect(JSON.stringify(events)).not.toContain(credentials.password);
      expect(JSON.stringify(events)).not.toContain(token);
    }
  });

  it("stops the session after 429 retry exhaustion and retains safe final error JSON", async () => {
    const raw = {
      statusCode: 8,
      result: null,
      statusDescription: "Synthetic rate limit",
    };
    const fetcher = syntheticFetch(() => response(raw, 429));
    const events = await collect({
      fetch: fetcher,
      range: { from: "2019-01-01", to: "2026-10-13" },
      limits: { retryDelayMs: 1 },
    });
    expect(events.map((event) => event.type)).toEqual(["capture", "failure"]);
    expect(events[0]).toMatchObject({
      capture: { httpStatus: 429, responseText: JSON.stringify(raw) },
    });
    expect(events[1]).toMatchObject({
      failure: { code: "rate_limited" },
      fatal: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(5); // Login, init, three recent attempts; no history.
  });

  it("honors a bounded Retry-After and does not retry early or sleep for unbounded server delays", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fetcher = syntheticFetch(() => {
        attempts++;
        return attempts === 1
          ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
          : response(recent());
      });
      const pending = collect({ fetch: fetcher, limits: { retryDelayMs: 1 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending)[0]?.type).toBe("capture");
      expect(attempts).toBe(2);
      const oversized = syntheticFetch(
        () =>
          new Response("{}", {
            status: 429,
            headers: { "retry-after": "3600" },
          }),
      );
      const events = await collect({ fetch: oversized });
      expect(events[0]).toMatchObject({
        type: "failure",
        failure: { code: "rate_limited" },
        fatal: true,
      });
      expect(oversized).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops on a non-JSON rate-limit body without archiving challenge HTML", async () => {
    const fetcher = syntheticFetch(
      () =>
        new Response(`<html>${credentials.password}</html>`, { status: 429 }),
    );
    const events = await collect({
      fetch: fetcher,
      limits: { retryDelayMs: 1 },
    });
    expect(events.map((event) => event.type)).toEqual(["failure"]);
    expect(events[0]).toMatchObject({
      failure: { code: "rate_limited" },
      fatal: true,
    });
    expect(JSON.stringify(events)).not.toContain(credentials.password);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("preserves recent accounts and valid historical cards while reporting malformed/unmapped cards", async () => {
    const fetcher = syntheticFetch(
      undefined,
      [accountId],
      [
        { cardUniqueId: cardId, bankAccountUniqueId: accountId },
        { cardUniqueId: "", bankAccountUniqueId: accountId },
        {
          cardUniqueId: "SYNTHETIC-UNMAPPED-CARD",
          bankAccountUniqueId: "SYNTHETIC-UNKNOWN-ACCOUNT",
        },
      ],
    );
    const events = await collect({
      fetch: fetcher,
      range: { from: "2024-01-01", to: "2024-02-29" },
      historyMode: "monthly",
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "failure",
      "failure",
      "capture",
      "capture",
    ]);
    expect(events[0]).toMatchObject({
      capture: { accountKey: accountId, scope: { kind: "recent" } },
    });
    expect(events[1]).toMatchObject({
      failure: {
        accountKey: accountId,
        endpoint: CAL_ENDPOINTS.init,
        scope: { kind: "history" },
      },
      fatal: false,
    });
    expect(events[2]).toMatchObject({
      failure: { accountKey: null, endpoint: CAL_ENDPOINTS.init },
      fatal: false,
    });
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.monthly,
    );
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        ([, init]) => JSON.parse(String(init?.body)).cardUniqueId === cardId,
      ),
    ).toBe(true);
  });

  it("never guesses account ownership for conflicting duplicate card mappings", async () => {
    const second = "SYNTHETIC-ACCOUNT-B";
    const fetcher = syntheticFetch(
      undefined,
      [accountId, second],
      [
        { cardUniqueId: cardId, bankAccountUniqueId: accountId },
        { cardUniqueId: cardId, bankAccountUniqueId: second },
        { cardUniqueId: "SYNTHETIC-VALID-CARD", bankAccountUniqueId: second },
      ],
    );
    const events = await collect({
      fetch: fetcher,
      range: { from: "2024-01-01", to: "2024-01-31" },
      historyMode: "monthly",
    });
    expect(
      events.filter(
        (event) =>
          event.type === "capture" && event.capture.scope?.kind === "recent",
      ),
    ).toHaveLength(2);
    expect(events.filter((event) => event.type === "failure")).toHaveLength(2);
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.monthly,
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]![1]?.body))).toMatchObject({
      cardUniqueId: "SYNTHETIC-VALID-CARD",
    });
  });
});

describe("CAL frontend history contracts", () => {
  it("pads UTC calendar dates across leap/year boundaries and clamps four-digit year limits", () => {
    for (const [nominal, padded] of [
      [
        { from: "2040-01-01", to: "2040-01-31" },
        { from: "2039-12-31", to: "2040-02-01" },
      ],
      [
        { from: "2040-02-01", to: "2040-02-29" },
        { from: "2040-01-31", to: "2040-03-01" },
      ],
      [
        { from: "2039-02-28", to: "2039-02-28" },
        { from: "2039-02-27", to: "2039-03-01" },
      ],
      [
        { from: "2040-12-01", to: "2040-12-31" },
        { from: "2040-11-30", to: "2041-01-01" },
      ],
      [
        { from: "0001-01-01", to: "0001-01-01" },
        { from: "0001-01-01", to: "0001-01-02" },
      ],
      [
        { from: "9999-12-31", to: "9999-12-31" },
        { from: "9999-12-30", to: "9999-12-31" },
      ],
    ] as const) {
      expect(calPaddedSearchWindow(nominal)).toEqual(padded);
    }
  });

  it("records actual padded requests and nominal monthly plans with repeated filters and intentional overlap", async () => {
    const fetcher = syntheticFetch();
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-01-01", to: "2040-03-31" },
      searchFilters: { trnType: 5, toTrnAmt: "20.25" },
    });
    const captures = events.filter(
      (event) =>
        event.type === "capture" && event.capture.scope?.kind === "history",
    );
    expect(captures).toHaveLength(3);
    expect(captures[0]).toMatchObject({
      capture: {
        scope: {
          from: "2039-12-31",
          to: "2040-02-01",
          windowFrom: "2040-01-01",
          windowTo: "2040-01-31",
        },
      },
    });
    expect(captures[1]).toMatchObject({
      capture: {
        scope: {
          from: "2040-01-31",
          to: "2040-03-01",
          windowFrom: "2040-02-01",
          windowTo: "2040-02-29",
        },
      },
    });
    expect(captures[2]).toMatchObject({
      capture: {
        scope: {
          from: "2040-02-29",
          to: "2040-04-01",
          windowFrom: "2040-03-01",
          windowTo: "2040-03-31",
        },
      },
    });
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    const bodies = calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(3);
    expect(
      (Date.parse(bodies[0]!.toTransDate.slice(0, 10)) -
        Date.parse(bodies[0]!.fromTransDate.slice(0, 10))) /
        86_400_000 +
        1,
    ).toBe(33);
    for (const [index, body] of bodies.entries()) {
      expect(body).toMatchObject({ trnType: 5, toTrnAmt: 20.25 });
      if (index > 0) {
        expect(
          Date.parse(body.fromTransDate) -
            Date.parse(bodies[index - 1]!.toTransDate),
        ).toBe(-2 * 86_400_000 + 1);
      }
    }
  });

  it("preserves extra edge records and sends clamped boundary ranges without claiming provider support", async () => {
    const raw = envelope({
      transArr: [
        {
          trnIntId: "SYNTHETIC-BEFORE-EDGE",
          trnPurchaseDate: "2039-12-31T12:00:00",
        },
        {
          trnIntId: "SYNTHETIC-AFTER-EDGE",
          trnPurchaseDate: "2040-02-01T12:00:00",
        },
      ],
    });
    const events = await collect({
      fetch: syntheticFetch((endpoint) =>
        response(endpoint === CAL_ENDPOINTS.search ? raw : recent()),
      ),
      range: { from: "2040-01-01", to: "2040-01-31" },
    });
    expect(events[1]).toMatchObject({
      capture: {
        responseText: JSON.stringify(raw),
        scope: { windowFrom: "2040-01-01", windowTo: "2040-01-31" },
      },
    });
    for (const [range, expected] of [
      [
        { from: "0001-01-01", to: "0001-01-01" },
        {
          fromTransDate: "0001-01-01T00:00:00.000Z",
          toTransDate: "0001-01-02T23:59:59.999Z",
        },
      ],
      [
        { from: "9999-12-31", to: "9999-12-31" },
        {
          fromTransDate: "9999-12-30T00:00:00.000Z",
          toTransDate: "9999-12-31T23:59:59.999Z",
        },
      ],
    ] as const) {
      const fetcher = syntheticFetch();
      await collect({ fetch: fetcher, range });
      const call = fetcher.mock.calls.find(
        ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
      )!;
      expect(JSON.parse(String(call[1]?.body))).toMatchObject(expected);
    }
    const fetcher = syntheticFetch();
    await collect({
      fetch: fetcher,
      range: { from: "0000-01-01", to: "0001-01-01" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("defaults a caller date range to transaction search in one-month windows", async () => {
    const fetcher = syntheticFetch();
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-02-29", to: "2040-03-01" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "capture",
    ]);
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]![1]?.body))).toMatchObject({
      fromTransDate: "2040-02-28T00:00:00.000Z",
      toTransDate: "2040-03-01T23:59:59.999Z",
    });
    expect(JSON.parse(String(calls[1]![1]?.body))).toMatchObject({
      fromTransDate: "2040-02-29T00:00:00.000Z",
      toTransDate: "2040-03-02T23:59:59.999Z",
    });
    expect(
      fetcher.mock.calls.filter(
        ([endpoint]) => endpoint === CAL_ENDPOINTS.monthly,
      ),
    ).toEqual([]);
  });

  it("supports bounded explicit annual diagnostic windows without crossing year boundaries", () => {
    expect([
      ...calHistoryWindows({ from: "2023-12-31", to: "2025-01-01" }, 12),
    ]).toEqual([
      { from: "2023-12-31", to: "2023-12-31" },
      { from: "2024-01-01", to: "2024-12-31" },
      { from: "2025-01-01", to: "2025-01-01" },
    ]);
    for (const window of calHistoryWindows(
      { from: "2019-01-01", to: "2026-10-13" },
      12,
    )) {
      expect(
        (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000 + 1,
      ).toBeLessThanOrEqual(366);
    }
  });

  it("uses exact search payload and groups only known account cards with no date gaps", async () => {
    const secondAccount = "SYNTHETIC-ACCOUNT-B";
    const fetcher = syntheticFetch(
      undefined,
      [accountId, secondAccount],
      [
        { cardUniqueId: cardId, bankAccountUniqueId: accountId },
        {
          cardUniqueId: "SYNTHETIC-CARD-A-SECOND",
          bankAccountUniqueId: accountId,
        },
        {
          cardUniqueId: "SYNTHETIC-CARD-B",
          bankAccountUniqueId: secondAccount,
        },
      ],
    );
    const events = await collect({
      fetch: fetcher,
      range: { from: "2023-12-31", to: "2025-01-01" },
      historyMode: "search",
      searchWindowMonths: 12,
    });
    expect(events.filter((event) => event.type === "capture")).toHaveLength(8);
    expect(events.filter((event) => event.type === "failure")).toEqual([]);
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(calls).toHaveLength(6);
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({
      bankAccountUniqueID: accountId,
      cards: [
        { cardUniqueID: cardId },
        { cardUniqueID: "SYNTHETIC-CARD-A-SECOND" },
      ],
      fromTransDate: "2023-12-30T00:00:00.000Z",
      toTransDate: "2024-01-01T23:59:59.999Z",
      merchantHebName: "",
      merchantHebCity: "",
      trnType: 0,
      fromTrnAmt: 0,
      toTrnAmt: 0,
      transactionsOrigin: 0,
      transCardPresentInd: 0,
      caller: "module_search",
    });
    const nextBody = JSON.parse(String(calls[1]![1]?.body));
    expect(nextBody.fromTransDate).toBe("2023-12-31T00:00:00.000Z");
    expect(nextBody.toTransDate).toBe("2025-01-01T23:59:59.999Z");
    expect(events[2]).toMatchObject({
      capture: {
        scope: {
          kind: "history",
          from: "2023-12-30",
          to: "2024-01-01",
          windowFrom: "2023-12-31",
          windowTo: "2023-12-31",
          cardKeys: [cardId, "SYNTHETIC-CARD-A-SECOND"],
        },
      },
    });
    expect(
      fetcher.mock.calls.filter(
        ([endpoint]) => endpoint === CAL_ENDPOINTS.monthly,
      ),
    ).toEqual([]);
  });

  it.each(["search"] as const)(
    "keeps authentication, secret and rate-limit boundaries for %s",
    async (historyMode) => {
      const requested = CAL_ENDPOINTS[historyMode];
      for (const scenario of ["secret", "auth", "rate"] as const) {
        const fetcher = syntheticFetch((endpoint) => {
          if (endpoint === CAL_ENDPOINTS.recent) {
            return response(recent());
          }
          expect(endpoint).toBe(requested);
          return scenario === "secret"
            ? response(envelope({ message: credentials.password }))
            : scenario === "auth"
              ? response({ result: null }, 401)
              : response({ statusCode: 8, result: null }, 429);
        });
        const events = await collect({
          fetch: fetcher,
          range: { from: "2019-01-01", to: "2026-10-13" },
          historyMode,
          limits: { retryDelayMs: 1 },
        });
        expect(events[0]?.type).toBe("capture");
        expect(events.at(-1)).toMatchObject({
          type: "failure",
          fatal: true,
          failure: {
            code:
              scenario === "secret"
                ? "invalid_response"
                : scenario === "auth"
                  ? "authentication_failed"
                  : "rate_limited",
          },
        });
        expect(JSON.stringify(events)).not.toContain(credentials.password);
        expect(
          fetcher.mock.calls.filter(([endpoint]) => endpoint === requested),
        ).toHaveLength(scenario === "rate" ? 3 : 1);
      }
    },
  );

  it("archives unsupported search pagination without following cursors", async () => {
    const raw = envelope({ transArr: [], nextCursor: "SYNTHETIC-CURSOR" });
    const fetcher = syntheticFetch((endpoint) =>
      response(endpoint === CAL_ENDPOINTS.search ? raw : recent()),
    );
    const events = await collect({
      fetch: fetcher,
      range: { from: "2024-01-01", to: "2024-01-31" },
      historyMode: "search",
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "failure",
    ]);
    expect(events[1]).toMatchObject({
      capture: { responseText: JSON.stringify(raw) },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects digit-only credentials reflected as unquoted or huge numeric lexemes", async () => {
    const numericCredentials = {
      username: "98765432109",
      password: "112233445566778899001122334455",
    };
    for (const numberText of [
      numericCredentials.username,
      numericCredentials.password,
      `77${numericCredentials.password}99`,
    ]) {
      const raw = `{"statusCode":1,"result":{"transactions":[],"clearanceRequests":[],"numeric":${numberText}}}`;
      const events = await collect({
        credentials: numericCredentials,
        fetch: syntheticFetch(() => new Response(raw)),
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "failure",
        fatal: true,
        failure: { code: "invalid_response" },
      });
      expect(JSON.stringify(events)).not.toContain(numericCredentials.username);
      expect(JSON.stringify(events)).not.toContain(numericCredentials.password);
    }
  });
});

describe("CAL typed search filters", () => {
  const range = { from: "2023-12-31", to: "2024-12-31" };

  it("retains all safe discovered card metadata when historical transactions select only one card", async () => {
    const otherCard = "SYNTHETIC-NOT-SELECTED";
    const fetcher = syntheticFetch(
      undefined,
      [accountId],
      [
        {
          cardUniqueId: cardId,
          bankAccountUniqueId: accountId,
          last4Digits: "0012",
        },
        {
          cardUniqueId: otherCard,
          bankAccountUniqueId: accountId,
          last4Digits: "3456",
        },
      ],
    );
    const generator = collectCal({
      credentials,
      fetch: fetcher,
      range: { from: "2040-01-01", to: "2040-01-31" },
      searchFilters: { cardKeys: [cardId] },
    });
    expect((await generator.next()).value).toMatchObject({
      type: "card_discovery",
      discovery: {
        cards: [
          { cardKey: cardId, last4: "0012" },
          { cardKey: otherCard, last4: "3456" },
        ],
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await collectFinancialEvents(generator);
    const searchCalls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(searchCalls).toHaveLength(1);
    expect(JSON.parse(String(searchCalls[0]![1]?.body))).toMatchObject({
      cards: [{ cardUniqueID: cardId }],
    });
  });

  it("serializes every supported filter exactly and preserves criteria through calendar windows", async () => {
    const fetcher = syntheticFetch(
      undefined,
      [accountId],
      [
        { cardUniqueId: cardId, bankAccountUniqueId: accountId },
        {
          cardUniqueId: "SYNTHETIC-NOT-SELECTED",
          bankAccountUniqueId: accountId,
        },
      ],
    );
    const searchFilters: CalSearchFilters = {
      merchantHebName: "Synthetic Merchant",
      merchantHebCity: "Synthetic City",
      trnType: 6,
      fromTrnAmt: "0.29",
      toTrnAmt: "100.20",
      transactionsOrigin: 1,
      transCardPresentInd: 2,
      cardKeys: [cardId, cardId],
    };
    const events = await collect({
      fetch: fetcher,
      range,
      historyMode: "search",
      searchFilters,
    });
    expect(events.filter((event) => event.type === "failure")).toEqual([]);
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(calls).toHaveLength(13);
    for (const [, init] of calls) {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        merchantHebName: "Synthetic Merchant",
        merchantHebCity: "Synthetic City",
        trnType: 6,
        fromTrnAmt: 0.29,
        toTrnAmt: 100.2,
        transactionsOrigin: 1,
        transCardPresentInd: 2,
        cards: [{ cardUniqueID: cardId }],
      });
      expect(body).not.toHaveProperty("walletTranInd");
      expect(body).not.toHaveProperty("cashAccountInd");
      expect(body).not.toHaveProperty("cashAccountRecInd");
    }
    for (const event of events.filter(
      (event) =>
        event.type === "capture" && event.capture.scope?.kind === "history",
    )) {
      expect(event).toMatchObject({
        capture: {
          scope: {
            cardKeys: [cardId],
            filters: {
              cal: {
                merchantHebName: "Synthetic Merchant",
                merchantHebCity: "Synthetic City",
                trnType: 6,
                fromTrnAmt: "0.29",
                toTrnAmt: "100.20",
                transactionsOrigin: 1,
                transCardPresentInd: 2,
              },
            },
          },
        },
      });
    }
  });

  it("supports only public posted-search enum values and normalizes default amounts exactly", () => {
    for (const trnType of [0, 1, 5, 6, 7, 8, 9, 42, 44, 59, 60, 999] as const) {
      expect(normalizeCalSearchFilters({ trnType }).request.trnType).toBe(
        trnType,
      );
    }
    for (const value of [0, 1, 2] as const) {
      expect(
        normalizeCalSearchFilters({ transactionsOrigin: value }).request
          .transactionsOrigin,
      ).toBe(value);
      expect(
        normalizeCalSearchFilters({ transCardPresentInd: value }).request
          .transCardPresentInd,
      ).toBe(value);
    }
    expect(normalizeCalSearchFilters().recorded).toEqual({
      merchantHebName: "",
      merchantHebCity: "",
      trnType: 0,
      fromTrnAmt: "0.00",
      toTrnAmt: "0.00",
      transactionsOrigin: 0,
      transCardPresentInd: 0,
    });
    expect(
      normalizeCalSearchFilters({ fromTrnAmt: "10", toTrnAmt: "10.0" })
        .recorded,
    ).toMatchObject({ fromTrnAmt: "10.00", toTrnAmt: "10.00" });
  });

  it("rejects malformed, unknown, unsupported and imprecise criteria before login", async () => {
    for (const searchFilters of [
      { trnType: 99 },
      { transactionsOrigin: 3 },
      { transCardPresentInd: 3 },
      { fromTrnAmt: "-1.00" },
      { fromTrnAmt: "0.001" },
      { fromTrnAmt: "1e3" },
      { fromTrnAmt: "90071992547409.91" },
      { fromTrnAmt: "99999999999999999999" },
      { fromTrnAmt: "20", toTrnAmt: "10" },
      { toTrnAmt: 1.25 },
      { merchantHebName: "x".repeat(31) },
      { merchantHebCity: "Bad\nCity" },
      { cardKeys: [] },
      { cardKeys: [""] },
      { cardKeys: ["   "] },
      { cardKeys: ["\r\nSYNTHETIC-CARD"] },
      { cardKeys: ["SYNTHETIC\tCARD"] },
      { cardKeys: ["SYNTHETIC\u0000CARD"] },
      { cardKeys: ["SYNTHETIC\u007fCARD"] },
      { merchantHebName: "Greek Ω" },
      { merchantHebName: "Ampersand &" },
      { caller: "arbitrary" },
      { walletTranInd: true },
      { cashAccountInd: false },
      { cashAccountRecInd: true },
    ]) {
      const fetcher = syntheticFetch();
      const events = await collect({
        fetch: fetcher,
        range,
        historyMode: "search",
        searchFilters: searchFilters as unknown as CalSearchFilters,
      });
      expect(events[0]).toMatchObject({
        type: "failure",
        failure: { code: "invalid_response" },
        fatal: true,
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("supports the exact public merchant character set including Hebrew, hyphen and quote", async () => {
    const merchantHebName = 'Synthetic-123 "דוגמה"';
    const fetcher = syntheticFetch();
    const events = await collect({
      fetch: fetcher,
      range,
      historyMode: "search",
      searchFilters: { merchantHebName },
    });
    expect(events.filter((event) => event.type === "failure")).toEqual([]);
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(calls).toHaveLength(13);
    expect(
      calls.every(
        ([, init]) =>
          JSON.parse(String(init?.body)).merchantHebName === merchantHebName,
      ),
    ).toBe(true);
    expect(events[1]).toMatchObject({
      capture: { scope: { filters: { cal: { merchantHebName } } } },
    });
  });

  it("accepts selected discovered cards across accounts and rejects unknown ownership before financial requests", async () => {
    const second = "SYNTHETIC-ACCOUNT-B";
    const fetcher = syntheticFetch(
      undefined,
      [accountId, second],
      [
        { cardUniqueId: cardId, bankAccountUniqueId: accountId },
        { cardUniqueId: "SYNTHETIC-SECOND-CARD", bankAccountUniqueId: second },
      ],
    );
    const events = await collect({
      fetch: fetcher,
      range,
      historyMode: "search",
      searchFilters: { cardKeys: ["SYNTHETIC-SECOND-CARD"] },
    });
    expect(events.filter((event) => event.type === "failure")).toEqual([]);
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(calls).toHaveLength(13);
    expect(
      calls.every(
        ([, init]) =>
          JSON.parse(String(init?.body)).bankAccountUniqueID === second,
      ),
    ).toBe(true);
    const invalid = syntheticFetch();
    expect(
      (
        await collect({
          fetch: invalid,
          range,
          historyMode: "search",
          searchFilters: { cardKeys: ["SYNTHETIC-UNKNOWN-CARD"] },
        })
      )[0],
    ).toMatchObject({
      type: "failure",
      failure: { code: "invalid_response", endpoint: CAL_ENDPOINTS.init },
      fatal: true,
    });
    expect(invalid).toHaveBeenCalledTimes(2);
  });

  it("rejects filter use outside ranged search and prevents credentials in filter context", async () => {
    for (const options of [
      { historyMode: "monthly" as const, range },
      { historyMode: "search" as const },
    ]) {
      const fetcher = syntheticFetch();
      await collect({ ...options, fetch: fetcher, searchFilters: {} });
      expect(fetcher).not.toHaveBeenCalled();
    }
    const fetcher = syntheticFetch();
    const events = await collect({
      fetch: fetcher,
      credentials: { username: "SYNTHETIC-PRIVATE-USER", password: "Merchant" },
      range,
      historyMode: "search",
      searchFilters: { merchantHebName: "Merchant" },
    });
    expect(events[0]).toMatchObject({ type: "failure", fatal: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("Merchant");
  });

  it("preserves filter context on unsupported pagination without inventing subsequent cursor requests", async () => {
    const raw = envelope({
      transArr: [],
      hasMore: true,
      nextCursor: "SYNTHETIC-CONTINUATION",
    });
    const fetcher = syntheticFetch((endpoint) =>
      response(endpoint === CAL_ENDPOINTS.search ? raw : recent()),
    );
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-01-01", to: "2040-01-31" },
      historyMode: "search",
      searchFilters: { trnType: 5 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "failure",
    ]);
    expect(events[1]).toMatchObject({
      capture: {
        responseText: JSON.stringify(raw),
        scope: { filters: { cal: { trnType: 5 } } },
      },
    });
    expect(events[2]).toMatchObject({
      failure: {
        code: "invalid_response",
        scope: { filters: { cal: { trnType: 5 } } },
      },
      fatal: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("archives the synthetic search93 no-data fixture and continues every requested window without declaring retention complete", async () => {
    const raw = readFileSync(
      new URL("./fixtures/search-empty.json", import.meta.url),
      "utf8",
    );
    const fetcher = syntheticFetch((endpoint) =>
      endpoint === CAL_ENDPOINTS.search
        ? new Response(raw)
        : response(recent()),
    );
    const events = await collect({
      fetch: fetcher,
      range: { from: "2030-01-01", to: "2040-10-13" },
      historyMode: "search",
    });
    expect(events.filter((event) => event.type === "failure")).toEqual([]);
    const history = events.filter(
      (event) =>
        event.type === "capture" && event.capture.scope?.kind === "history",
    );
    expect(history).toHaveLength(130);
    expect(
      history.every(
        (event) =>
          event.type === "capture" && event.capture.responseText === raw,
      ),
    ).toBe(true);
    expect(history[0]).toMatchObject({
      capture: {
        scope: {
          from: "2029-12-31",
          to: "2030-02-01",
          windowFrom: "2030-01-01",
          windowTo: "2030-01-31",
        },
      },
    });
    expect(history.at(-1)).toMatchObject({
      capture: {
        scope: {
          from: "2040-09-30",
          to: "2040-10-14",
          windowFrom: "2040-10-01",
          windowTo: "2040-10-13",
        },
      },
    });
  });

  it("does not generalize search93 no-data success to other endpoints or descriptions", async () => {
    const noData = JSON.parse(
      readFileSync(
        new URL("./fixtures/search-empty.json", import.meta.url),
        "utf8",
      ),
    );
    const recentErrors = await collect({
      fetch: syntheticFetch(() => response(noData)),
    });
    expect(recentErrors.map((event) => event.type)).toEqual([
      "capture",
      "failure",
    ]);
    const searchErrors = await collect({
      fetch: syntheticFetch((endpoint) =>
        response(
          endpoint === CAL_ENDPOINTS.search
            ? { ...noData, statusDescription: "Other unvalidated error" }
            : recent(),
        ),
      ),
      range: { from: "2040-01-01", to: "2040-01-31" },
      historyMode: "search",
    });
    expect(searchErrors.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "failure",
    ]);
  });

  it("splits explicit one-, three-, six- or twelve-month search windows without calendar gaps", () => {
    const span = { from: "2024-02-29", to: "2025-02-01" };
    expect([...calHistoryWindows(span, 3)]).toEqual([
      { from: "2024-02-29", to: "2024-04-30" },
      { from: "2024-05-01", to: "2024-07-31" },
      { from: "2024-08-01", to: "2024-10-31" },
      { from: "2024-11-01", to: "2024-12-31" },
      { from: "2025-01-01", to: "2025-02-01" },
    ]);
    for (const months of [1, 3, 6, 12] as const) {
      const windows = [...calHistoryWindows(span, months)];
      expect(windows[0]?.from).toBe(span.from);
      expect(windows.at(-1)?.to).toBe(span.to);
      for (const [index, window] of windows.entries()) {
        expect(window.from.slice(0, 4)).toBe(window.to.slice(0, 4));
        expect(
          Number(window.to.slice(5, 7)) - Number(window.from.slice(5, 7)) + 1,
        ).toBeLessThanOrEqual(months);
        if (index > 0) {
          expect(
            Date.parse(window.from) - Date.parse(windows[index - 1]!.to),
          ).toBe(86_400_000);
        }
      }
    }
  });

  it("uses smaller adapter windows with exact boundary timestamps and identical recorded filters", async () => {
    const fetcher = syntheticFetch();
    const events = await collect({
      fetch: fetcher,
      range: { from: "2040-02-29", to: "2041-02-01" },
      historyMode: "search",
      searchWindowMonths: 3,
      searchFilters: { trnType: 5, fromTrnAmt: "5.25", toTrnAmt: "8.75" },
    });
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(calls).toHaveLength(5);
    const bodies = calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0]).toMatchObject({
      fromTransDate: "2040-02-28T00:00:00.000Z",
      toTransDate: "2040-05-01T23:59:59.999Z",
    });
    expect(bodies.at(-1)).toMatchObject({
      fromTransDate: "2040-12-31T00:00:00.000Z",
      toTransDate: "2041-02-02T23:59:59.999Z",
    });
    for (const [index, body] of bodies.entries()) {
      expect(body).toMatchObject({
        trnType: 5,
        fromTrnAmt: 5.25,
        toTrnAmt: 8.75,
      });
      if (index > 0) {
        expect(
          Date.parse(body.fromTransDate) -
            Date.parse(bodies[index - 1]!.toTransDate),
        ).toBe(-2 * 86_400_000 + 1);
      }
    }
    for (const event of events.filter(
      (event) =>
        event.type === "capture" && event.capture.scope?.kind === "history",
    )) {
      expect(event).toMatchObject({
        capture: {
          scope: {
            filters: {
              cal: { trnType: 5, fromTrnAmt: "5.25", toTrnAmt: "8.75" },
            },
          },
        },
      });
    }
  });

  it("rejects unsupported search-window tuning before login", async () => {
    for (const searchWindowMonths of [0, 2, 4, 13]) {
      const fetcher = syntheticFetch();
      await collect({
        fetch: fetcher,
        range,
        historyMode: "search",
        searchWindowMonths: searchWindowMonths as 1,
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
    const fetcher = syntheticFetch();
    await collect({
      fetch: fetcher,
      range,
      historyMode: "monthly",
      searchWindowMonths: 3,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("CAL monthly search coverage regression", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/search-window-consistency.json", import.meta.url),
      "utf8",
    ),
  ) as {
    range: { from: string; to: string };
    annualResponse: { statusCode: number; result: { transArr: unknown[] } };
    quarterlyResponses: Record<
      string,
      { statusCode: number; result: { transArr: unknown[] } }
    >;
    monthlyResponses: Record<
      string,
      { statusCode: number; result: { transArr: unknown[] } }
    >;
  };

  it("keeps coverage unknown when successful yearly and nonempty quarterly responses omit monthly purchases", async () => {
    const fetcher = syntheticFetch((endpoint, body) => {
      if (endpoint === CAL_ENDPOINTS.recent) {
        return response(recent());
      }
      const nominal = nominalSearchRange(body)!;
      const yearWide =
        nominal.from === fixture.range.from && nominal.to === fixture.range.to;
      const monthCount =
        Number(nominal.to.slice(5, 7)) - Number(nominal.from.slice(5, 7)) + 1;
      const responses =
        monthCount === 3
          ? fixture.quarterlyResponses
          : fixture.monthlyResponses;
      return response(
        yearWide
          ? fixture.annualResponse
          : (responses[nominal.from.slice(0, 7)] ?? fixture.annualResponse),
      );
    });

    async function run(searchWindowMonths?: 1 | 3 | 6 | 12) {
      const db = await openDatabase(":memory:");
      await db.ensureConnection({ id: "synthetic-window", provider: "cal" });
      try {
        return await collectFromStore(
          db,
          { connectionId: "synthetic-window", range: fixture.range },
          {
            provider: "cal",
            collectorVersion: "synthetic-window-v1",
            collect: (options) =>
              collectCal({
                credentials,
                fetch: fetcher,
                ...options,
                ...(searchWindowMonths ? { searchWindowMonths } : {}),
              }),
          },
          calAdapter,
        );
      } finally {
        await db.close();
      }
    }

    const yearly = await run(12);
    expect(yearly).toMatchObject({
      status: "completed",
      captures: 2,
      created: 0,
    });
    fetcher.mockClear();
    const quarterly = await run(3);
    expect(quarterly).toMatchObject({
      status: "completed",
      captures: 5,
      created: 1,
    });
    expect(
      fetcher.mock.calls.filter(
        ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
      ),
    ).toHaveLength(4);
    fetcher.mockClear();
    const monthly = await run();
    expect(monthly).toMatchObject({
      status: "completed",
      captures: 13,
      created: 2,
    });
    const calls = fetcher.mock.calls.filter(
      ([endpoint]) => endpoint === CAL_ENDPOINTS.search,
    );
    expect(calls).toHaveLength(12);
    expect(JSON.parse(String(calls[0]![1]?.body))).toMatchObject({
      fromTransDate: "2039-12-31T00:00:00.000Z",
      toTransDate: "2040-02-01T23:59:59.999Z",
    });
    expect(JSON.parse(String(calls[1]![1]?.body))).toMatchObject({
      fromTransDate: "2040-01-31T00:00:00.000Z",
      toTransDate: "2040-03-01T23:59:59.999Z",
    });
    expect(JSON.parse(String(calls.at(-1)![1]?.body))).toMatchObject({
      fromTransDate: "2040-11-30T00:00:00.000Z",
      toTransDate: "2041-01-01T23:59:59.999Z",
    });
  });
});

describe("CAL bounded transport", () => {
  it("caps response bytes despite a missing or lying content-length", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("a".repeat(200), { headers: { "content-length": "1" } }),
    );
    await expect(
      createCalTransport({
        fetch: fetcher,
        limits: { maxResponseBytes: 100 },
      }).post(CAL_ENDPOINTS.init, {}),
    ).rejects.toThrow("invalid_response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout through body reading and cancels stalled streams", async () => {
    let cancelled = 0;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled++;
            },
          }),
        ),
    );
    await expect(
      createCalTransport({
        fetch: fetcher,
        limits: { timeoutMs: 10, maxAttempts: 1 },
      }).post(CAL_ENDPOINTS.init, {}),
    ).rejects.toThrow("network_error");
    expect(cancelled).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops on caller abort and does not leak the arbitrary abort reason", async () => {
    const controller = new AbortController();
    const fetcher = syntheticFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              setTimeout(() => controller.abort(credentials.password), 10);
            },
          }),
        ),
    );
    const events = await collect({ fetch: fetcher, signal: controller.signal });
    expect(events).toEqual([
      {
        type: "failure",
        failure: {
          accountKey: accountId,
          endpoint: CAL_ENDPOINTS.recent,
          scope: { kind: "recent" },
          code: "network_error",
        },
        fatal: true,
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not send already-aborted requests and bounds retries and destinations", async () => {
    const fetcher = syntheticFetch();
    const events = await collect({
      fetch: fetcher,
      signal: AbortSignal.abort(credentials.password),
    });
    expect(events[0]).toMatchObject({
      failure: { code: "network_error" },
      fatal: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createCalTransport({ limits: { maxAttempts: 4 } })).toThrow(
      "invalid_response",
    );
    await expect(
      createCalTransport({ fetch: fetcher }).post(
        "http://api.cal-online.co.il/",
        credentials,
      ),
    ).rejects.toThrow("invalid_response");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
