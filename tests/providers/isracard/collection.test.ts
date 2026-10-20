import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { collectFromStore } from "../../../src/application/collection.js";
import type { CollectionEvent } from "../../../src/domain/source-adapter.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import { projectIsracardCardList } from "../../../src/providers/isracard/capture.js";
import {
  collectIsracard,
  type CollectIsracardOptions,
  isracardHistoryMonths,
  type IsracardSession,
} from "../../../src/providers/isracard/collect.js";
import { extractIsracard } from "../../../src/providers/isracard/extract.js";
import {
  ISRACARD_ENDPOINTS,
  type IsracardResponse,
  type IsracardTransport,
  IsracardTransportError,
} from "../../../src/providers/isracard/transport.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";

const firstCard = {
  companyCode: "11",
  cardGuid: "SYNTHETIC-FIRST",
  cardSuffix: "1234",
  isActive: true,
  isPartner: false,
  cardChargeNext: { billingDate: "10/08/2040", period: "Next" },
  cardChargeLast: { billingDate: "10/07/2040", period: "Last" },
};
const secondCard = {
  ...firstCard,
  cardGuid: "SYNTHETIC-SECOND",
  cardSuffix: "5678",
};
const digitalText =
  ' {"isSuccess":true,"errorCode":"0","data":{"approvals":null,"rawAmount":1.23000000000000001}}\n';

function financial(
  payload: object,
  responseText = JSON.stringify(payload),
): IsracardResponse {
  return {
    payload: payload as Record<string, unknown>,
    responseText,
    httpStatus: 200,
  };
}

function setup(cards: Record<string, unknown>[] = [firstCard]) {
  const request = vi.fn(
    async (
      endpoint: string,
      _body?: object,
      _query?: Record<string, string>,
    ) => {
      if (endpoint === ISRACARD_ENDPOINTS.login) {
        return financial({ status: "1" });
      }
      if (endpoint === ISRACARD_ENDPOINTS.cards) {
        return financial({ isSuccess: true, data: { cardsList: cards } });
      }
      if (endpoint === ISRACARD_ENDPOINTS.transactions) {
        return financial(JSON.parse(digitalText) as object, digitalText);
      }
      if (endpoint === ISRACARD_ENDPOINTS.details) {
        return financial({
          Header: { Status: "1" },
          PirteyIska_204Bean: { address: "Synthetic street" },
        });
      }
      return financial({
        Header: { Status: "1" },
        CardsTransactionsListBean: {
          cardNumberList: cards.map((card) => `Synthetic ${card.cardSuffix}`),
          ...Object.fromEntries(
            cards.map((_, index) => [
              `Index${index}`,
              {
                CurrentCardTransactions: [
                  {
                    txnIsrael: [{ voucherNumberRatz: "123456789" }],
                    txnAbroad: [],
                  },
                ],
              },
            ]),
          ),
        },
      });
    },
  );
  const transport: IsracardTransport = {
    request,
    containsAuthMaterial: () => false,
    close: vi.fn(),
  };
  // A fake clock: waiting advances it, so paced waits are exact.
  const clock = { now: 0 };
  const sleep = vi.fn(async (milliseconds: number) => {
    clock.now += milliseconds;
  });
  const options: CollectIsracardOptions = {
    credentials: {
      username: "synthetic-username",
      password: "synthetic-password",
      cardSuffix: "991234",
    },
    httpClient: { request: vi.fn() },
    transport,
    sleep,
    now: () => clock.now,
  };
  return { request, transport, options, sleep, clock };
}

async function allEvents(
  options: CollectIsracardOptions,
): Promise<CollectionEvent[]> {
  const result: CollectionEvent[] = [];
  for await (const event of collectIsracard(options)) {
    result.push(event);
  }
  return result;
}

async function events(
  options: CollectIsracardOptions,
): Promise<CollectionEvent[]> {
  return (await allEvents(options)).filter(
    (event) => event.type !== "card_discovery",
  );
}

