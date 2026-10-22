import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/domain/model.js";
import { collectCal } from "../../src/providers/cal/collect.js";
import {
  mergeCalEvidence,
  retainCalEvidence,
} from "../../src/providers/cal/evidence.js";
import { extractCal } from "../../src/providers/cal/extract.js";
import {
  CAL_ENDPOINTS,
  createCalTransport,
} from "../../src/providers/cal/transport.js";
import {
  type IsracardCapture,
  isracardCardKey,
} from "../../src/providers/isracard/capture.js";
import { collectIsracard } from "../../src/providers/isracard/collect.js";
import {
  mergeIsracardEvidence,
  retainIsracardEvidence,
} from "../../src/providers/isracard/evidence.js";
import { extractIsracard } from "../../src/providers/isracard/extract.js";
import {
  createIsracardTransport,
  ISRACARD_ENDPOINTS,
  type IsracardHttpResponse,
} from "../../src/providers/isracard/transport.js";

const credentials = {
  username: "synthetic-username",
  password: "synthetic-password",
};

interface TransportScenario {
  text?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: "stalled" | "malformed";
  stalledClient?: boolean;
  login?: boolean;
  failure?: Error;
  signal?: AbortSignal;
  limits?: { timeoutMs?: number; maxResponseBytes?: number };
  /** Keep the provider's default retry budget instead of a single attempt. */
  retries?: boolean;
}

function calTransport(scenario: TransportScenario) {
  const close = vi.fn();
  const request = vi.fn<typeof fetch>(async () => {
    if (scenario.failure) {
      throw scenario.failure;
    }
    if (scenario.stalledClient) {
      return new Promise<Response>(() => {});
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (scenario.body === "stalled") {
            return;
          }
          controller.enqueue(
            scenario.body === "malformed"
              ? new Uint8Array([0xff])
              : new TextEncoder().encode(scenario.text ?? ""),
          );
          // Leave the stream open: refusal must cancel it, rather than rely on EOF.
        },
        cancel: close,
      }),
      { status: scenario.status ?? 200, headers: scenario.headers ?? {} },
    );
  });
  const transport = createCalTransport({
    fetch: request,
    ...(scenario.signal ? { signal: scenario.signal } : {}),
    limits: scenario.retries
      ? { ...scenario.limits }
      : { ...scenario.limits, maxAttempts: 1 },
  });
  return {
    request,
    close,
    run: () =>
      transport.post(
        scenario.login ? CAL_ENDPOINTS.login : CAL_ENDPOINTS.init,
        {},
      ),
  };
}

function isracardTransport(scenario: TransportScenario) {
  const close = vi.fn();
  const request = vi.fn(async (): Promise<IsracardHttpResponse> => {
    if (scenario.failure) {
      throw scenario.failure;
    }
    if (scenario.stalledClient) {
      return new Promise<IsracardHttpResponse>(() => {});
    }
    return {
      status: scenario.status ?? 200,
      headers: scenario.headers ?? {},
      body:
        scenario.body === "stalled"
          ? {
              [Symbol.asyncIterator]() {
                return {
                  next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
                };
              },
            }
          : (async function* () {
              yield scenario.body === "malformed"
                ? new Uint8Array([0xff])
                : new TextEncoder().encode(scenario.text ?? "");
            })(),
      close,
    };
  });
  const transport = createIsracardTransport({
    httpClient: { request },
    ...(scenario.signal ? { signal: scenario.signal } : {}),
    ...(scenario.limits ? { limits: scenario.limits } : {}),
  });
  return {
    request,
    close,
    run: () =>
      transport.request(
        scenario.login ? ISRACARD_ENDPOINTS.login : ISRACARD_ENDPOINTS.cards,
        {},
      ),
  };
}

function calDiscovery(displayName: unknown) {
  return collectCal({
    credentials,
    fetch: vi.fn<typeof fetch>(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input) === CAL_ENDPOINTS.login
              ? { token: "synthetic-token" }
              : {
                  statusCode: 1,
                  result: {
                    bankAccounts: [
                      { bankAccountUniqueId: "SYNTHETIC-ACCOUNT-A" },
                    ],
                    cards: [
                      {
                        cardUniqueId: "SYNTHETIC-CARD-A",
                        bankAccountUniqueId: "SYNTHETIC-ACCOUNT-A",
                        last4Digits: "0012",
                        cardDescription: displayName,
                      },
                    ],
                  },
                },
          ),
        ),
    ),
  });
}

