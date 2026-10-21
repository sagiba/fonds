import { describe, expect, it, vi } from "vitest";

import {
  createIsracardTransport,
  ISRACARD_ENDPOINTS,
  type IsracardHttpResponse,
  IsracardTransportError,
  parseIsracardObject,
  redactIsracardSecret,
} from "../../../src/providers/isracard/transport.js";

function response(
  text: string,
  status = 200,
  headers: IsracardHttpResponse["headers"] = {},
): IsracardHttpResponse {
  return {
    status,
    headers,
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
    close: vi.fn(),
  };
}

describe("Isracard bounded session transport", () => {
  it("uses the proven login content type, shares parent-domain cookies, and preserves exact financial text", async () => {
    const raw =
      ' {"isSuccess":true,"errorCode":"0","data":{"amount":1.23000000000000001}}\n';
    const login = response('{"status":"1","isCaptcha":"false"}', 200, {
      "set-cookie": [
        "authentication_shared=synthetic-session; Domain=.isracard.co.il; Path=/; Secure",
        "hostOnly=synthetic-host; Path=/",
        "wrong=synthetic-wrong; Domain=evil.invalid; Path=/",
        "narrow=synthetic-narrow; Domain=.isracard.co.il; Path=/services",
        "expired=synthetic-expired; Domain=.isracard.co.il; Path=/; Max-Age=0",
      ],
    });
    const cards = response(raw);
    const request = vi
      .fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(cards);
    const transport = createIsracardTransport({ httpClient: { request } });
    await transport.request(ISRACARD_ENDPOINTS.login, {
      Sisma: "never-logged",
    });
    expect(request.mock.calls[0]![0].headers["content-type"]).toBe(
      "application/x-www-form-urlencoded; charset=UTF-8",
    );
    expect(
      (await transport.request(ISRACARD_ENDPOINTS.cards, {})).responseText,
    ).toBe(raw);
    expect(request.mock.calls[1]![0].headers.cookie).toBe(
      "authentication_shared=synthetic-session",
    );
    expect(transport.containsAuthMaterial("value=synthetic-session")).toBe(
      true,
    );
    expect(login.close).toHaveBeenCalledOnce();
    expect(cards.close).toHaveBeenCalledOnce();
    transport.close();
    await expect(
      transport.request(ISRACARD_ENDPOINTS.cards, {}),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [
      "<html>private-password Just a moment</html>",
      200,
      {},
      "authentication_challenge",
    ],
    ['{"isSuccess":true}', 403, {}, "authentication_challenge"],
    ['{"isSuccess":true}', 429, {}, "rate_limited"],
    ['{"isSuccess":true}', 401, {}, "authentication_failed"],
    [
      '{"isSuccess":true}',
      200,
      { "cf-mitigated": "challenge" },
      "authentication_challenge",
    ],
    [
      '{"isSuccess":false,"errorCode":"private-message"}',
      200,
      {},
      "invalid_response",
    ],
    ['{"isSuccess":true,"isSuccess":true}', 200, {}, "invalid_response"],
    [
      '{"isSuccess":true,"isCaptcha":"true"}',
      200,
      {},
      "authentication_challenge",
    ],
    [
      '{"isSuccess":false,"sessionExpired":true}',
      200,
      {},
      "authentication_failed",
    ],
    [
      '{"isSuccess":false,"errorDescription":"Session expired"}',
      200,
      {},
      "authentication_failed",
    ],
    [
      '{"isSuccess":true}',
      302,
      { location: "https://private.invalid" },
      "invalid_response",
    ],
    ["", 200, {}, "invalid_response"],
  ] as const)(
    "rejects HTTP and application failures without retry or reflected errors (%s)",
    async (text, status, headers, code) => {
      const result = response(text, status, headers);
      const request = vi.fn(async () => result);
      const transport = createIsracardTransport({ httpClient: { request } });
      const error = await transport
        .request(ISRACARD_ENDPOINTS.cards, {})
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain("private");
      expect(request).toHaveBeenCalledOnce();
      expect(result.close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["successful", [undefined, null, 0, "0", ""], true],
    ["failed", [1, 13, 91, "1", "13", "unknown"], false],
  ] as const)(
    "classifies %s DigitalV3 root error codes on both endpoints",
    async (_name, codes, accepted) => {
      for (const errorCode of codes) {
        for (const endpoint of [
          ISRACARD_ENDPOINTS.cards,
          ISRACARD_ENDPOINTS.transactions,
        ]) {
          const request = vi.fn(async () =>
            response(JSON.stringify({ isSuccess: true, errorCode, data: {} })),
          );
          const transport = createIsracardTransport({
            httpClient: { request },
          });
          if (accepted) {
            await expect(
              transport.request(endpoint, {}),
            ).resolves.toMatchObject({
              payload: { isSuccess: true, data: {} },
            });
          } else {
            await expect(transport.request(endpoint, {})).rejects.toMatchObject(
              {
                code: "invalid_response",
                fatal: false,
              },
            );
          }
          expect(request).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("rejects invalid destinations and query parameters before I/O", async () => {
    const request = vi.fn();
    const transport = createIsracardTransport({ httpClient: { request } });
    await expect(
      transport.request("https://private.invalid/secret"),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      transport.request(ISRACARD_ENDPOINTS.legacy, undefined, {
        redirect: "123",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds streamed bytes and malformed UTF8, closing the response", async () => {
    for (const result of [
      response('{"isSuccess":true}'),
      {
        ...response(""),
        body: (async function* () {
          yield new Uint8Array([0xff]);
        })(),
      },
    ]) {
      await expect(
        createIsracardTransport({
          httpClient: { request: async () => result },
          limits: { maxResponseBytes: 8 },
        }).request(ISRACARD_ENDPOINTS.cards, {}),
      ).rejects.toMatchObject({ code: "invalid_response" });
      expect(result.close).toHaveBeenCalledOnce();
    }
  });

  it("times out a stalled client and stalled body, and honors an already-aborted signal", async () => {
    const stalled = {
      ...response(""),
      body: {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          };
        },
      },
    };
    for (const request of [
      async () => new Promise<IsracardHttpResponse>(() => {}),
      async () => stalled,
    ]) {
      await expect(
        createIsracardTransport({
          httpClient: { request },
          limits: { timeoutMs: 5 },
        }).request(ISRACARD_ENDPOINTS.cards, {}),
      ).rejects.toMatchObject({ code: "network_error", fatal: true });
    }
    expect(stalled.close).toHaveBeenCalledOnce();
    const request = vi.fn();
    await expect(
      createIsracardTransport({
        httpClient: { request },
        signal: AbortSignal.abort(),
      }).request(ISRACARD_ENDPOINTS.login, {}),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(request).not.toHaveBeenCalled();
  });

  it("never retries a password or treats a failed legacy status as an empty month", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response('{"status":"3"}'))
      .mockResolvedValueOnce(response('{"Header":{"Status":"0"}}'));
    const transport = createIsracardTransport({ httpClient: { request } });
    await expect(
      transport.request(ISRACARD_ENDPOINTS.login, {}),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      transport.request(ISRACARD_ENDPOINTS.legacy, undefined, {
        month: "07",
        year: "2040",
        requiredDate: "N",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not classify a merchant's ordinary text as a challenge", async () => {
    const result = response(
      '{"isSuccess":true,"data":{"businessName":"Just a moment cafe"}}',
    );
    await expect(
      createIsracardTransport({
        httpClient: { request: async () => result },
      }).request(ISRACARD_ENDPOINTS.transactions, {}),
    ).resolves.toMatchObject({
      responseText: expect.stringContaining("Just a moment cafe"),
    });
  });

  it("accepts numeric application status and error codes with the installed lossless parser API", async () => {
    const texts = [
      '{"status":1}',
      '{"isSuccess":true,"errorCode":0,"data":{"amount":123.45000}}',
      '{"Header":{"Status":1},"CardsTransactionsListBean":{}}',
    ];
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(texts[0]!))
      .mockResolvedValueOnce(response(texts[1]!))
      .mockResolvedValueOnce(response(texts[2]!));
    const transport = createIsracardTransport({ httpClient: { request } });
    expect(
      (await transport.request(ISRACARD_ENDPOINTS.login, {})).payload.status,
    ).toBe(1);
    const cards = await transport.request(ISRACARD_ENDPOINTS.cards, {});
    expect(cards.payload.errorCode).toBe(0);
    expect(cards.responseText).toBe(texts[1]);
    expect(
      (
        await transport.request(ISRACARD_ENDPOINTS.legacy, undefined, {
          month: "07",
          year: "2040",
          requiredDate: "N",
        })
      ).responseText,
    ).toBe(texts[2]);
  });

  it("ignores short benign cookies but protects short known sessions and long opaque unknown cookies", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response('{"status":"1"}', 200, {
          "set-cookie": [
            "lang=he; Path=/",
            "flag=1; Path=/",
            "preference=true; Path=/",
            "JSESSIONID=xyz; Path=/",
            "unknown=synthetic-opaque-cookie-123456; Path=/",
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(
          '{"isSuccess":true,"errorCode":0,"data":{"name":"he","flag":1,"enabled":true}}',
        ),
      );
    const transport = createIsracardTransport({ httpClient: { request } });
    await transport.request(ISRACARD_ENDPOINTS.login, {});
    const financial = await transport.request(ISRACARD_ENDPOINTS.cards, {});
    expect(transport.containsAuthMaterial(financial.responseText)).toBe(false);
    expect(transport.containsAuthMaterial('{"message":"xyz"}')).toBe(true);
    expect(
      transport.containsAuthMaterial("synthetic-opaque-cookie-123456"),
    ).toBe(true);
  });

  it("hard-stops explicit provider login redirects without following them", async () => {
    const request = vi.fn(async () =>
      response("", 302, {
        location: "https://digital.isracard.co.il/personalarea/Login/",
      }),
    );
    await expect(
      createIsracardTransport({ httpClient: { request } }).request(
        ISRACARD_ENDPOINTS.cards,
        {},
      ),
    ).rejects.toMatchObject({ code: "authentication_failed", fatal: true });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not register expired deletion markers as secrets and keeps previous real session values protected", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response('{"status":"1"}', 200, {
          "set-cookie": [
            "JSESSIONID=synthetic-real-session; Domain=.isracard.co.il; Path=/; Secure",
          ],
        }),
      )
      .mockResolvedValueOnce(
        response('{"isSuccess":true,"data":{"message":"deleted"}}', 200, {
          "set-cookie": [
            "JSESSIONID=deleted; Domain=.isracard.co.il; Path=/; Max-Age=0",
            "authentication_shared=expired; Domain=.isracard.co.il; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
          ],
        }),
      )
      .mockResolvedValueOnce(response('{"isSuccess":true,"data":{}}'));
    const transport = createIsracardTransport({ httpClient: { request } });
    await transport.request(ISRACARD_ENDPOINTS.login, {});
    const financial = await transport.request(ISRACARD_ENDPOINTS.cards, {});
    expect(transport.containsAuthMaterial(financial.responseText)).toBe(false);
    expect(transport.containsAuthMaterial("expired")).toBe(false);
    expect(transport.containsAuthMaterial("synthetic-real-session")).toBe(true);
    await transport.request(ISRACARD_ENDPOINTS.cards, {});
    expect(request.mock.calls[2]![0].headers.cookie).toBeUndefined();
  });

  it("redacts only whole numeric secrets and keeps longer digit runs", () => {
    expect(
      redactIsracardSecret(
        '{"holderId":"012345678","id012345678":[],"voucher":"90123456789","n":"0123456780"}',
        "012345678",
        "[marker]",
      ),
    ).toBe(
      '{"holderId":"[marker]","id[marker]":[],"voucher":"90123456789","n":"0123456780"}',
    );
    expect(redactIsracardSecret("a-b-a", "a", "[x]")).toBe("[x]-b-[x]");
    expect(redactIsracardSecret("unchanged", "", "[x]")).toBe("unchanged");
  });

  it("parses altered bodies with the transport's duplicate-key checks", () => {
    expect(parseIsracardObject('{"a":"1"}')).toEqual({ a: "1" });
    for (const text of ['{"a":1,"a":1}', '{"a":[marker]}', "[]"]) {
      expect(() => parseIsracardObject(text)).toThrow(IsracardTransportError);
    }
  });
});
