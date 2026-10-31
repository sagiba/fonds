import { describe, expect, it, vi } from "vitest";

import {
  CAL_ENDPOINTS,
  type CalTransportDiagnostic,
  createCalTransport,
} from "../../../src/providers/cal/transport.js";

describe("safe CAL transport diagnostics", () => {
  it.each([
    [
      new Response("<html>private-password private-account</html>", {
        headers: { "Content-Type": "text/html; private-secret=value" },
      }),
      "rate_limited",
      "json_parse",
      "html",
    ],
    [
      new Response("{private-malformed", {
        headers: { "Content-Type": "application/json" },
      }),
      "rate_limited",
      "json_parse",
      "json",
    ],
    // The observed refusal: an HTML 400 to a login with valid credentials.
    [
      new Response("<html>private-password</html>", {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }),
      "rate_limited",
      "http_status",
      "html",
    ],
    [
      Response.json({ private: "private-secret" }, { status: 400 }),
      "rate_limited",
      "http_status",
      "json",
    ],
    [
      new Response(null, { status: 400 }),
      "rate_limited",
      "http_status",
      "other",
    ],
    [
      new Response("private-unavailable", { status: 503 }),
      "rate_limited",
      "http_status",
      "other",
    ],
    [
      new Response("<html>private-secret</html>", {
        status: 429,
        headers: { "Content-Type": "text/html" },
      }),
      "rate_limited",
      "http_status",
      "html",
    ],
    // An explicit credential rejection stays a hard failure at any status.
    [
      Response.json({
        statusCode: 2,
        statusDescription: "שם המשתמש או הסיסמה שהוזנו שגויים",
        private: "private-secret",
      }),
      "authentication_failed",
      "authentication",
      "json",
    ],
    [
      Response.json(
        {
          statusCode: 2,
          statusDescription: "שם המשתמש או הסיסמה שהוזנו שגויים",
          private: "private-secret",
        },
        { status: 400 },
      ),
      "authentication_failed",
      "authentication",
      "json",
    ],
    [
      Response.json(
        { result: { requiresOtp: true }, private: "private-secret" },
        { status: 400 },
      ),
      "authentication_challenge",
      "authentication",
      "json",
    ],
    [
      Response.json(["private-array-value"]),
      "invalid_response",
      "json_shape",
      "json",
    ],
    [
      Response.json({ requiresOtp: true, privateValue: "private-password" }),
      "authentication_challenge",
      "authentication",
      "json",
    ],
    [
      new Response("private-access-denied", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      }),
      "authentication_challenge",
      "http_status",
      "html",
    ],
    [
      new Response("private-credentials", { status: 401 }),
      "authentication_failed",
      "http_status",
      "other",
    ],
    [
      new Response(null, {
        status: 302,
        headers: { Location: "https://private.invalid/private-account" },
      }),
      "invalid_response",
      "redirect",
      "other",
    ],
    [
      new Response('{"private-secret":1,"private-secret":1}', {
        headers: { "Content-Type": "application/json" },
      }),
      "invalid_response",
      "json_keys",
      "json",
    ],
    [
      new Response(new Uint8Array([0xff]), {
        headers: { "Content-Type": "application/json" },
      }),
      "invalid_response",
      "utf8_decode",
      "json",
    ],
  ] as const)(
    "classifies rejected responses without reflecting their contents (%s)",
    async (response, outcome, stage, contentType) => {
      const diagnostics: CalTransportDiagnostic[] = [];
      const transport = createCalTransport({
        fetch: vi.fn(async () => response),
        onDiagnostic: (entry) => {
          diagnostics.push(entry);
        },
      });
      await expect(
        transport.post(CAL_ENDPOINTS.login, {
          username: "private-username",
          password: "private-password",
        }),
      ).rejects.toMatchObject({ code: outcome });
      expect(diagnostics).toEqual([
        {
          endpoint: "login",
          httpStatus: response.status,
          contentType,
          outcome,
          stage,
        },
      ]);
      for (const privateText of [
        "private-password",
        "private-username",
        "private-account",
        "private-secret",
        "private.invalid",
        "private-array-value",
        "Location",
      ]) {
        expect(JSON.stringify(diagnostics)).not.toContain(privateText);
      }
    },
  );

  it("reports successes, per-attempt server errors and accepted financial error envelopes accurately", async () => {
    const diagnostics: CalTransportDiagnostic[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ private: "server-message" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ result: { transactions: [] } }))
      .mockResolvedValueOnce(
        Response.json({ private: "financial-error-message" }, { status: 400 }),
      );
    const transport = createCalTransport({
      fetch,
      limits: { maxAttempts: 2, retryDelayMs: 1 },
      onDiagnostic: (entry) => {
        diagnostics.push(entry);
      },
    });
    await transport.post(
      CAL_ENDPOINTS.recent,
      { bankAccountUniqueID: "private-account" },
      "private-token",
    );
    await transport.post(CAL_ENDPOINTS.search, {}, "private-token");
    expect(diagnostics).toEqual([
      {
        endpoint: "recent",
        httpStatus: 503,
        contentType: "json",
        outcome: "network_error",
        stage: "http_status",
      },
      {
        endpoint: "recent",
        httpStatus: 200,
        contentType: "json",
        outcome: "success",
        stage: "complete",
      },
      {
        endpoint: "search",
        httpStatus: 400,
        contentType: "json",
        outcome: "invalid_response",
        stage: "http_status",
      },
    ]);
  });

  it("distinguishes failed fetch, timeout and endpoint-policy rejection using fixed labels only", async () => {
    const diagnostics: CalTransportDiagnostic[] = [];
    const observer = (entry: CalTransportDiagnostic) => {
      diagnostics.push(entry);
    };
    const fetch = vi.fn(async () => {
      throw new Error("private-token reflected URL https://private.invalid");
    });
    await expect(
      createCalTransport({ fetch, onDiagnostic: observer }).post(
        CAL_ENDPOINTS.login,
        {},
      ),
    ).rejects.toMatchObject({ code: "network_error" });
    await expect(
      createCalTransport({
        fetch: async () => new Promise<Response>(() => {}),
        limits: { timeoutMs: 1 },
        onDiagnostic: observer,
      }).post(CAL_ENDPOINTS.login, {}),
    ).rejects.toMatchObject({ code: "network_error" });
    await expect(
      createCalTransport({ fetch, onDiagnostic: observer }).post(
        "https://private.invalid/private-account",
        {},
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(diagnostics).toEqual([
      {
        endpoint: "login",
        httpStatus: null,
        contentType: "other",
        outcome: "network_error",
        stage: "request",
      },
      {
        endpoint: "login",
        httpStatus: null,
        contentType: "other",
        outcome: "network_error",
        stage: "timeout",
      },
      {
        endpoint: "unknown",
        httpStatus: null,
        contentType: "other",
        outcome: "invalid_response",
        stage: "endpoint_policy",
      },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never changes transport results when synchronous or asynchronous diagnostic logging fails", async () => {
    for (const observer of [
      () => {
        throw new Error("private-log-error");
      },
      async () => {
        throw new Error("private-async-log-error");
      },
    ]) {
      const transport = createCalTransport({
        fetch: async () => Response.json({ result: "synthetic" }),
        onDiagnostic: observer,
      });
      expect((await transport.post(CAL_ENDPOINTS.init, {})).httpStatus).toBe(
        200,
      );
    }
  });
});