function isracardDiscovery(displayName: unknown) {
  return collectIsracard({
    credentials: { ...credentials, cardSuffix: "991234" },
    httpClient: { request: vi.fn() },
    transport: {
      request: async (endpoint) => {
        const payload =
          endpoint === ISRACARD_ENDPOINTS.login
            ? { status: "1" }
            : {
                isSuccess: true,
                data: {
                  cardsList: [
                    {
                      companyCode: "11",
                      cardGuid: "SYNTHETIC-FIRST",
                      cardSuffix: "1234",
                      isActive: true,
                      isPartner: false,
                      cardChargeNext: {
                        billingDate: "10/08/2040",
                        period: "Next",
                      },
                      cardChargeLast: {
                        billingDate: "10/07/2040",
                        period: "Last",
                      },
                      cardName: displayName,
                    },
                  ],
                },
              };
        return {
          payload,
          responseText: JSON.stringify(payload),
          httpStatus: 200,
        };
      },
      containsAuthMaterial: () => false,
      close() {},
    },
  });
}

function calDeclaration() {
  const row = {
    cardUniqueID: "SYNTHETIC-CARD",
    transactionID: "SYNTHETIC-AUTH",
    merchantName: "Synthetic shop",
    internationalBranchID: "5411",
    trnTypeCode: "5",
    transCardPresentInd: false,
    walletTranInd: "0",
    numberOfPayments: "0",
    trnCurrencySymbol: "₪",
    trnPurchaseDate: "2040-06-11T11:00:00",
  };
  const source = {
    ...row,
    trnAmt: 10,
    comments: [{ key: "Synthetic note", value: null, nested: { noise: true } }],
    paymentsMade: [
      {
        date: "2040-07-01",
        num: "1",
        amount: 10,
        currency: "₪",
        noise: { nested: true },
      },
    ],
    futureField: { nested: true },
  };
  const result = extractCal(
    JSON.stringify({
      statusCode: 1,
      result: { transactions: [], clearanceRequests: [source] },
    }),
    {
      accountKey: "synthetic-account",
      runId: "synthetic-run",
    },
  );
  return {
    transactions: result.transactions,
    fresh: result.transactions[0]!.details.provider.cal!,
    legacy: {
      rows: [
        {
          ...source,
          trnAmt: "10",
          paymentsMade: [
            {
              date: "2040-07-01",
              num: "1",
              amount: "10",
              currency: "₪",
              noise: "discard",
            },
          ],
        },
      ],
      identity: { baseKey: "synthetic-derived" },
      currencyMapping: "derived",
    },
    expected: {
      rows: [
        {
          ...row,
          trnAmt: "10",
          comments: [{ key: "Synthetic note", value: null }],
          paymentsMade: [
            { date: "2040-07-01", num: "1", amount: "10", currency: "₪" },
          ],
        },
      ],
    },
  };
}

function isracardDeclaration() {
  const capture = JSON.parse(
    readFileSync(
      new URL("./isracard/fixtures/card-month.json", import.meta.url),
      "utf8",
    ),
  ) as IsracardCapture;
  const digital = JSON.parse(capture.responses.digital!) as {
    data: {
      israelAbroadVouchers: {
        vouchers: { israelAbroadVouchersList: JsonObject[] };
      };
    };
  };
  const first =
    digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0]!;
  first.future = { nested: true };
  first.discountAmount = { nested: true };
  capture.responses.digital = JSON.stringify(digital);
  const result = extractIsracard(JSON.stringify(capture), {
    accountKey: isracardCardKey(capture.card),
    runId: "synthetic-run",
    scope: {
      kind: capture.mode,
      month: capture.billingMonth,
      cardKey: isracardCardKey(capture.card),
    },
  });
  const fresh = result.transactions[0]!.details.provider.isracard!;
  return {
    transactions: result.transactions,
    fresh,
    legacy: {
      ...fresh,
      rows: (fresh.rows as JsonObject[]).map((row) => ({
        ...row,
        future: { nested: true },
      })),
      billingMonth: "2040-08",
    },
    expected: {
      rows: [
        {
          purchaseDate: "11/06/2040",
          purchaseTime: "12:30:00",
          businessName: "Synthetic merchant",
          businessNumber: "SYNTHETIC-MERCHANT",
          cityDescription: "Synthetic City",
          countryCode: "IL",
          countryDescription: "Israel",
          isIsraelDeal: true,
          transactionCode: "1",
          transactionDescription: "Synthetic unmapped transaction description",
          billingAmount: "86.4",
          billingAmountCurrency: "0",
          originalAmount: "86.4",
          originalCurrencyIso: "ILS",
          tranzacCodeType: "1",
          tranzacCodeDescription: "Synthetic channel",
          presentCard: false,
          isTransactionSecure: true,
          isWalletTransaction: false,
          isdirectDebit: false,
          currentInstallmentNum: null,
          numberOfInstallment: null,
          voucherNumber: "DISPLAY-ONLY",
          seqVoucherNumber: "VOUCHER-1",
          discountAmount: {},
        },
        {
          fullPurchaseDate: "11/06/2040",
          fullPaymentDate: "10/07/2040",
          fullSupplierNameHeb: "Synthetic legacy merchant",
          voucherNumberRatz: "VOUCHER-1",
          voucherNumber: "DO-NOT-JOIN",
          dealSum: "86.4",
          paymentSum: "86.4",
          currencyId: "ILS",
          currentPaymentCurrency: "ILS",
        },
      ],
      detail: {
        voucherNumberRatz: "VOUCHER-1",
        address: "1 Synthetic Street",
        phoneNumber: "SYNTHETIC-PHONE",
        transactionType: "Synthetic detail channel",
        purchaseTime: "12:30:00",
      },
    },
  };
}