describe("Isracard conservative bounded collection", () => {
  it("projects the evidenced product cardName separately from adjacent cardholder names", async () => {
    const source = JSON.parse(
      readFileSync(
        new URL("./fixtures/card-discovery.json", import.meta.url),
        "utf8",
      ),
    );
    const { options, request } = setup(source.data.cardsList);
    const collection = collectIsracard(options);
    expect((await collection.next()).value).toEqual({
      type: "card_discovery",
      discovery: {
        observedAt: expect.any(String),
        cards: [
          {
            cardKey: 'isracard:card:["11","0012"]',
            last4: "0012",
            displayName: "כרטיס דוגמה סינתטי",
          },
        ],
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    await collection.return(undefined);
  });

  it.each([
    undefined,
    null,
    "",
    "x".repeat(129),
    "Synthetic\nCard",
    "4111 1111 1111 1111",
  ])("omits invalid cardName %j from discovery", async (cardName) => {
    const { options } = setup([{ ...firstCard, ...{ cardName } }]);
    const collection = collectIsracard(options);
    const event = (await collection.next()).value;
    expect(event).toMatchObject({
      type: "card_discovery",
      discovery: { cards: [{ last4: "1234" }] },
    });
    expect(JSON.stringify(event)).not.toContain('"displayName"');
    await collection.return(undefined);
  });

  it("discovers stable card identities before financial requests without retaining session identity or credential suffix", async () => {
    const { options, request } = setup([
      firstCard,
      { ...secondCard, companyCode: "77", isActive: false, isPartner: true },
    ]);
    const collection = collectIsracard(options);
    const discovered = await collection.next();
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      ISRACARD_ENDPOINTS.login,
      ISRACARD_ENDPOINTS.cards,
    ]);
    expect(discovered.value).toEqual({
      type: "card_discovery",
      discovery: {
        observedAt: expect.any(String),
        cards: [
          {
            cardKey: 'isracard:card:["11","1234"]',
            last4: "1234",
          },
          {
            cardKey: 'isracard:card:["77","5678"]',
            last4: "5678",
          },
        ],
      },
    });
    const serialized = JSON.stringify(discovered.value);
    expect(serialized).not.toContain(options.credentials.cardSuffix);
    expect(serialized).not.toContain("SYNTHETIC-FIRST");
    expect(serialized).not.toContain("isActive");
    expect(serialized).not.toContain("isPartner");
    await collection.return(undefined);

    const later = setup([{ ...firstCard, cardGuid: "NEW-SESSION-GUID" }]);
    const laterDiscovery = (await allEvents(later.options)).find(
      (event) => event.type === "card_discovery",
    );
    expect(laterDiscovery).toMatchObject({
      discovery: {
        cards: [{ cardKey: 'isracard:card:["11","1234"]', last4: "1234" }],
      },
    });
  });

  it("retains validated discovery when no billing period is usable or financial budget remains", async () => {
    const unknownPeriods = setup([
      { ...firstCard, cardChargeNext: { billingDate: "unknown" } },
    ]);
    const noPeriods = await allEvents(unknownPeriods.options);
    expect(noPeriods.map((event) => event.type)).toEqual([
      "failure",
      "card_discovery",
    ]);
    expect(unknownPeriods.request.mock.calls).toHaveLength(2);

    const exhausted = setup();
    const noBudget = await allEvents({ ...exhausted.options, callBudget: 2 });
    expect(noBudget[0]).toMatchObject({
      type: "card_discovery",
      discovery: { cards: [{ last4: "1234" }] },
    });
    expect(noBudget.at(-1)).toMatchObject({
      type: "failure",
      fatal: true,
      failure: { code: "budget_exhausted" },
    });
    expect(exhausted.request.mock.calls).toHaveLength(2);
  });

  it("does not emit discovery for malformed suffixes or secret-bearing card metadata", async () => {
    for (const card of [
      { ...firstCard, cardSuffix: "991234" },
      { ...firstCard, cardSuffix: " 1234" },
      { ...firstCard, cardGuid: "synthetic-password" },
      { ...firstCard, ...{ cardName: "synthetic-password" } },
    ]) {
      const { options, request } = setup([card]);
      const result = await allEvents(options);
      expect(result.every((event) => event.type === "failure")).toBe(true);
      expect(request.mock.calls).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain(
        options.credentials.password,
      );
      expect(JSON.stringify(result)).not.toContain(
        options.credentials.cardSuffix,
      );
    }
  });

  it("spaces request starts by the interval, so slow responses add no wait", async () => {
    const { options, request, sleep, clock } = setup([firstCard]);
    const respond = request.getMockImplementation()!;
    // Each response takes 600 ms; one in the middle takes 1500 ms.
    let index = 0;
    request.mockImplementation(async (...args) => {
      clock.now += index++ === 2 ? 1500 : 600;
      return respond(...args);
    });
    await allEvents(options);
    const waits = sleep.mock.calls.map(([milliseconds]) => milliseconds);
    expect(waits).toHaveLength(request.mock.calls.length - 2);
    expect(waits.every((milliseconds) => milliseconds === 400)).toBe(true);
  });

  it("keeps the spacing when the wall clock jumps forward", async () => {
    const { options, sleep } = setup([firstCard]);
    delete options.now;
    let wall = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (wall += 5000));
    try {
      await allEvents(options);
    } finally {
      spy.mockRestore();
    }
    expect(sleep.mock.calls.length).toBeGreaterThan(0);
    expect(sleep.mock.calls.every(([milliseconds]) => milliseconds > 900)).toBe(
      true,
    );
  });

  it("collects open and just-closed periods, calls legacy once per month, and keeps exact source text without login", async () => {
    const { options, request, transport, sleep } = setup([
      firstCard,
      secondCard,
    ]);
    const result = await events(options);
    const captures = result.filter((event) => event.type === "capture");
    expect(result.filter((event) => event.type === "failure")).toEqual([]);
    expect(captures).toHaveLength(4);
    expect(captures.map(({ capture }) => capture.scope?.month)).toEqual([
      "2040-08",
      "2040-08",
      "2040-07",
      "2040-07",
    ]);
    expect(
      request.mock.calls.filter(
        ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.legacy,
      ),
    ).toHaveLength(2);
    expect(
      request.mock.calls.filter(
        ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.login,
      ),
    ).toHaveLength(1);
    expect(request.mock.calls).toHaveLength(8);
    expect(
      request.mock.calls
        .filter(([endpoint]) => endpoint === ISRACARD_ENDPOINTS.transactions)
        .map(([, body]) => body),
    ).toEqual([
      expect.objectContaining({
        billingMonth: "01/08/2040",
        isNextBillingDate: true,
      }),
      expect.objectContaining({
        billingMonth: "01/08/2040",
        isNextBillingDate: true,
      }),
      expect.objectContaining({
        billingMonth: "01/07/2040",
        isNextBillingDate: false,
      }),
      expect.objectContaining({
        billingMonth: "01/07/2040",
        isNextBillingDate: false,
      }),
    ]);
    expect(sleep.mock.calls).toEqual(
      Array.from({ length: 7 }, () => [1000, undefined]),
    );
    for (const { capture } of captures) {
      const envelope = JSON.parse(capture.responseText) as {
        responses: { digital: string; legacy: string };
        legacyCardIndex: string;
        isNextBillingDate: boolean;
      };
      expect(envelope.isNextBillingDate).toBe(
        capture.scope?.month === "2040-08",
      );
      expect(envelope.responses.digital).toBe(digitalText);
      expect(envelope.responses.legacy).toContain("CardsTransactionsListBean");
      expect(envelope.legacyCardIndex).toMatch(/^[01]$/);
      expect(capture.responseText).not.toContain("synthetic-password");
      expect(capture.responseText).not.toContain("Sisma");
    }
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["current next period", {}, "2040-08", true],
    ["last period", {}, "2040-07", false],
    ["another historical month", {}, "2040-06", false],
    [
      "absent period",
      { cardChargeNext: { billingDate: "10/08/2040" } },
      "2040-08",
      false,
    ],
    [
      "null period",
      { cardChargeNext: { billingDate: "10/08/2040", period: null } },
      "2040-08",
      false,
    ],
    [
      "numeric period",
      { cardChargeNext: { billingDate: "10/08/2040", period: 1 } },
      "2040-08",
      false,
    ],
    [
      "lowercase period",
      { cardChargeNext: { billingDate: "10/08/2040", period: "next" } },
      "2040-08",
      false,
    ],
    [
      "padded period",
      { cardChargeNext: { billingDate: "10/08/2040", period: " Next " } },
      "2040-08",
      false,
    ],
    [
      "unknown period",
      { cardChargeNext: { billingDate: "10/08/2040", period: "Future" } },
      "2040-08",
      false,
    ],
    [
      "Last literal in next field",
      { cardChargeNext: { billingDate: "10/08/2040", period: "Last" } },
      "2040-08",
      false,
    ],
    [
      "Next literal in last field",
      { cardChargeLast: { billingDate: "10/07/2040", period: "Next" } },
      "2040-07",
      true,
    ],
    [
      "malformed next date",
      { cardChargeNext: { billingDate: "31/02/2040", period: "Next" } },
      "2040-02",
      false,
    ],
    [
      "missing next date",
      { cardChargeNext: { period: "Next" } },
      "2040-08",
      false,
    ],
    [
      "same-month next precedence",
      { cardChargeLast: { billingDate: "20/08/2040", period: "Last" } },
      "2040-08",
      true,
    ],
    [
      "same-month unknown next precedence",
      {
        cardChargeNext: { billingDate: "10/08/2040" },
        cardChargeLast: { billingDate: "20/08/2040", period: "Next" },
      },
      "2040-08",
      false,
    ],
  ])(
    "uses the discovered request period during history: %s",
    async (_label, change, month, expected) => {
      const { options, request } = setup([{ ...firstCard, ...change }]);
      const result = await events({
        ...options,
        range: { from: `${month}-01`, to: `${month}-01` },
      });
      expect(result.every((event) => event.type === "capture")).toBe(true);
      expect(request.mock.calls).toHaveLength(4);
      expect(
        request.mock.calls.find(
          ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.transactions,
        )?.[1],
      ).toMatchObject({
        billingMonth: `01/${month.slice(5)}/${month.slice(0, 4)}`,
        isNextBillingDate: expected,
      });
      const capture = result.find((event) => event.type === "capture")!;
      expect(JSON.parse(capture.capture.responseText).isNextBillingDate).toBe(
        expected,
      );
    },
  );

  it("keeps Next approvals verbatim through the financial capture and credential guards", async () => {
    const raw =
      ' {"isSuccess":true,"data":{"approvals":{"approvedTransactions":[{"confirmationNumber":"SYN:40:50","originalAmount":1.23000000000000001}]}}}\n';
    for (const reflected of [false, true]) {
      const { options, request } = setup();
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (endpoint, body) => {
        if (
          endpoint === ISRACARD_ENDPOINTS.transactions &&
          (body as { isNextBillingDate: boolean }).isNextBillingDate
        ) {
          const text = reflected
            ? raw.replace("SYN:40:50", options.credentials.password)
            : raw;
          return financial(JSON.parse(text), text);
        }
        return original(endpoint, body);
      });
      const result = await events(options);
      if (reflected) {
        expect(result.every((event) => event.type === "failure")).toBe(true);
        expect(request.mock.calls).toHaveLength(3);
        expect(JSON.stringify(result)).not.toContain(
          options.credentials.password,
        );
      } else {
        const capture = result.find((event) => event.type === "capture")!;
        expect(JSON.parse(capture.capture.responseText)).toMatchObject({
          isNextBillingDate: true,
          responses: { digital: raw },
        });
      }
    }
  });

  it("flushes successful DigitalV3 evidence before stopping on legacy 429, with no next month or retry", async () => {
    const { options, request } = setup();
    request.mockImplementation(async (endpoint) => {
      if (endpoint === ISRACARD_ENDPOINTS.login) {
        return financial({ status: "1" });
      }
      if (endpoint === ISRACARD_ENDPOINTS.cards) {
        return financial({ data: { cardsList: [firstCard] } });
      }
      if (endpoint === ISRACARD_ENDPOINTS.legacy) {
        throw new IsracardTransportError("rate_limited");
      }
      return financial(JSON.parse(digitalText) as object, digitalText);
    });
    const result = await events(options);
    expect(result.map((event) => event.type)).toEqual([
      "capture",
      "failure",
      "failure",
    ]);
    expect(result[1]).toMatchObject({
      fatal: false,
      failure: { code: "rate_limited", endpoint: ISRACARD_ENDPOINTS.legacy },
    });
    expect(result[2]).toMatchObject({
      fatal: true,
      failure: {
        code: "rate_limited",
        accountKey: null,
        scope: { kind: "recent" },
      },
    });
    expect(request.mock.calls).toHaveLength(4);
  });

  it("enforces call budget while retaining earlier cards, and closes when the consumer stops", async () => {
    const { options, request, transport } = setup([firstCard, secondCard]);
    const result = await events({ ...options, callBudget: 3 });
    expect(result.map((event) => event.type)).toEqual([
      "capture",
      "failure",
      "failure",
    ]);
    expect(result[1]).toMatchObject({
      fatal: false,
      failure: { code: "budget_exhausted" },
    });
    expect(result[2]).toMatchObject({
      fatal: true,
      failure: {
        code: "budget_exhausted",
        accountKey: null,
        scope: { kind: "recent" },
      },
    });
    expect(request.mock.calls).toHaveLength(3);
    expect(transport.close).toHaveBeenCalledOnce();
    const next = setup();
    for await (const _event of collectIsracard(next.options)) {
      break;
    }
    expect(next.transport.close).toHaveBeenCalledOnce();
    expect(next.request.mock.calls).toHaveLength(2);
  });

  it("bounds history before login and uses calendar month arithmetic", async () => {
    expect(
      isracardHistoryMonths({ from: "2039-12-31", to: "2040-02-29" }),
    ).toEqual(["2039-12", "2040-01", "2040-02"]);
    const { options, request } = setup();
    for (const range of [
      { from: "2040-02-30", to: "2040-03-01" },
      { from: "2040-01-01", to: "2041-01-01" },
    ]) {
      expect(await events({ ...options, range })).toMatchObject([
        {
          type: "failure",
          failure: { code: "invalid_response" },
          fatal: false,
        },
        { type: "failure", failure: { code: "invalid_response" }, fatal: true },
      ]);
    }
    expect(request).not.toHaveBeenCalled();
    const result = await events({
      ...options,
      range: { from: "2040-01-15", to: "2040-02-02" },
    });
    expect(
      result
        .filter((event) => event.type === "capture")
        .map(({ capture }) => capture.scope),
    ).toEqual([
      expect.objectContaining({ kind: "history", month: "2040-01" }),
      expect.objectContaining({ kind: "history", month: "2040-02" }),
    ]);
  });

  it("rejects ambiguous DigitalV3 suffix addressing and preserves ambiguous legacy evidence without binding", async () => {
    const collision = setup([
      firstCard,
      { ...secondCard, cardSuffix: firstCard.cardSuffix },
    ]);
    expect(await allEvents(collision.options)).toMatchObject([
      { type: "failure", failure: { code: "invalid_response" } },
      { type: "failure", failure: { code: "invalid_response" } },
    ]);
    expect(collision.request.mock.calls).toHaveLength(2);
    const legacyCollision = setup();
    const original = legacyCollision.request.getMockImplementation()!;
    legacyCollision.request.mockImplementation(async (endpoint) =>
      endpoint === ISRACARD_ENDPOINTS.legacy
        ? financial({
            Header: { Status: "1" },
            CardsTransactionsListBean: {
              cardNumberList: ["1234", "1234", "1234"],
              Index0: {},
              Index1: {},
              Index2: {},
            },
          })
        : original(endpoint),
    );
    const result = await events(legacyCollision.options);
    for (const event of result) {
      if (event.type !== "capture") {
        continue;
      }
      const envelope = JSON.parse(event.capture.responseText) as {
        legacyCardIndex?: string;
        responses: { legacy: string };
      };
      expect(envelope.legacyCardIndex).toBeUndefined();
      expect(envelope.responses.legacy).toContain("Index2");
    }
  });

  it("never archives reflected secrets, including escaped JSON strings", async () => {
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint) =>
      endpoint === ISRACARD_ENDPOINTS.transactions
        ? financial(
            { isSuccess: true, reflected: "synthetic-password" },
            '{"isSuccess":true,"reflected":"synthetic-\\u0070assword"}',
          )
        : original(endpoint),
    );
    const result = await events(options);
    expect(result).toMatchObject([
      { type: "failure", failure: { code: "invalid_response" }, fatal: false },
      {
        type: "failure",
        failure: { code: "invalid_response", scope: { kind: "recent" } },
        fatal: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
  });

  it.each(["value", "key", "cookie"] as const)(
    "rejects quote/backslash secrets reflected in decoded %s without archiving or diagnostics",
    async (location) => {
      const { options, request, transport } = setup();
      const password = 'synthetic-"quoted"\\password';
      const session = 'synthetic-"session"\\cookie';
      const secret = location === "cookie" ? session : password;
      const message =
        location === "key" ? { [secret]: "ordinary" } : { message: secret };
      const payload = { isSuccess: true, data: { notices: [message] } };
      const responseText = JSON.stringify(payload);
      // Raw substring checks alone cannot detect JSON escaping of these values.
      expect(responseText).not.toContain(secret);
      transport.containsAuthMaterial = (value) => value.includes(session);
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (endpoint) =>
        endpoint === ISRACARD_ENDPOINTS.transactions
          ? financial(payload, responseText)
          : original(endpoint),
      );
      const result = await events({
        ...options,
        credentials: { ...options.credentials, password },
      });
      expect(result.every((event) => event.type === "failure")).toBe(true);
      expect(result.at(-1)).toMatchObject({
        type: "failure",
        fatal: true,
        failure: { code: "invalid_response" },
      });
      const diagnostics = JSON.stringify(result);
      expect(diagnostics).not.toContain("quoted");
      expect(diagnostics).not.toContain("session");
      expect(diagnostics).not.toContain("cookie");
      expect(request.mock.calls).toHaveLength(3);
    },
  );

  it("keeps all legacy card evidence if an optional detail fails, and caps successful details", async () => {
    const { options, request } = setup([firstCard, secondCard]);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint) => {
      if (endpoint === ISRACARD_ENDPOINTS.details) {
        throw new IsracardTransportError("authentication_challenge");
      }
      return original(endpoint);
    });
    const result = await events({ ...options, maxDetails: 1 });
    expect(result.map((event) => event.type)).toEqual([
      "capture",
      "capture",
      "failure",
      "failure",
    ]);
    expect(result.at(-1)).toMatchObject({
      fatal: true,
      failure: { code: "authentication_challenge" },
    });
    const detailFailure = result.find(
      (event) =>
        event.type === "failure" &&
        event.failure.endpoint === ISRACARD_ENDPOINTS.details,
    )!;
    expect(detailFailure).toMatchObject({
      failure: { affectsCoverage: false },
    });
    expect(result.at(-1)).not.toHaveProperty("failure.affectsCoverage");
    for (const event of result) {
      if (event.type === "capture") {
        expect(event.capture.responseText).toContain(
          "CardsTransactionsListBean",
        );
      }
    }
    const successful = setup();
    await events({ ...successful.options, maxDetails: 1 });
    expect(
      successful.request.mock.calls.filter(
        ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.details,
      ),
    ).toHaveLength(1);
  });

  it("collects opt-in voucher-bound details into useful enrichment without changing purchase money", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/card-month-numeric.json", import.meta.url),
        "utf8",
      ),
    ) as { responses: { digital: string; legacy: string } };
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint, body, query) => {
      if (endpoint === ISRACARD_ENDPOINTS.transactions) {
        return financial(
          JSON.parse(fixture.responses.digital),
          fixture.responses.digital,
        );
      }
      if (endpoint === ISRACARD_ENDPOINTS.legacy) {
        return financial(
          JSON.parse(fixture.responses.legacy),
          fixture.responses.legacy,
        );
      }
      if (endpoint === ISRACARD_ENDPOINTS.details) {
        return financial({
          Header: { Status: "1" },
          PirteyIska_204Bean: {
            voucherNumberRatz: query!.shovarRatz,
            transactionType: "Apple Pay",
            address: "Synthetic collected street",
            phoneNumber: "SYNTHETIC-COLLECTED-PHONE",
          },
        });
      }
      return original(endpoint, body, query);
    });
    const [event] = await events({
      ...options,
      maxDetails: 1,
      range: { from: "2040-07-01", to: "2040-07-31" },
    });
    expect(event?.type).toBe("capture");
    if (event?.type !== "capture") {
      return;
    }
    const result = extractIsracard(event.capture.responseText, {
      accountKey: event.capture.accountKey,
      runId: "synthetic-detail-run",
      scope: event.capture.scope!,
    });
    const purchase = result.transactions.find((row) =>
      row.sourceKey.includes("000123456"),
    )!;
    expect(purchase).toMatchObject({
      kind: "purchase",
      amountBasis: "purchase_commitment",
      amountMinor: -8640,
      currency: "ILS",
      wallet: "apple_pay",
      details: {
        merchant: {
          address: "Synthetic collected street",
          phone: "SYNTHETIC-COLLECTED-PHONE",
        },
      },
    });
    expect(purchase.details.sourceRefs).toContainEqual({
      runId: "synthetic-detail-run",
      path: "$.responses.details[0].responseText.PirteyIska_204Bean",
    });
    expect(
      request.mock.calls.find(
        ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.details,
      )?.[2],
    ).toEqual({ CardIndex: "0", shovarRatz: "000123456", moedChiuv: "072040" });
  });

  it.each([false, true])(
    "keeps optional reauthentication failures separate from coverage (unfinished=%s)",
    async (unfinished) => {
      const { options, request } = setup();
      const session: IsracardSession = {};
      await events({ ...options, session });
      request.mockClear();
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (endpoint, body, query) => {
        if (endpoint === ISRACARD_ENDPOINTS.details) {
          throw new IsracardTransportError("authentication_failed");
        }
        if (endpoint === ISRACARD_ENDPOINTS.login) {
          throw new IsracardTransportError("authentication_challenge");
        }
        return original(endpoint, body, query);
      });
      const result = await events({
        ...options,
        session,
        maxDetails: 1,
        ...(!unfinished
          ? { range: { from: "2040-07-01", to: "2040-07-31" } }
          : {}),
      });
      const failures = result.filter((event) => event.type === "failure");
      expect(failures[0]).toMatchObject({
        failure: {
          endpoint: ISRACARD_ENDPOINTS.login,
          code: "authentication_challenge",
          affectsCoverage: false,
        },
      });
      expect(failures).toHaveLength(unfinished ? 2 : 1);
      if (unfinished) {
        expect(failures[1]).not.toHaveProperty("failure.affectsCoverage");
      }
      expect(
        request.mock.calls.filter(
          ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.login,
        ),
      ).toHaveLength(1);
    },
  );

  it("stops after three consecutive backend failures rather than spending the full call budget", async () => {
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint) => {
      if (
        endpoint === ISRACARD_ENDPOINTS.transactions ||
        endpoint === ISRACARD_ENDPOINTS.legacy
      ) {
        throw new IsracardTransportError("network_error", false);
      }
      return original(endpoint);
    });
    const result = await events({
      ...options,
      range: { from: "2040-01-01", to: "2040-04-01" },
    });
    expect(request.mock.calls).toHaveLength(5);
    expect(result).toHaveLength(4);
    expect(result.at(-1)).toMatchObject({
      fatal: true,
      failure: {
        code: "network_error",
        accountKey: null,
        scope: { kind: "history", from: "2040-01-01", to: "2040-04-01" },
      },
    });
  });

  it("continues other discovered cards when one has no proven billing dates", async () => {
    const { options, request } = setup([
      firstCard,
      { ...secondCard, cardChargeNext: { billingDate: "unknown" } },
    ]);
    const result = await events(options);
    expect(result[0]).toMatchObject({
      type: "failure",
      fatal: false,
      failure: {
        accountKey: 'isracard:card:["11","5678"]',
        code: "invalid_response",
      },
    });
    expect(result.filter((event) => event.type === "capture")).toHaveLength(2);
    expect(request.mock.calls).toHaveLength(6);
  });

  it("archives the login identity number as a marker and still binds legacy cards", async () => {
    const { options, request } = setup();
    const identity = "012345678";
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint) => {
      const result = await original(endpoint);
      if (endpoint !== ISRACARD_ENDPOINTS.legacy) {
        return result;
      }
      const bean = result.payload.CardsTransactionsListBean as object;
      // Invented statement shape: holder fields and a key name repeat the ID.
      const payload = {
        ...result.payload,
        CardsTransactionsListBean: {
          ...bean,
          userId: identity,
          card0: [{ holderId: identity }],
          [`id${identity}`]: [{ currentId: identity }],
        },
      };
      return financial(payload);
    });
    const result = await events({
      ...options,
      credentials: { ...options.credentials, username: identity },
    });
    const captures = result.flatMap((event) =>
      event.type === "capture" ? [event.capture] : [],
    );
    expect(result.every((event) => event.type === "capture")).toBe(true);
    expect(captures).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(identity);
    for (const capture of captures) {
      const envelope = JSON.parse(capture.responseText) as {
        legacyCardIndex?: string;
        responses: { legacy: string };
      };
      expect(envelope.legacyCardIndex).toBe("0");
      expect(envelope.responses.legacy).toContain(
        '"userId":"[redacted-identity-number]"',
      );
      expect(envelope.responses.legacy).toContain(
        '"id[redacted-identity-number]"',
      );
    }
  });

  it("rejects a reflected password that contains the identity number before redaction", async () => {
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint) =>
      endpoint === ISRACARD_ENDPOINTS.transactions
        ? financial({ isSuccess: true, data: { message: "p000123456!" } })
        : original(endpoint),
    );
    const result = await events({
      ...options,
      credentials: {
        ...options.credentials,
        username: "000123456",
        password: "p000123456!",
      },
    });
    expect(result.every((event) => event.type === "failure")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("000123456");
  });

  it.each([
    ["a voucher", { seqVoucherNumber: "012345678" }],
    ["an unrecognized field", { message: "012345678" }],
    ["a padded holder field", { holderId: " 012345678" }],
  ])(
    "rejects the identity number in %s instead of redacting financial evidence",
    async (_label, row) => {
      const { options, request } = setup();
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (endpoint) =>
        endpoint === ISRACARD_ENDPOINTS.transactions
          ? financial({ isSuccess: true, data: { rows: [row] } })
          : original(endpoint),
      );
      const result = await events({
        ...options,
        credentials: { ...options.credentials, username: "012345678" },
      });
      expect(result.every((event) => event.type === "failure")).toBe(true);
      expect(result.at(-1)).toMatchObject({
        fatal: true,
        failure: { code: "invalid_response" },
      });
      expect(JSON.stringify(result)).not.toContain("012345678");
    },
  );

  it("rejects a numeric identity reflection that redaction would make invalid", async () => {
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint) =>
      endpoint === ISRACARD_ENDPOINTS.transactions
        ? financial(
            { isSuccess: true, data: { holder: 12345678 } },
            '{"isSuccess":true,"data":{"holder":12345678}}',
          )
        : original(endpoint),
    );
    const result = await events({
      ...options,
      credentials: { ...options.credentials, username: "12345678" },
    });
    expect(result.every((event) => event.type === "failure")).toBe(true);
    expect(result.at(-1)).toMatchObject({
      fatal: true,
      failure: { code: "invalid_response" },
    });
    expect(JSON.stringify(result)).not.toContain("12345678");
  });

  it("does not mistake a numeric credential substring in a longer voucher for reflected credentials", async () => {
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint) =>
      endpoint === ISRACARD_ENDPOINTS.transactions
        ? financial({
            isSuccess: true,
            data: { voucher: "8899123477", holderReference: "0044556677800" },
          })
        : original(endpoint),
    );
    const result = await events({
      ...options,
      credentials: { ...options.credentials, username: "445566778" },
    });
    expect(result.every((event) => event.type === "capture")).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("rejects exact numeric credential reflection and invalid GUIDs before financial calls", async () => {
    const direct = setup();
    const original = direct.request.getMockImplementation()!;
    direct.request.mockImplementation(async (endpoint) =>
      endpoint === ISRACARD_ENDPOINTS.transactions
        ? financial({ isSuccess: true, data: { message: "991234" } })
        : original(endpoint),
    );
    expect(
      (await events(direct.options)).every((event) => event.type === "failure"),
    ).toBe(true);
    const malformed = setup([{ ...firstCard, cardGuid: "invalid\u0000guid" }]);
    const result = await events(malformed.options);
    expect(malformed.request.mock.calls).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "failure",
      fatal: false,
      failure: { endpoint: ISRACARD_ENDPOINTS.cards, code: "invalid_response" },
    });
    expect(result.at(-1)).toMatchObject({
      type: "failure",
      fatal: true,
      failure: { endpoint: "isracard:card-month" },
    });
  });

  it("reserves all remaining financial calls before optional details", async () => {
    const constrained = setup();
    const tight = await events({
      ...constrained.options,
      callBudget: 6,
      maxDetails: 20,
    });
    expect(tight.every((event) => event.type === "capture")).toBe(true);
    expect(constrained.request.mock.calls).toHaveLength(6);
    expect(
      constrained.request.mock.calls.filter(
        ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.details,
      ),
    ).toHaveLength(0);
    const spare = setup();
    const enough = await events({
      ...spare.options,
      callBudget: 7,
      maxDetails: 20,
    });
    expect(enough.every((event) => event.type === "capture")).toBe(true);
    expect(spare.request.mock.calls).toHaveLength(7);
    expect(
      spare.request.mock.calls.filter(
        ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.details,
      ),
    ).toHaveLength(1);
  });

  it("skips statement artifacts and ambiguous legacy vouchers before spending detail calls", async () => {
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint, body, query) => {
      if (endpoint !== ISRACARD_ENDPOINTS.legacy) {
        return original(endpoint, body, query);
      }
      const result = await original(endpoint, body, query);
      const bean = result.payload.CardsTransactionsListBean as {
        Index0: { CurrentCardTransactions: unknown[] };
      };
      bean.Index0.CurrentCardTransactions = [
        {
          txnIsrael: [
            { voucherNumberRatz: "111", dealSumType: "T" },
            { voucherNumberRatz: "222", dealSumType: 1 },
            { voucherNumberRatz: "000" },
            { voucherNumberRatz: "333" },
            { voucherNumberRatz: "444" },
            { voucherNumberRatz: "555", dealSumType: "01" },
          ],
          txnAbroad: [
            { voucherNumberRatzOutbound: "333" },
            { voucherNumberRatzOutbound: "666", dealSumType: "T" },
          ],
          txnInfo: [{ voucherNumberRatz: "777" }],
        },
      ];
      return financial(result.payload);
    });
    await events({
      ...options,
      maxDetails: 20,
      range: { from: "2040-07-01", to: "2040-07-31" },
    });
    expect(
      request.mock.calls
        .filter(([endpoint]) => endpoint === ISRACARD_ENDPOINTS.details)
        .map(([, , query]) => query),
    ).toEqual([
      { CardIndex: "0", shovarRatz: "444", moedChiuv: "072040" },
      { CardIndex: "0", shovarRatz: "555", moedChiuv: "072040" },
      { CardIndex: "0", shovarRatz: "666", moedChiuv: "072040" },
    ]);
  });

  it("continues bounded optional detail attempts after nonfatal failures without failing mandatory coverage", async () => {
    const { options, request } = setup();
    const original = request.getMockImplementation()!;
    let attempts = 0;
    request.mockImplementation(async (endpoint, body, query) => {
      if (endpoint === ISRACARD_ENDPOINTS.details) {
        attempts++;
        if (attempts <= 3) {
          throw new IsracardTransportError("network_error", false);
        }
      }
      if (endpoint === ISRACARD_ENDPOINTS.legacy) {
        const result = await original(endpoint, body, query);
        const bean = result.payload.CardsTransactionsListBean as {
          Index0: { CurrentCardTransactions: unknown[] };
        };
        bean.Index0.CurrentCardTransactions = [
          {
            txnIsrael: ["111", "222", "333", "444"].map(
              (voucherNumberRatz) => ({ voucherNumberRatz }),
            ),
            txnAbroad: [],
          },
        ];
        return financial(result.payload);
      }
      return original(endpoint, body, query);
    });
    const result = await events({ ...options, maxDetails: 4 });
    expect(attempts).toBe(4);
    expect(result.filter((event) => event.type === "capture")).toHaveLength(2);
    expect(result.filter((event) => event.type === "failure")).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          failure: expect.objectContaining({
            endpoint: ISRACARD_ENDPOINTS.details,
            affectsCoverage: false,
          }),
          fatal: false,
        }),
      ),
    );
    const captures = result.filter((event) => event.type === "capture");
    expect(
      captures.map(
        (event) =>
          JSON.parse(event.capture.responseText).responses.details?.length ?? 0,
      ),
    ).toEqual([1, 0]);
  });

  it.each([
    [8, 0],
    [9, 1],
  ])(
    "reserves reused-session reauthentication while detail cap uses budget %s",
    async (callBudget, expectedDetails) => {
      const { options, request } = setup();
      const session: IsracardSession = {};
      await events({ ...options, session });
      request.mockClear();
      const original = request.getMockImplementation()!;
      let rejected = false;
      request.mockImplementation(async (endpoint, body, query) => {
        if (
          endpoint === ISRACARD_ENDPOINTS.transactions &&
          (body as { billingMonth: string }).billingMonth === "01/08/2040" &&
          !rejected
        ) {
          rejected = true;
          throw new IsracardTransportError("authentication_failed");
        }
        return original(endpoint, body, query);
      });
      const result = await events({
        ...options,
        session,
        callBudget,
        maxDetails: 20,
      });
      expect(result.every((event) => event.type === "capture")).toBe(true);
      expect(result).toHaveLength(2);
      expect(request.mock.calls).toHaveLength(callBudget);
      expect(
        request.mock.calls.filter(
          ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.details,
        ),
      ).toHaveLength(expectedDetails);
      expect(
        request.mock.calls.filter(
          ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.login,
        ),
      ).toHaveLength(1);
      expect(session.logins).toBe(2);
    },
  );

  it("keeps the default 24-call ceiling even for a valid twelve-month backfill", async () => {
    const { options, request } = setup();
    const result = await events({
      ...options,
      range: { from: "2040-01-01", to: "2040-12-31" },
    });
    expect(request.mock.calls).toHaveLength(24);
    expect(result.filter((event) => event.type === "capture")).toHaveLength(11);
    expect(result.at(-1)).toMatchObject({
      type: "failure",
      fatal: true,
      failure: {
        code: "budget_exhausted",
        scope: { kind: "history", from: "2040-01-01", to: "2040-12-31" },
      },
    });
  });

  it("reports financial failures after companion captures and keeps final optional failures separate", async () => {
    const partial = setup();
    const original = partial.request.getMockImplementation()!;
    partial.request.mockImplementation(async (endpoint) => {
      if (endpoint === ISRACARD_ENDPOINTS.transactions) {
        throw new IsracardTransportError("network_error", false);
      }
      return original(endpoint);
    });
    const result = await events({
      ...partial.options,
      range: { from: "2040-07-01", to: "2040-07-31" },
    });
    expect(result.map((event) => event.type)).toEqual(["capture", "failure"]);
    const enrichment = setup();
    const ordinary = enrichment.request.getMockImplementation()!;
    enrichment.request.mockImplementation(async (endpoint) => {
      if (endpoint === ISRACARD_ENDPOINTS.details) {
        throw new IsracardTransportError("authentication_challenge");
      }
      return ordinary(endpoint);
    });
    const final = await events({
      ...enrichment.options,
      maxDetails: 1,
      range: { from: "2040-07-01", to: "2040-07-31" },
    });
    expect(final.map((event) => event.type)).toEqual(["capture", "failure"]);
    expect(final.at(-1)).toMatchObject({
      type: "failure",
      fatal: false,
      failure: {
        endpoint: ISRACARD_ENDPOINTS.details,
        accountKey: expect.any(String),
      },
    });
  });
});

