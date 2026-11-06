import { describe, expect, it } from "vitest";

import { endpointReport, shapeReport } from "../../scripts/har-profile.mjs";

const canaries = [
  "canary-password",
  "canary-token",
  "canary-merchant",
  "1111222233334444",
  "canary-cookie",
  "abc123def456ghi789",
];

function entry(method, url, { post, response, mimeType, status = 200 } = {}) {
  return {
    request: {
      method,
      url,
      headers: [
        { name: "Authorization", value: "Bearer canary-token" },
        { name: "Cookie", value: "session=canary-cookie" },
      ],
      ...(post === undefined
        ? {}
        : { postData: { mimeType: "application/json", text: post } }),
    },
    response: {
      status,
      headers: [{ name: "Set-Cookie", value: "session=canary-cookie" }],
      content: { mimeType: mimeType ?? "application/json", ...response },
    },
  };
}

const har = {
  log: {
    entries: [
      entry("GET", "https://cdn.example.invalid/logo.png", {
        mimeType: "image/png",
      }),
      entry("CONNECT", "metrics.example.invalid:443"),
      entry("POST", "https://api.example.invalid/auth/login", {
        post: '{"username":"synthetic","password":"canary-password"}',
        response: { text: '{"token":"canary-token"}' },
      }),
      entry(
        "POST",
        "https://api.example.invalid/cards/1111222233334444/rows?month=07",
        {
          post: '{"accountId":"00123456"}',
          response: {
            text: JSON.stringify({
              rows: [
                { amount: 1, code: "7", merchant: "canary-merchant" },
                { code: "long-code-value", id1111222233334444: "x" },
              ],
            }).replace('"amount":1', '"amount":12.50'),
          },
        },
      ),
      entry("GET", "https://api.example.invalid/session/abc123def456ghi789"),
      entry("POST", "https://api.example.invalid/cards/1111222233334444/rows", {
        response: {
          encoding: "base64",
          text: Buffer.from('{"rows":[]}').toString("base64"),
        },
      }),
    ],
  },
};

describe("HAR profile", () => {
  it("lists endpoints in first-seen order with masked paths and no static files", () => {
    const lines = endpointReport(har).split("\n");

    expect(lines).toEqual([
      "#1\tx1\t200\tjson\tauth,cookie,sets-cookie\tCONNECT metrics.example.invalid",
      "#2\tx1\t200\tjson\tauth,cookie,sets-cookie\tPOST api.example.invalid/auth/login",
      "#3\tx1\t200\tjson\tauth,cookie,sets-cookie\tPOST api.example.invalid/cards/<id>/rows?month",
      "#4\tx1\t200\tjson\tauth,cookie,sets-cookie\tGET api.example.invalid/session/<id>",
      "#5\tx1\t200\tjson\tauth,cookie,sets-cookie\tPOST api.example.invalid/cards/<id>/rows",
    ]);
  });

  it("reports presence and value classes, including base64 bodies", () => {
    const lines = shapeReport(har, "/rows", ["code"]).split("\n");

    expect(lines).toContain("$.rows[].amount\t1/2\tnumber(2dp):1");
    expect(lines).toContain("$.rows\t2/2\tarray:2");
    expect(lines).toContain("$.accountId\t1/1\tdigits(8,leading-zero):1");
    expect(lines).toContain("$.month\t1/1\tdigits(2,leading-zero):1");
    expect(lines[0]).toBe(
      "matches 2; statuses 200:2; responses without a parsed body 0",
    );
  });

  it("prints requested short codes and withholds every longer value", () => {
    const report = shapeReport(har, "/rows", ["code", "merchant"]);

    expect(report).toContain('"7"=1');
    expect(report).toContain("<too long>=1");
    expect(report).not.toContain("long-code-value");
  });

  it("reduces media types to fixed categories", () => {
    const report = {
      log: {
        entries: [
          entry("POST", "https://api.example.invalid/a", {
            mimeType: "application/x-canary-token",
          }),
        ],
      },
    };
    report.log.entries[0].request.postData = {
      mimeType: "application/x-canary-token",
      text: "{}",
    };

    const output = `${endpointReport(report)}\n${shapeReport(report, "/a")}`;

    expect(output).not.toContain("canary-token");
    expect(output).toContain("request content types: other");
  });

  it("skips unusable entries and tolerates missing content", () => {
    const sparse = {
      log: {
        entries: [
          { response: { status: 200 } },
          null,
          {
            request: { method: "GET", url: "https://api.example.invalid/a" },
            response: { status: 204, content: null },
          },
        ],
      },
    };

    expect(endpointReport(sparse)).toContain(
      "2 entries with an unparsable URL",
    );
    expect(shapeReport(sparse, "/a").split("\n")[0]).toBe(
      "matches 1; statuses 204:1; responses without a parsed body 1",
    );
  });

  it("counts every occurrence of a repeated query key", () => {
    const repeated = {
      log: {
        entries: [entry("GET", "https://api.example.invalid/a?code=A&code=B")],
      },
    };

    const report = shapeReport(repeated, "/a", ["code"]);

    expect(report).toContain('"A"=1 "B"=1');
  });

  it("tolerates null headers and keeps a query key named like a prototype", () => {
    const odd = {
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://api.example.invalid/a?__proto__=A&__proto__=B",
              headers: [null],
            },
          },
        ],
      },
    };

    expect(endpointReport(odd)).toContain("GET api.example.invalid/a");
    expect(shapeReport(odd, "/a", ["__proto__"])).toContain('"A"=1 "B"=1');
  });

  it("never prints a body value, header value or identifier inside a name", () => {
    const report = [
      endpointReport(har),
      shapeReport(har, "/login", ["password", "token"]),
      shapeReport(har, "/rows", ["id1111222233334444"]),
    ].join("\n");

    for (const canary of canaries) {
      expect(report).not.toContain(canary);
    }
    expect(report).toContain("$.rows[].id<n>");
  });
});