function calComponent(num: string, amount: string) {
  return {
    cardUniqueId: "SYNTHETIC-CARD",
    trnIntId: "SYNTHETIC-PLAN",
    curPaymentNum: num,
    amtBeforeConvAndIndex: amount,
  };
}

function isracardComponent(voucher: string, amount: string) {
  return {
    seqVoucherNumber: voucher,
    purchaseDate: "01/06/2040",
    billingAmount: amount,
  };
}

const providers = [
  {
    name: "CAL",
    discover: calDiscovery,
    last4: "0012",
    transport: calTransport,
    declaration: calDeclaration,
    retain: retainCalEvidence,
    merge: mergeCalEvidence,
    mergeFixture: () => ({
      first: {
        rows: [calComponent("1", "10")],
        retained: {
          comments: [
            { key: "Synthetic", value: "note" },
            { key: "Synthetic", value: "note" },
          ],
        },
      },
      second: {
        rows: [calComponent("2", "11")],
        retained: { comments: [{ value: "note", key: "Synthetic" }] },
      },
      // Rows replayed without aggregate evidence must not disturb it either.
      replays: [{ rows: [calComponent("1", "10")] }],
      correction: {
        rows: [calComponent("2", "12")],
      },
      mergedCount: 2,
      correctedRows: [calComponent("1", "10"), calComponent("2", "12")],
    }),
    scalarCases: [
      {
        input: { rows: [{ trnAmt: "0.2900", merchantId: null }] },
        expected: { rows: [{ trnAmt: "0.2900", merchantId: null }] },
      },
      {
        input: { rows: [{ trnAmt: "0.29" }] },
        expected: { rows: [{ trnAmt: "0.29" }] },
      },
    ],
    timeoutError: { code: "network_error" },
  },
  {
    name: "Isracard",
    discover: isracardDiscovery,
    last4: "1234",
    transport: isracardTransport,
    declaration: isracardDeclaration,
    retain: retainIsracardEvidence,
    merge: mergeIsracardEvidence,
    mergeFixture: () => ({
      first: {
        rows: [
          isracardComponent("1", "10"),
          {
            voucherNumberRatz: "1",
            fullPurchaseDate: "01/06/2040",
            paymentSum: "10",
          },
        ],
        detail: { voucherNumberRatz: "1", walletPayName: "Apple Pay" },
      },
      second: {
        rows: [isracardComponent("2", "20")],
      },
      correction: {
        rows: [isracardComponent("2", "21"), isracardComponent("2", "21")],
      },
      mergedCount: 3,
      correctedRows: [
        isracardComponent("1", "10"),
        isracardComponent("2", "21"),
        isracardComponent("2", "21"),
        {
          voucherNumberRatz: "1",
          fullPurchaseDate: "01/06/2040",
          paymentSum: "10",
        },
      ],
    }),
    scalarCases: [
      {
        input: { rows: { unknown: "discard" }, detail: null },
        expected: { rows: {}, detail: null },
      },
      { input: {}, expected: {} },
    ],
    timeoutError: { code: "network_error", fatal: true },
  },
];

