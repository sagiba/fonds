import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import type { Pool } from "pg";
import { it, vi } from "vitest";

import {
  finishGoogleLogin,
  type GoogleConfig,
  neonLoginPlugin,
  readLoginState,
  startGoogleLogin,
} from "../../../deploy/neon/neon-login.js";

// Passes through to the real signature check unless a step stands in for an
// authorization request the issuer signed but this test cannot.
const queryVerification = vi.hoisted(() => ({ assumeSigned: false }));
vi.mock("@better-auth/oauth-provider", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@better-auth/oauth-provider")>();
  return {
    ...original,
    verifyOAuthQueryParams: async (
      ...args: Parameters<typeof original.verifyOAuthQueryParams>
    ) =>
      queryVerification.assumeSigned ||
      original.verifyOAuthQueryParams(...args),
  };
});

const config: GoogleConfig = {
  baseURL: "https://mcp.example.com",
  upstreamURL: "https://auth.example.com/neondb/auth",
  allowedEmail: "owner@example.com",
  ownerId: "local-owner",
  secret: randomBytes(32).toString("hex"),
};
const redirect = "https://client.example.com/callback";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

function bridgePool() {
  const states = new Map<
    string,
    {
      state_hash: string;
      binding_hash: string;
      oauth_query: string;
      upstream_cookies: string;
      expires: number;
    }
  >();
  let identity: unknown[] | undefined;
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      const row = states.get(values[0] as string);
      if (sql.startsWith("INSERT INTO fonds_neon_login")) {
        states.set(values[0] as string, {
          state_hash: values[0] as string,
          binding_hash: values[1] as string,
          oauth_query: values[2] as string,
          upstream_cookies: "",
          expires: Date.now() + 600_000,
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE fonds_neon_login")) {
        row!.upstream_cookies = values[1] as string;
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("SELECT")) {
        return {
          rows:
            row && row.binding_hash === values[1] && row.expires > Date.now()
              ? [row]
              : [],
        };
      }
      if (
        sql.includes("DELETE FROM fonds_neon_login") &&
        sql.includes("RETURNING")
      ) {
        if (
          !row ||
          row.binding_hash !== values[1] ||
          row.expires <= Date.now()
        ) {
          return { rowCount: 0, rows: [] };
        }
        states.delete(values[0] as string);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes("DELETE FROM fonds_neon_login")) {
        if (sql.includes("state_hash")) {
          states.delete(values[0] as string);
        } else {
          for (const [key, s] of states) {
            if (s.expires <= Date.now()) {
              states.delete(key);
            }
          }
        }
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO fonds_neon_identity")) {
        if (identity && identity.slice(0, 4).some((v, i) => v !== values[i])) {
          return { rowCount: 0, rows: [] };
        }
        identity = values;
        return { rowCount: 1, rows: [{ local_user_id: values[0] }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, states, linked: () => identity };
}

it("authenticates through managed Neon Google and resumes local OAuth with a pinned owner identity", async () => {
  const step = async (_name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      throw new Error(_name, { cause: error });
    }
  };
  const store = bridgePool();
  const db: MemoryDB = {
    user: [
      {
        id: config.ownerId,
        name: "Owner",
        email: "owner@example.invalid",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    account: [],
    session: [],
    verification: [],
    jwks: [],
    oauthClient: [],
    oauthConsent: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthResource: [],
    oauthClientResource: [],
  };
  const auth = betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    database: memoryAdapter(db),
    trustedOrigins: [config.baseURL],
    logger: { disabled: true },
    plugins: [
      jwt(),
      neonLoginPlugin(store.pool, config),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: `${config.baseURL}/mcp`,
        scopes: ["openid", "profile", "offline_access", "financial:read"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }) as unknown as BetterAuthPlugin,
    ],
  });
  const post = (path: string, body: object, cookies = "") =>
    auth.handler(
      new Request(`${config.baseURL}/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: config.baseURL,
          Cookie: cookies,
        },
        body: JSON.stringify(body),
      }),
    );
  const registration = await post("oauth2/register", {
    client_name: "Bridge test",
    redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "openid profile offline_access financial:read",
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "client-state",
    scope: "openid profile offline_access financial:read",
    resource: `${config.baseURL}/mcp`,
  });
  const authorization = await auth.handler(
    new Request(`${config.baseURL}/api/auth/oauth2/authorize?${params}`),
  );
  const loginUrl =
    authorization.status === 302
      ? authorization.headers.get("location")!
      : (await authorization.json()).url;
  const signedQuery = new URL(loginUrl, config.baseURL).search.slice(1);
  const originalFetch = globalThis.fetch;
  let email = config.allowedEmail;
  let verified = true;
  let subject = "neon-owner";
  let google = true;
  let expired = false;
  let badSession = false;
  let googleAccount = "google-subject";
  let upstreamCalls = 0;
  let rejectedSignOuts = 0;
  globalThis.fetch = async (input, init) => {
    upstreamCalls++;
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const upstreamCookies = new Headers(init?.headers).get("cookie") ?? "";
    assert.doesNotMatch(
      upstreamCookies,
      /__Host-fonds-neon-login|better-auth|synthetic-local-session|unrelated-browser-cookie|session_data/,
    );
    if (url.pathname.endsWith("/sign-out")) {
      assert.equal(init?.method, "POST");
      assert.match(
        new Headers(init?.headers).get("cookie") || "",
        /session_token=neon-session/,
      );
      rejectedSignOuts++;
      return Response.json({ success: true });
    }
    if (url.pathname.endsWith("/sign-in/social")) {
      return Response.json(
        {
          url: "https://accounts.google.com/o/oauth2/v2/auth?state=provider-state",
        },
        {
          headers: new Headers([
            [
              "Set-Cookie",
              "__Secure-neon-auth.session_challenge=challenge; Path=/; Secure; HttpOnly; SameSite=None",
            ],
            [
              "Set-Cookie",
              "__Secure-neon-auth.session_token=ignored-start-session; Path=/; Secure; HttpOnly; SameSite=None",
            ],
          ]),
        },
      );
    }
    if (url.pathname.endsWith("/get-session")) {
      const cookies = new Headers(init?.headers).get("cookie") || "";
      if (url.searchParams.has("neon_auth_session_verifier")) {
        assert.equal(cookies, "__Secure-neon-auth.session_challenge=challenge");
        assert.doesNotMatch(cookies, /client-forged-token/);
        if (
          url.searchParams.get("neon_auth_session_verifier") ===
          "invalid-verifier"
        ) {
          return Response.json({ error: "invalid verifier" }, { status: 401 });
        }
      } else {
        assert.match(cookies, /session_token=neon-session/);
      }
      return Response.json(
        {
          session: {
            userId: badSession ? "another-user" : subject,
            expiresAt: new Date(
              Date.now() + (expired ? -60_000 : 600_000),
            ).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          user: {
            id: subject,
            email,
            emailVerified: verified,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        url.searchParams.has("neon_auth_session_verifier")
          ? {
              headers: {
                "Set-Cookie":
                  "__Secure-neon-auth.session_token=neon-session; Path=/; Secure; HttpOnly; SameSite=None",
              },
            }
          : undefined,
      );
    }
    if (url.pathname.endsWith("/list-accounts")) {
      return Response.json(
        google
          ? [
              {
                providerId: "google",
                accountId: googleAccount,
                userId: subject,
              },
            ]
          : [],
      );
    }
    throw new Error(`Unexpected upstream path: ${url.pathname}`);
  };

  async function start() {
    const response = await startGoogleLogin(
      new Request(`${config.baseURL}/google/start?${signedQuery}`),
      store.pool,
      config,
    );
    assert.equal(response.status, 302);
    const cookies = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const binding = cookies
      .split("; ")
      .find((c) => c.startsWith("__Host-fonds-neon-login="))!;
    const row = [...store.states.values()].find(
      (s) => s.binding_hash === digest(binding.split("=")[1]!),
    )!;
    assert.equal(response.headers.getSetCookie().length, 1);
    assert.match(row.upstream_cookies, /session_challenge=challenge/);
    // Capture the callback state sent to the mocked provider by replacing the start helper for one call.
    // State is intentionally stored hashed; retrieve its public value from the outgoing callbackURL.
    return { response, cookies, row };
  }

  let callbackState = "";
  const mockedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname.endsWith("/sign-in/social")) {
      const body = JSON.parse(init!.body as string);
      assert.equal(
        body.newUserCallbackURL,
        body.callbackURL,
        "New users must pass the same authorization callback as returning users",
      );
      callbackState = new URL(body.callbackURL).searchParams.get("state")!;
    }
    return mockedFetch(input, init);
  };
  const callback = (cookies: string, state = callbackState) =>
    new Request(
      `${config.baseURL}/google/callback?state=${state}&neon_auth_session_verifier=one-use-verifier`,
      { headers: { Cookie: cookies } },
    );
  try {
    await step(
      "unsigned starts and callbacks without a browser binding are rejected before upstream calls",
      async () => {
        const calls = upstreamCalls;
        assert.equal(
          (
            await startGoogleLogin(
              new Request(
                `${config.baseURL}/google/start?email=owner@example.com`,
              ),
              store.pool,
              config,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await finishGoogleLogin(
              callback("", randomBytes(32).toString("base64url")),
              store.pool,
              config,
              (r) => auth.handler(r),
            )
          ).status,
          400,
        );
        assert.equal(upstreamCalls, calls);
      },
    );
    for (const failure of [
      "wrong-email",
      "unverified-email",
      "wrong-session-user",
      "no-google-account",
      "expired-session",
    ]) {
      await step(`rejects ${failure}`, async () => {
        const { cookies } = await start();
        const signOutsBefore = rejectedSignOuts;
        email =
          failure === "wrong-email"
            ? "intruder@example.com"
            : config.allowedEmail;
        verified = failure !== "unverified-email";
        badSession = failure === "wrong-session-user";
        google = failure !== "no-google-account";
        expired = failure === "expired-session";
        assert.equal(
          (
            await finishGoogleLogin(
              callback(cookies),
              store.pool,
              config,
              (r) => auth.handler(r),
            )
          ).status,
          403,
        );
        assert.equal(db.session!.length, 0);
        assert.equal(store.linked(), undefined);
        assert.equal(
          rejectedSignOuts,
          signOutsBefore + 1,
          "Rejected login must end its upstream session",
        );
      });
    }
    email = config.allowedEmail;
    verified = true;
    badSession = false;
    google = true;
    expired = false;
    await step(
      "a callback without a verifier cannot skip Google login",
      async () => {
        const { cookies } = await start();
        const state = callbackState;
        const result = await finishGoogleLogin(
          new Request(`${config.baseURL}/google/callback?state=${state}`, {
            headers: { Cookie: cookies },
          }),
          store.pool,
          config,
          (r) => auth.handler(r),
        );
        assert.equal(result.status, 401);
        assert.equal(db.session!.length, 0);
      },
    );
    await step("an invalid verifier cannot create an MCP session", async () => {
      const { cookies } = await start();
      const result = await finishGoogleLogin(
        new Request(
          `${config.baseURL}/google/callback?state=${callbackState}&neon_auth_session_verifier=invalid-verifier`,
          { headers: { Cookie: cookies } },
        ),
        store.pool,
        config,
        (r) => auth.handler(r),
      );
      assert.equal(result.status, 401);
      assert.equal(db.session!.length, 0);
    });
    await step(
      "expired and mismatched browser state cannot create a session",
      async () => {
        const { cookies, row } = await start();
        const bad = cookies.replace(
          /__Host-fonds-neon-login=[\w-]+/,
          `__Host-fonds-neon-login=${randomBytes(32).toString("base64url")}`,
        );
        assert.equal(
          await readLoginState(store.pool, callback(bad), callbackState),
          null,
        );
        row.expires = Date.now() - 1;
        assert.equal(
          (
            await finishGoogleLogin(
              callback(cookies),
              store.pool,
              config,
              (r) => auth.handler(r),
            )
          ).status,
          400,
        );
      },
    );
    await step(
      "signed authorization context and unambiguous binding are required",
      async () => {
        const { cookies, row } = await start();
        const state = callbackState;
        const calls = upstreamCalls;
        const direct = await post(
          "sign-in/neon",
          { bridge: state, oauth_query: `${signedQuery}&extra=forged` },
          cookies,
        );
        assert.ok([400, 401].includes(direct.status));
        assert.equal(
          await readLoginState(
            store.pool,
            callback(`${cookies}; ${cookies}`),
            state,
          ),
          null,
        );
        row.oauth_query += "&extra=forged";
        assert.equal(
          (
            await finishGoogleLogin(
              callback(cookies, state),
              store.pool,
              config,
              (r) => auth.handler(r),
            )
          ).status,
          400,
        );
        assert.equal(upstreamCalls, calls);
      },
    );
    await step(
      "verified Google owner receives a local MCP session and an authorization code; replay fails",
      async () => {
        const { cookies } = await start();
        const state = callbackState;
        const signOutsBefore = rejectedSignOuts;
        const result = await finishGoogleLogin(
          callback(
            `${cookies}; __Secure-neon-auth.session_token=client-forged-token; __Secure-neon-auth.session_data=forged-cache; __Secure-better-auth.session_token=synthetic-local-session; unrelated-browser-cookie=private`,
          ),
          store.pool,
          config,
          (r) => {
            const localCookies = r.headers.get("cookie") ?? "";
            assert.match(localCookies, /__Host-fonds-neon-login=/);
            assert.match(
              localCookies,
              /__Secure-better-auth.session_token=synthetic-local-session/,
            );
            assert.doesNotMatch(
              localCookies,
              /client-forged-token|forged-cache/,
            );
            return auth.handler(r);
          },
        );
        assert.equal(result.status, 302, await result.clone().text());
        const destination = new URL(result.headers.get("location")!);
        assert.equal(destination.pathname, "/consent");
        assert.equal(
          rejectedSignOuts,
          signOutsBefore,
          "Allowed owner session must not be revoked",
        );
        assert.equal(
          destination.searchParams.has("neon_auth_session_verifier"),
          false,
        );
        assert.equal(result.headers.getSetCookie().length, 1);
        const sessionCookies = result.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
        assert.match(sessionCookies, /session_token/);
        assert.deepEqual(store.linked(), [
          config.ownerId,
          config.upstreamURL,
          subject,
          "google-subject",
        ]);
        const consent = await post(
          "oauth2/consent",
          { accept: true, oauth_query: destination.search.slice(1) },
          sessionCookies,
        );
        assert.equal(consent.status, 200);
        const clientCallback = new URL((await consent.json()).url);
        assert.equal(clientCallback.searchParams.get("state"), "client-state");
        const tokens = await auth.handler(
          new Request(`${config.baseURL}/api/auth/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: client.client_id,
              code: clientCallback.searchParams.get("code")!,
              redirect_uri: redirect,
              code_verifier: verifier,
              resource: `${config.baseURL}/mcp`,
            }),
          }),
        );
        assert.equal(tokens.status, 200, await tokens.clone().text());
        const payload = await tokens.json();
        assert.equal(
          JSON.parse(
            Buffer.from(
              payload.access_token.split(".")[1],
              "base64url",
            ).toString(),
          ).sub,
          config.ownerId,
        );
        assert.equal(
          (
            await finishGoogleLogin(
              callback(cookies, state),
              store.pool,
              config,
              (r) => auth.handler(r),
            )
          ).status,
          400,
        );
      },
    );
    await step(
      "an existing owner link also pins the Google account identifier",
      async () => {
        googleAccount = "different-google-account";
        const { cookies } = await start();
        const sessionsBefore = db.session!.length;
        assert.equal(
          (
            await finishGoogleLogin(
              callback(cookies),
              store.pool,
              config,
              (r) => auth.handler(r),
            )
          ).status,
          403,
        );
        assert.equal(db.session!.length, sessionsBefore);
        googleAccount = "google-subject";
      },
    );
    await step(
      "unexpected upstream errors and authorization redirects remain private",
      async () => {
        const { cookies } = await start();
        const response = await finishGoogleLogin(
          callback(cookies),
          store.pool,
          config,
          async () =>
            Response.json(
              { url: "https://attacker.invalid/callback" },
              {
                headers: {
                  "Set-Cookie": "__Secure-better-auth.session_token=synthetic",
                },
              },
            ),
        );
        assert.equal(response.status, 502);
        const savedFetch = globalThis.fetch;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        globalThis.fetch = async () => {
          throw new Error("synthetic-upstream-secret");
        };
        try {
          const failed = await startGoogleLogin(
            new Request(`${config.baseURL}/google/start?${signedQuery}`),
            store.pool,
            config,
          );
          assert.equal(failed.status, 502);
          assert.doesNotMatch(await failed.text(), /synthetic-upstream-secret/);
          assert.equal(warn.mock.calls.length, 0);
          assert.equal(error.mock.calls.length, 0);
        } finally {
          globalThis.fetch = savedFetch;
          warn.mockRestore();
          error.mockRestore();
        }
      },
    );
    await step(
      "a malformed client callback is an invalid authorization redirect",
      async () => {
        const { cookies, row } = await start();
        const query = new URLSearchParams(row.oauth_query);
        query.set("redirect_uri", "synthetic malformed callback");
        row.oauth_query = query.toString();
        queryVerification.assumeSigned = true;
        try {
          const response = await finishGoogleLogin(
            callback(cookies),
            store.pool,
            config,
            async () =>
              Response.json(
                { url: "https://client.example.com/callback" },
                {
                  headers: {
                    "Set-Cookie":
                      "__Secure-better-auth.session_token=synthetic",
                  },
                },
              ),
          );
          assert.equal(response.status, 502);
          assert.equal(
            await response.text(),
            "Invalid authorization redirect.",
          );
        } finally {
          queryVerification.assumeSigned = false;
        }
      },
    );
    await step(
      "an existing owner link cannot silently move to a different upstream subject",
      async () => {
        subject = "different-neon-owner";
        const { cookies } = await start();
        const sessionsBefore = db.session!.length;
        assert.equal(
          (
            await finishGoogleLogin(
              callback(cookies),
              store.pool,
              config,
              (r) => auth.handler(r),
            )
          ).status,
          403,
        );
        assert.equal(db.session!.length, sessionsBefore);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("rejects invalid fixed configuration and hides storage failures", async () => {
  const store = bridgePool();
  for (const invalid of [
    { upstreamURL: "http://auth.example.invalid" },
    { upstreamURL: "https://username:password@auth.example.invalid/auth" },
    { baseURL: "https://mcp.example.com/extra" },
    { allowedEmail: "Owner@example.com" },
    { secret: "short" },
  ]) {
    assert.throws(() => neonLoginPlugin(store.pool, { ...config, ...invalid }));
  }
  const failedPool = {
    query: async () => {
      throw new Error("synthetic-private-database-error");
    },
  } as unknown as Pool;
  const state = randomBytes(32).toString("base64url");
  const response = await finishGoogleLogin(
    new Request(
      `${config.baseURL}/google/callback?state=${state}&neon_auth_session_verifier=synthetic`,
      {
        headers: {
          Cookie: `__Host-fonds-neon-login=${randomBytes(32).toString("base64url")}`,
        },
      },
    ),
    failedPool,
    config,
    async () => {
      throw new Error("Must not reach issuer");
    },
  );
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /synthetic-private/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});