describe("Isracard sessions across collections", () => {
  const months = ["2040-05", "2040-06", "2040-07"].map((month) => ({
    from: `${month}-01`,
    to: `${month}-28`,
  }));

  /** Collects each month in turn on one session, as one refresh's backfill does. */
  async function backfill(options: CollectIsracardOptions) {
    const session: IsracardSession = {};
    const failures: CollectionEvent[] = [];
    for (const range of months) {
      for (const event of await allEvents({ ...options, session, range })) {
        if (event.type === "failure") {
          failures.push(event);
        }
      }
    }
    return { session, failures };
  }

  const logins = (request: ReturnType<typeof setup>["request"]) =>
    request.mock.calls.filter(
      ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.login,
    ).length;

  it("logs in once for a three-month backfill and paces requests across months", async () => {
    const { request, options, clock } = setup();
    const starts: number[] = [];
    const ordinary = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint, ...rest) => {
      starts.push(clock.now);
      return ordinary(endpoint, ...rest);
    });
    const { session, failures } = await backfill(options);
    expect(failures).toEqual([]);
    expect(logins(request)).toBe(1);
    expect(
      request.mock.calls.filter(
        ([endpoint]) => endpoint === ISRACARD_ENDPOINTS.cards,
      ),
    ).toHaveLength(3);
    // Every request starts a full interval after the previous one.
    expect(
      starts.slice(1).map((start, index) => start - starts[index]!),
    ).toEqual(starts.slice(1).map(() => 1_000));
    expect(session.transport).toBe(options.transport);
  });

  it("logs in again exactly once when Isracard rejects the session", async () => {
    const { request, options, transport } = setup();
    const ordinary = request.getMockImplementation()!;
    let cardLists = 0;
    request.mockImplementation(async (endpoint, ...rest) => {
      // The second month's first request meets an expired session.
      if (endpoint === ISRACARD_ENDPOINTS.cards && ++cardLists === 2) {
        throw new IsracardTransportError("authentication_failed");
      }
      return ordinary(endpoint, ...rest);
    });
    const { failures } = await backfill(options);
    expect(failures).toEqual([]);
    expect(logins(request)).toBe(2);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("retries a request once on a new session when a reused one expires mid-month", async () => {
    const { request, options } = setup();
    const ordinary = request.getMockImplementation()!;
    let digital = 0;
    request.mockImplementation(async (endpoint, ...rest) => {
      if (endpoint === ISRACARD_ENDPOINTS.transactions && ++digital === 2) {
        throw new IsracardTransportError("authentication_failed");
      }
      return ordinary(endpoint, ...rest);
    });
    const { failures } = await backfill(options);
    expect(failures).toEqual([]);
    expect(logins(request)).toBe(2);
    // The new session lists its cards before the retried request.
    const sequence = request.mock.calls.map(([endpoint]) => endpoint);
    const second = sequence.lastIndexOf(ISRACARD_ENDPOINTS.login);
    expect(sequence.slice(second, second + 3)).toEqual([
      ISRACARD_ENDPOINTS.login,
      ISRACARD_ENDPOINTS.cards,
      ISRACARD_ENDPOINTS.transactions,
    ]);
  });

  it("logs in at most twice in one execution, however often Isracard rejects", async () => {
    const { request, options } = setup();
    const ordinary = request.getMockImplementation()!;
    let cardLists = 0;
    request.mockImplementation(async (endpoint, ...rest) => {
      if (endpoint === ISRACARD_ENDPOINTS.cards && ++cardLists >= 2) {
        throw new IsracardTransportError("authentication_failed");
      }
      return ordinary(endpoint, ...rest);
    });
    const { failures } = await backfill(options);
    expect(failures.length).toBeGreaterThan(0);
    // The initial login and one more; later months fail without a password attempt.
    expect(logins(request)).toBe(2);
  });

  it("forgets a new session rejected during a month, so the next month logs in", async () => {
    const { request, options } = setup();
    const ordinary = request.getMockImplementation()!;
    let digital = 0;
    request.mockImplementation(async (endpoint, ...rest) => {
      if (endpoint === ISRACARD_ENDPOINTS.transactions && ++digital === 1) {
        throw new IsracardTransportError("authentication_failed");
      }
      return ordinary(endpoint, ...rest);
    });
    const { failures } = await backfill(options);
    expect(failures.length).toBeGreaterThan(0);
    expect(logins(request)).toBe(2);
  });
});

