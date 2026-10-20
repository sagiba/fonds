import { createHash, randomBytes } from "node:crypto";

import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import {
  handleAuthRequest,
  handleAuthResponse,
  parseSetCookies,
  processAuthMiddleware,
  resolveNeonAuthLogging,
} from "@neondatabase/auth/server";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Pool } from "pg";
import { z } from "zod";

import type { GoogleLogin } from "../../src/runtime/auth/better-auth.js";

/**
 * Session bridge, not a Google OAuth implementation. Neon owns the shared Google
 * app and its login protocol; the SDK below performs its verifier exchange. Our
 * separate Better Auth instance owns the MCP grants and therefore needs its own
 * session after we verify the managed identity. Without Neon Auth's
 * OAuth-provider plugin, Generic OAuth/OIDC cannot connect the two issuers. See docs/guides/neon-deployment.md#owner-login-and-authorization for alternatives.
 *
 * Persist the signed MCP request and a browser binding across that round trip:
 * a signed query proves its issuer, but alone does not identify the browser that
 * started login. State is short-lived and consumed once. The identity map is
 * deliberately separate and durable, so a later equal email cannot relink it.
 */
const neonLog = resolveNeonAuthLogging({ logLevel: "silent" });
const neonCookiePrefix = "__Secure-neon-auth.";
const neonSessionCookie = "__Secure-neon-auth.session_token";
const neonCookieNames = new Set([
  neonSessionCookie,
  "__Secure-neon-auth.session_challenge",
  "__Secure-neon-auth.session_challange",
]);
const bindingCookie = "__Host-fonds-neon-login";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
/** The base64url encoding of `random()`'s 32 bytes. */
const randomTokenPattern = /^[\w-]{43}$/;

/** `name=value` pairs from a request Cookie header, in order. */
function requestCookies(request: Request): string[] {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

const cookieName = (cookie: string) => cookie.slice(0, cookie.indexOf("="));

export type GoogleConfig = {
  baseURL: string;
  upstreamURL: string;
  allowedEmail: string;
  ownerId: string;
  secret: string;
};

/** Fixed server configuration; no identity or issuer comes from model inputs. */
function validateConfig(config: GoogleConfig) {
  const origin = new URL(config.baseURL);
  const upstream = new URL(config.upstreamURL);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== config.baseURL ||
    upstream.protocol !== "https:" ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    !config.ownerId.trim() ||
    config.secret.length < 32 ||
    !/^[^\s@]+@[^\s@]+$/.test(config.allowedEmail) ||
    config.allowedEmail !== config.allowedEmail.toLowerCase()
  ) {
    throw new Error("Invalid Neon Google login configuration");
  }
}

export const bridgeSchema = `
CREATE TABLE IF NOT EXISTS fonds_neon_login (
  state_hash text PRIMARY KEY, binding_hash text NOT NULL, oauth_query text NOT NULL,
  expires_at timestamptz NOT NULL, upstream_cookies text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS fonds_neon_identity (
  local_user_id text PRIMARY KEY REFERENCES "user"(id),
  upstream_url text NOT NULL, upstream_user_id text NOT NULL,
  google_account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upstream_url, upstream_user_id)
);`;

type LoginState = {
  state_hash: string;
  binding_hash: string;
  oauth_query: string;
  upstream_cookies: string;
};

export async function readLoginState(
  pool: Pool,
  request: Request,
  state: string,
): Promise<LoginState | null> {
  if (!randomTokenPattern.test(state)) {
    return null;
  }
  const bindings = requestCookies(request).filter(
    (cookie) => cookieName(cookie) === bindingCookie,
  );
  if (bindings.length !== 1) {
    return null;
  }
  const binding = bindings[0]!.slice(bindingCookie.length + 1);
  if (!binding || !randomTokenPattern.test(binding)) {
    return null;
  }
  const { rows } = await pool.query<LoginState>(
    "SELECT state_hash, binding_hash, oauth_query, upstream_cookies FROM fonds_neon_login WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now()",
    [hash(state), hash(binding)],
  );
  return rows[0] || null;
}

const privateHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function privateText(message: string, status: number): Response {
  return new Response(message, { status, headers: privateHeaders });
}

function neonCookiePairs(cookies: string[]): string {
  return cookies
    .flatMap(parseSetCookies)
    .filter(
      (c) =>
        neonCookieNames.has(c.name) &&
        c.value &&
        c.maxAge !== 0 &&
        (!c.expires || c.expires.getTime() > Date.now()),
    )
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
}

function upstreamIdentityCookies(request: Request): string {
  return requestCookies(request)
    .filter((cookie) => neonCookieNames.has(cookieName(cookie)))
    .join("; ");
}

function ownBrowserCookies(request: Request): string {
  return requestCookies(request)
    .filter((cookie) => !cookie.startsWith(neonCookiePrefix))
    .join("; ");
}