describe.each(providers)("$name shared provider contracts", (provider) => {
  it.each([
    undefined,
    null,
    "",
    "x".repeat(129),
    "Synthetic\nCard",
    "4111 1111 1111 1111",
  ])("omits invalid display name %j from discovery", async (displayName) => {
    const collection = provider.discover(displayName);
    try {
      const event = (await collection.next()).value;
      expect(event).toMatchObject({
        type: "card_discovery",
        discovery: { cards: [{ last4: provider.last4 }] },
      });
      expect(JSON.stringify(event)).not.toContain('"displayName"');
    } finally {
      await collection.return(undefined);
    }
  });

  it("applies the same recursive declaration to legacy evidence and fresh extraction", () => {
    const { transactions, fresh, legacy, expected } = provider.declaration();
    expect(transactions.length).toBeGreaterThan(0);
    const projected = provider.retain(legacy);
    expect(projected).toEqual(expected);
    // Fresh CAL extraction also declares aggregate evidence outside rows.
    expect(provider.retain(fresh)).toMatchObject(expected);
    expect(provider.retain(fresh).rows).toEqual(expected.rows);
    for (const key of [
      "identity",
      "currencyMapping",
      "observations",
      "billingMonth",
      "monetaryEvidence",
    ]) {
      expect(projected).not.toHaveProperty(key);
    }
    expect(JSON.stringify(fresh)).not.toContain("nested");
    expect(JSON.stringify(projected)).not.toContain("futureField");
  });

  it("preserves explicit null independently of an absent field", () => {
    for (const { input, expected } of provider.scalarCases) {
      expect(provider.retain(input as JsonObject)).toEqual(expected);
    }
  });

  it("merges overlapping components quietly and replaces a correction", () => {
    const fixture = provider.mergeFixture();
    const { first, second, correction, mergedCount, correctedRows } = fixture;
    const merged = provider.merge(first, second);
    expect(merged.rows).toHaveLength(mergedCount);
    expect(
      provider.retain(provider.merge(provider.merge(merged, first), second)),
    ).toEqual(provider.retain(merged));
    const corrected = provider.merge(merged, correction);
    expect(corrected.rows).toEqual(correctedRows);
    expect(provider.retain(provider.merge(corrected, first))).toEqual(
      provider.retain(corrected),
    );
    for (const replay of "replays" in fixture ? fixture.replays : []) {
      expect(provider.retain(provider.merge(corrected, replay))).toEqual(
        provider.retain(corrected),
      );
    }
  });

  it.each([
    {
      text: "a".repeat(200),
      headers: { "content-length": "1" },
      maxResponseBytes: 100,
    },
    { text: "a".repeat(200), headers: {}, maxResponseBytes: 100 },
    { text: '{"isSuccess":true}', headers: {}, maxResponseBytes: 8 },
  ])(
    "caps streamed bytes with $maxResponseBytes bytes and headers $headers",
    async ({ text, headers, maxResponseBytes }) => {
      const { run, request, close } = provider.transport({
        text,
        headers,
        limits: { maxResponseBytes },
        // An oversized body is final even when the budget allows retries.
        retries: true,
      });
      const result = run();
      await expect(result).rejects.toMatchObject({ code: "invalid_response" });
      await expect(result).rejects.toThrow("invalid_response");
      expect(request).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("rejects malformed UTF8 and closes the response", async () => {
    const { run, close } = provider.transport({
      body: "malformed",
      limits: { maxResponseBytes: 8 },
    });
    await expect(run()).rejects.toMatchObject({ code: "invalid_response" });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([5, 10])(
    "keeps a %i ms timeout through stalled client and body reading",
    async (timeoutMs) => {
      for (const stalledClient of [true, false]) {
        const { run, request, close } = provider.transport({
          stalledClient,
          body: "stalled",
          limits: { timeoutMs },
        });
        const result = run();
        await expect(result).rejects.toMatchObject(provider.timeoutError);
        await expect(result).rejects.toThrow("network_error");
        expect(request).toHaveBeenCalledOnce();
        if (!stalledClient) {
          expect(close).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("stops body reading on caller abort without reflecting its reason", async () => {
    const controller = new AbortController();
    const { run, request, close } = provider.transport({
      body: "stalled",
      signal: controller.signal,
    });
    const result = run();
    const timer = setTimeout(() => controller.abort(credentials.password), 10);
    try {
      const error = await result.catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "network_error" });
      expect(String(error)).not.toContain(credentials.password);
      expect(request).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(timer);
    }
  });

  it.each([undefined, credentials.password])(
    "does not send already-aborted requests or reflect abort reason %j",
    async (reason) => {
      const { run, request } = provider.transport({
        signal: AbortSignal.abort(reason),
        login: true,
      });
      const error = await run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "network_error" });
      expect(String(error)).not.toContain(credentials.password);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 429, 302])(
    "bounds HTTP refusal %i to one configured attempt without reflecting response text",
    async (status) => {
      for (const text of [
        '{"isSuccess":true}',
        '{"isSuccess":true,"reflected":"private-password"}',
      ]) {
        const { run, request, close } = provider.transport({
          text,
          status,
          headers:
            status === 302 ? { location: "https://private.invalid" } : {},
        });
        const error = await run().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain("private");
        expect(request).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
      }
    },
  );

  it("sanitizes client exceptions without reflecting request secrets", async () => {
    const { run, request } = provider.transport({
      login: true,
      failure: new Error(
        "SYNTHETIC-USER-SECRET SYNTHETIC-PASSWORD-SECRET SYNTHETIC-AUTH-TOKEN-SECRET",
      ),
    });
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).not.toContain("SECRET");
    expect(request).toHaveBeenCalledOnce();
  });
});