describe("Isracard billing accounts and the card-list projection", () => {
  const raw = readFileSync(
    new URL("./fixtures/card-list-accounts.json", import.meta.url),
    "utf8",
  );
  const source = JSON.parse(raw);

  it("discovers each card's billing account by its private provider key and a mask with leading zeros", async () => {
    const { options } = setup(source.data.cardsList);
    const [discovery] = await allEvents(options);
    expect(discovery).toEqual({
      type: "card_discovery",
      discovery: {
        observedAt: expect.any(String),
        cards: [
          {
            cardKey: 'isracard:card:["11","1234"]',
            last4: "1234",
            displayName: "Synthetic Everyday",
            billingAccount: { providerKey: "99|123|000042", mask: "0042" },
          },
          {
            cardKey: 'isracard:card:["77","5678"]',
            last4: "5678",
            displayName: "Synthetic Travel",
            billingAccount: { providerKey: "99|123|000042", mask: "0042" },
          },
          {
            cardKey: 'isracard:card:["11","9012"]',
            last4: "9012",
            displayName: "Synthetic Spare",
            billingAccount: { providerKey: "98|456|777000013", mask: "0013" },
          },
        ],
      },
    });
    expect(JSON.stringify(discovery)).not.toMatch(/Synthetic (First|Last)/);
  });

  it("leaves billing accounts unknown when account fields are missing or malformed", async () => {
    const partial = source.data.cardsList.map(
      (card: Record<string, unknown>, index: number) =>
        index === 0
          ? { ...card, branch: "" }
          : index === 1
            ? { ...card, accountNumber: 42 }
            : { ...card, bank: "9|9" },
    );
    const [incomplete] = await allEvents(setup(partial).options);
    expect(JSON.stringify(incomplete)).not.toContain("billingAccount");
  });

  it("leaves the mask null when the account number does not end in four digits", async () => {
    const lettered = source.data.cardsList.map(
      (card: Record<string, unknown>) => ({ ...card, accountNumber: "0042AB" }),
    );
    const [discovery] = await allEvents(setup(lettered).options);
    expect(discovery).toMatchObject({
      discovery: {
        cards: [
          { billingAccount: { providerKey: "99|123|0042AB", mask: null } },
          { billingAccount: { providerKey: "99|123|0042AB", mask: null } },
          { billingAccount: { providerKey: "98|456|0042AB", mask: null } },
        ],
      },
    });
  });

  it("archives only the allowlisted card list, which still binds every capture", async () => {
    const { options } = setup(source.data.cardsList);
    const captures = (await allEvents(options)).flatMap((event) =>
      event.type === "capture" ? [event.capture] : [],
    );
    expect(captures.length).toBeGreaterThan(0);
    let extracted = 0;
    for (const capture of captures) {
      const cardList = JSON.parse(
        JSON.parse(capture.responseText).responses.cardList,
      );
      expect(cardList.isSuccess).toBe(true);
      for (const card of cardList.data.cardsList) {
        expect(Object.keys(card).sort()).toEqual([
          "billingAccount",
          "cardGuid",
          "cardName",
          "cardSuffix",
          "companyCode",
        ]);
        expect(Object.keys(card.billingAccount).sort()).toEqual([
          "mask",
          "providerKey",
        ]);
      }
      expect(capture.responseText).not.toMatch(
        /Synthetic (First|Last)|firstName|lastName|limitData|"bank"|"branch"|accountNumber|isPartner/,
      );
      const result = isracardAdapter.extract(capture.responseText, {
        accountKey: capture.accountKey,
        runId: "synthetic",
        endpoint: capture.endpoint,
        ...(capture.scope ? { scope: capture.scope } : {}),
      });
      expect(result.warnings).not.toContain("invalid_card_or_scope_binding");
      extracted += result.transactions.length;
    }
    expect(extracted).toBeGreaterThan(0);
  });

  it("projects an old raw card list for replay without holder names", () => {
    const projected = JSON.parse(projectIsracardCardList(raw));
    expect(projected.data.cardsList[0]).toEqual({
      companyCode: "11",
      cardSuffix: "1234",
      cardGuid: "SYNTHETIC-ACCOUNT-GUID-A",
      cardName: "Synthetic Everyday",
      billingAccount: { providerKey: "99|123|000042", mask: "0042" },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /Synthetic (First|Last)|limitData|"bank"/,
    );
  });
  it("returns an already projected card list unchanged", () => {
    const projected = projectIsracardCardList(raw);
    expect(projectIsracardCardList(projected)).toBe(projected);
  });
});

describe("Isracard billing accounts through collection", () => {
  it("links both shared-account cards to one depository account with a mask", async () => {
    const source = JSON.parse(
      readFileSync(
        new URL("./fixtures/card-list-accounts.json", import.meta.url),
        "utf8",
      ),
    );
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({ id: "synthetic", provider: "isracard" });
      const { options } = setup(source.data.cardsList);
      await collectFromStore(
        db,
        { connectionId: "synthetic", debugArchiveDays: 2 },
        {
          provider: "isracard",
          collectorVersion: "synthetic-v1",
          collect: (request) => collectIsracard({ ...options, ...request }),
        },
        isracardAdapter,
      );
      const accounts = (await db.listAccounts({ connectionId: "synthetic" }))
        .accounts;
      expect(accounts).toHaveLength(2);
      expect(
        accounts.find((account) => account.providerKey === "99|123|000042"),
      ).toMatchObject({
        type: "depository",
        institutionName: null,
        mask: "0042",
        displayName: null,
      });
      const cards = (await db.listCards({ connectionId: "synthetic" })).cards;
      const billing = (suffix: string) =>
        cards.find((card) => card.last4 === suffix)?.billingAccountId;
      expect(billing("1234")).toBe(billing("5678"));
      expect(billing("1234")).not.toBe(billing("9012"));
      expect(accounts.map((account) => account.id).sort()).toEqual(
        [billing("1234"), billing("9012")].sort(),
      );
      const transactions = await db.listTransactions({
        connectionId: "synthetic",
        billingAccountId: billing("1234")!,
      });
      expect(transactions.length).toBeGreaterThan(0);
      expect(
        transactions.every((row) =>
          cards.some(
            (card) =>
              card.id === row.cardId &&
              card.billingAccountId === billing("1234"),
          ),
        ),
      ).toBe(true);
      const archived = (
        await db.client.execute("SELECT snapshot_json FROM sync_run_bodies")
      ).rows.map((row) => String(row.snapshot_json));
      expect(archived.length).toBeGreaterThan(0);
      for (const snapshot of archived) {
        expect(snapshot).not.toMatch(/Synthetic First|limitData/);
      }
    } finally {
      await db.close();
    }
  });
});