/** Only navigate to Google's provider or Neon's shared-credential broker. */
function isLoginBrokerDestination(
  destination: URL | undefined,
): destination is URL {
  return Boolean(
    destination &&
    !destination.username &&
    !destination.password &&
    !destination.hash &&
    destination.protocol === "https:" &&
    (destination.hostname === "accounts.google.com" ||
      destination.hostname.endsWith(".neon.tech")),
  );
}

async function startGoogleLoginImpl(
  request: Request,
  pool: Pool,
  config: GoogleConfig,
): Promise<Response> {
  const query = new URL(request.url).search.slice(1);
  if (!(await verifyOAuthQueryParams(query, config.secret))) {
    return privateText(
      "Invalid or expired login request. Reconnect from ChatGPT.",
      400,
    );
  }
  const state = random();
  const binding = random();
  await pool.query("DELETE FROM fonds_neon_login WHERE expires_at<=now()");
  await pool.query(
    "INSERT INTO fonds_neon_login (state_hash,binding_hash,oauth_query,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')",
    [hash(state), hash(binding), query],
  );
  const callback = new URL("/google/callback", config.baseURL);
  callback.searchParams.set("state", state);
  const upstreamRaw = await handleAuthRequest(
    config.upstreamURL,
    new Request(`${config.baseURL}/google/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.baseURL },
      body: JSON.stringify({
        provider: "google",
        callbackURL: callback.href,
        newUserCallbackURL: callback.href,
        errorCallbackURL: `${config.baseURL}/google/error`,
        disableRedirect: true,
      }),
    }),
    "sign-in/social",
    neonLog,
  );
  const upstream = await handleAuthResponse(
    upstreamRaw,
    config.upstreamURL,
    {
      secret: config.secret,
      sameSite: "lax",
    },
    neonLog,
  );
  const upstreamCookies = neonCookiePairs(upstream.headers.getSetCookie())
    .split("; ")
    .filter((cookie) => !cookie.startsWith(`${neonSessionCookie}=`))
    .join("; ");
  const data = await upstream.json().catch(() => null);
  let destination: URL | undefined;
  try {
    destination = new URL(data?.url);
  } catch {
    /* handled below */
  }
  if (
    !upstream.ok ||
    !upstreamCookies.includes("session_chall") ||
    !isLoginBrokerDestination(destination)
  ) {
    await pool.query("DELETE FROM fonds_neon_login WHERE state_hash=$1", [
      hash(state),
    ]);
    return privateText(
      "Google sign-in could not start. Reconnect and try again.",
      502,
    );
  }
  // Keep the upstream challenge server-side so the browser receives only our
  // binding and session cookies, never the upstream provider's.
  await pool.query(
    "UPDATE fonds_neon_login SET upstream_cookies=$2 WHERE state_hash=$1",
    [hash(state), upstreamCookies],
  );
  const headers = new Headers({
    ...privateHeaders,
    Location: destination.href,
  });
  headers.set(
    "Set-Cookie",
    `${bindingCookie}=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}

type UpstreamSession = {
  session?: { userId?: string; expiresAt?: string };
  user?: {
    id?: string;
    email?: string;
    emailVerified?: boolean;
  };
};

type GoogleAccount = {
  providerId?: string;
  accountId?: string;
  userId?: string;
};

type GoogleIdentity = { userId: string; accountId: string };

// Revalidate with the upstream server. Never trust identity from URL parameters,
// the model, or the local SDK's cached session-data cookie.
export async function readGoogleIdentity(
  request: Request,
  config: GoogleConfig,
): Promise<GoogleIdentity | null> {
  const lookup = new Request(
    `${config.baseURL}/google/callback?disableCookieCache=true`,
    {
      headers: {
        Cookie: upstreamIdentityCookies(request),
        Origin: config.baseURL,
      },
    },
  );
  const reject = async () => {
    // Managed Auth has already created this upstream session. End only this
    // login attempt's session when the app refuses it; never delete the user.
    await handleAuthRequest(
      config.upstreamURL,
      new Request(lookup.url, {
        method: "POST",
        headers: {
          Cookie: lookup.headers.get("cookie") || "",
          Origin: config.baseURL,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      "sign-out",
      neonLog,
    );
    return null;
  };
  const sessionResponse = await handleAuthRequest(
    config.upstreamURL,
    lookup,
    "get-session",
    neonLog,
  );
  if (!sessionResponse.ok) {
    return reject();
  }
  const data = (await sessionResponse.json()) as UpstreamSession;
  if (
    typeof data?.user?.id !== "string" ||
    !data.user.id ||
    data.user.emailVerified !== true ||
    typeof data.user.email !== "string" ||
    data.user.email.toLowerCase() !== config.allowedEmail ||
    data.session?.userId !== data.user.id ||
    typeof data.session.expiresAt !== "string" ||
    !(Date.parse(data.session.expiresAt) > Date.now())
  ) {
    return reject();
  }
  const accountsResponse = await handleAuthRequest(
    config.upstreamURL,
    lookup,
    "list-accounts",
    neonLog,
  );
  if (!accountsResponse.ok) {
    return reject();
  }
  const accounts = (await accountsResponse.json()) as GoogleAccount[];
  if (!Array.isArray(accounts)) {
    return reject();
  }
  const google = accounts.find(
    (a) =>
      a?.providerId === "google" &&
      typeof a.accountId === "string" &&
      a.accountId &&
      (!a.userId || a.userId === data.user!.id),
  );
  if (!google?.accountId) {
    return reject();
  }
  return {
    userId: data.user.id,
    accountId: google.accountId,
  };
}

async function consumeAndLink(
  pool: Pool,
  state: LoginState,
  identity: GoogleIdentity,
  config: GoogleConfig,
): Promise<"ok" | "expired" | "forbidden"> {
  const consumed = await pool.query(
    "DELETE FROM fonds_neon_login WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now() RETURNING state_hash",
    [state.state_hash, state.binding_hash],
  );
  if (consumed.rowCount !== 1) {
    return "expired";
  }
  // The verified allowed email admits the first login; stable upstream/user/
  // Google IDs pin subsequent logins. No email is stored. Changing the issuer or
  // linked Google account requires an explicit administrative remap, not
  // automatic relinking by matching email.
  const link = await pool.query(
    `INSERT INTO fonds_neon_identity
    (local_user_id, upstream_url, upstream_user_id, google_account_id) VALUES ($1,$2,$3,$4)
    ON CONFLICT (local_user_id) DO UPDATE SET local_user_id=EXCLUDED.local_user_id
    WHERE fonds_neon_identity.upstream_url=EXCLUDED.upstream_url
      AND fonds_neon_identity.upstream_user_id=EXCLUDED.upstream_user_id
      AND fonds_neon_identity.google_account_id=EXCLUDED.google_account_id
    RETURNING local_user_id`,
    [config.ownerId, config.upstreamURL, identity.userId, identity.accountId],
  );
  return link.rowCount === 1 ? "ok" : "forbidden";
}

export function neonLoginPlugin(pool: Pool, config: GoogleConfig) {
  validateConfig(config);
  const signInNeon = createAuthEndpoint(
    "/sign-in/neon",
    {
      method: "POST",
      body: z.object({ bridge: z.string(), oauth_query: z.string() }),
    },
    async (ctx) => {
      if (!ctx.request) {
        throw new APIError("UNAUTHORIZED");
      }
      const state = await readLoginState(pool, ctx.request, ctx.body.bridge);
      if (
        !state ||
        state.oauth_query !== ctx.body.oauth_query ||
        !(await verifyOAuthQueryParams(state.oauth_query, config.secret))
      ) {
        throw new APIError("UNAUTHORIZED");
      }
      const identity = await readGoogleIdentity(ctx.request, config);
      if (!identity) {
        throw new APIError("FORBIDDEN", {
          message: "Fonds is restricted to its Google owner.",
        });
      }
      const linked = await consumeAndLink(pool, state, identity, config);
      if (linked !== "ok") {
        throw new APIError(linked === "expired" ? "UNAUTHORIZED" : "FORBIDDEN");
      }
      const user = await ctx.context.internalAdapter.findUserById(
        config.ownerId,
      );
      if (!user) {
        throw new APIError("FORBIDDEN");
      }
      const session = await ctx.context.internalAdapter.createSession(user.id);
      if (!session) {
        throw new APIError("INTERNAL_SERVER_ERROR");
      }
      await setSessionCookie(ctx, { session, user });
      // This is the Better Auth plugin extension point: establish its local
      // session, then let the MCP plugin resume oauth_query and perform
      // consent, PKCE, code/token issuance and refresh. We do not mint any
      // OAuth code or access token in this bridge.
      return ctx.json({ success: true });
    },
  );
  return { id: "neon-google-login", endpoints: { signInNeon } };
}

/**
 * The OAuth provider returns to this issuer, or may go straight to an
 * already-consented client's callback: the redirect_uri of the signed
 * authorization request.
 */
function isAuthorizationRedirect(
  destination: URL,
  baseURL: string,
  clientCallback: string | null,
): boolean {
  if (destination.username || destination.password || destination.hash) {
    return false;
  }
  if (destination.origin === new URL(baseURL).origin) {
    return true;
  }
  return Boolean(
    clientCallback &&
    destination.origin === new URL(clientCallback).origin &&
    destination.pathname === new URL(clientCallback).pathname,
  );
}

async function finishGoogleLoginImpl(
  request: Request,
  pool: Pool,
  config: GoogleConfig,
  handleAuth: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  if (
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("neon_auth_session_verifier").length > 1
  ) {
    return privateText("Invalid Google callback.", 400);
  }
  const login = await readLoginState(pool, request, state);
  if (
    !login ||
    !(await verifyOAuthQueryParams(login.oauth_query, config.secret))
  ) {
    return privateText(
      "Invalid or expired Google login. Reconnect from ChatGPT.",
      400,
    );
  }
  if (!url.searchParams.get("neon_auth_session_verifier")) {
    return privateText(
      "Missing Google session verifier. Reconnect from ChatGPT.",
      401,
    );
  }
  const browserCookies = ownBrowserCookies(request);
  const verificationRequest = new Request(request.url, {
    headers: {
      Origin: config.baseURL,
      Cookie: login.upstream_cookies,
    },
  });
  const exchange = await processAuthMiddleware({
    request: verificationRequest,
    pathname: url.pathname,
    skipRoutes: [],
    loginUrl: "/google/error",
    baseUrl: config.upstreamURL,
    cookieSecret: config.secret,
    sameSite: "lax",
    logLevel: "silent",
  });
  if (exchange.action !== "redirect_oauth") {
    return privateText(
      "Google session verification failed. Reconnect from ChatGPT.",
      401,
    );
  }
  const sessionCookies = neonCookiePairs(exchange.cookies);
  if (!sessionCookies.includes(`${neonSessionCookie}=`)) {
    return privateText(
      "Google did not return a session. Reconnect from ChatGPT.",
      401,
    );
  }
  const result = await handleAuth(
    new Request(`${config.baseURL}/api/auth/sign-in/neon`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: config.baseURL,
        Cookie: `${browserCookies}; ${sessionCookies}`,
        Accept: "application/json",
      },
      body: JSON.stringify({ bridge: state, oauth_query: login.oauth_query }),
    }),
  );
  const data = await result.json().catch(() => null);
  if (!result.ok || typeof data?.url !== "string") {
    return privateText(
      result.status === 403
        ? "Fonds is restricted to its Google owner."
        : "Google sign-in could not finish. Reconnect from ChatGPT.",
      result.ok ? 502 : result.status,
    );
  }
  const destination = new URL(data.url, config.baseURL);
  const clientCallback = new URLSearchParams(login.oauth_query).get(
    "redirect_uri",
  );
  if (!isAuthorizationRedirect(destination, config.baseURL, clientCallback)) {
    return privateText("Invalid authorization redirect.", 502);
  }
  const headers = new Headers({
    ...privateHeaders,
    Location: destination.href,
  });
  // Only the local MCP session belongs in the browser. The now-inert binding
  // cookie expires naturally; its server-side state has already been consumed.
  const localSession = result.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Secure-better-auth.session_token="));
  if (!localSession) {
    return privateText("MCP session could not be created.", 502);
  }
  headers.set("Set-Cookie", localSession);
  return new Response(null, { status: 302, headers });
}

/** Upstream errors can carry identity or cookie details: log only the stage and class. */
function logLoginFailure(stage: "start" | "finish", error: unknown) {
  console.info(
    JSON.stringify({
      event: "fonds_google_login_error",
      stage,
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
}

/** Start only from the issuer-signed authorization request. Upstream errors stay private. */
export async function startGoogleLogin(
  request: Request,
  pool: Pool,
  config: GoogleConfig,
): Promise<Response> {
  try {
    return await startGoogleLoginImpl(request, pool, config);
  } catch (error) {
    logLoginFailure("start", error);
    return privateText(
      "Google sign-in could not start. Reconnect and try again.",
      502,
    );
  }
}

/** Finish only the browser-bound, unexpired challenge; never expose upstream errors. */
export async function finishGoogleLogin(
  request: Request,
  pool: Pool,
  config: GoogleConfig,
  handleAuth: (request: Request) => Promise<Response>,
): Promise<Response> {
  try {
    return await finishGoogleLoginImpl(request, pool, config, handleAuth);
  } catch (error) {
    logLoginFailure("finish", error);
    return privateText(
      "Google sign-in could not finish. Reconnect from ChatGPT.",
      502,
    );
  }
}

/** The managed Neon Google login as this issuer's injected bridge. */
export function neonGoogleLogin(upstream: {
  upstreamURL: string;
  allowedEmail: string;
}): GoogleLogin {
  return (pool, issuer) => {
    const config = { ...issuer, ...upstream };
    return {
      plugin: neonLoginPlugin(pool, config),
      schema: bridgeSchema,
      start: (request) => startGoogleLogin(request, pool, config),
      finish: (request, handleAuth) =>
        finishGoogleLogin(request, pool, config, handleAuth),
    };
  };
}
