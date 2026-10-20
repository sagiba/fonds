import { randomUUID } from "node:crypto";

import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { jwt, magicLink } from "better-auth/plugins";
import { decodeJwt } from "jose";
import type { Pool } from "pg";

import { type HostedAuthProvider, hostedOrigin } from "../../transport/auth.js";
import { betterAuthPage, ownerAccountPage } from "./pages.js";

export const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const CHATGPT_JWKS_URL = "https://chatgpt.com/oauth/jwks.json";
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const BETTER_AUTH_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "financial:read",
  "financial:write",
];
const GRANT_TYPES: readonly string[] = ["authorization_code", "refresh_token"];
/** Hosts on which a public client may redirect over plain http. */
const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

const PAGE_ROUTES = new Set(["/sign-in", "/consent"]);
const ACCOUNT_PAGE = "/account";
/** Owner sign-in and passkey management; registration requires a fresh session. */
const PASSKEY_ROUTES = [
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/verify-authentication",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/verify-registration",
  "/api/auth/passkey/list-user-passkeys",
  "/api/auth/passkey/delete-passkey",
];
/** Social providers Fonds can offer as an optional, explicitly linked login. */
export const SOCIAL_LOGIN_PROVIDERS = ["google", "github"] as const;

export type SocialLoginProvider = (typeof SOCIAL_LOGIN_PROVIDERS)[number];

/**
 * The only request header Better Auth reads a client address from, for rate
 * limiting and session records. The hosted service removes any copy a client
 * sends and sets it only from the address its ingress trusts.
 */
export const CLIENT_ADDRESS_HEADER = "x-fonds-client-address";

/** Login links last ten minutes and are consumed on first use. */
const LOGIN_LINK_SECONDS = 600;
const GOOGLE_ROUTES = new Set([
  "/google/start",
  "/google/callback",
  "/google/error",
]);
/** Routes whose OAuth client must be allowlisted before Better Auth sees them. */
const CLIENT_ROUTES = new Set([
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/revoke",
]);
const LOGGED_ROUTES = new Set([
  ...CLIENT_ROUTES,
  "/api/auth/sign-in/email",
  "/api/auth/oauth2/consent",
  ...GOOGLE_ROUTES,
  "/api/auth/passkey/verify-authentication",
  "/api/auth/passkey/verify-registration",
  "/api/auth/magic-link/verify",
  "/api/auth/sign-in/social",
  "/api/auth/link-social",
  "/api/auth/callback/google",
  "/api/auth/callback/github",
]);
const OAUTH_ERRORS = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "forbidden",
]);

/** Pages and protocol routes the issuer serves, rather than the application. */
function isAuthRoute(route: string): boolean {
  return (
    PAGE_ROUTES.has(route) ||
    route === ACCOUNT_PAGE ||
    GOOGLE_ROUTES.has(route) ||
    route.startsWith("/api/auth/") ||
    route.startsWith("/.well-known/")
  );
}

interface ClientParameters {
  clientId: string | null;
  /** More than one client_id was supplied. */
  duplicate: boolean;
  /** A POST body was not a parseable form or JSON object. */
  invalid: boolean;
}

/** A token or revoke request authenticated by exactly one JWT-bearer assertion. */
function isAssertionOnlyRequest(params: URLSearchParams, url: URL): boolean {
  return (
    url.pathname !== "/api/auth/oauth2/authorize" &&
    params.getAll("client_assertion").length === 1 &&
    params.getAll("client_assertion_type").length === 1 &&
    params.get("client_assertion_type") === CLIENT_ASSERTION_TYPE
  );
}

/**
 * Reads the OAuth client from the query or one cloned form/JSON body. An
 * assertion-only ChatGPT token/revoke request is routed by its unverified issuer;
 * Better Auth still verifies signature, audience, lifetime and replay.
 */
async function clientParameters(
  request: Request,
  url: URL,
): Promise<ClientParameters> {
  let params = url.searchParams;
  if (request.method === "POST" && CLIENT_ROUTES.has(url.pathname)) {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim();
    try {
      if (type === "application/x-www-form-urlencoded") {
        params = new URLSearchParams(await request.clone().text());
      } else if (type === "application/json") {
        const body = (await request.clone().json()) as Record<string, unknown>;
        params = new URLSearchParams(
          ["client_id", "client_assertion", "client_assertion_type"].flatMap(
            (key) =>
              typeof body[key] === "string" ? [[key, body[key] as string]] : [],
          ),
        );
      } else {
        throw new Error("Unsupported OAuth request body");
      }
    } catch {
      return { clientId: null, duplicate: false, invalid: true };
    }
  }
  let clientId = params.get("client_id");
  if (!clientId && isAssertionOnlyRequest(params, url)) {
    try {
      const claims = decodeJwt(params.get("client_assertion")!);
      if (
        claims.iss === CHATGPT_CLIENT_ID &&
        claims.sub === CHATGPT_CLIENT_ID
      ) {
        clientId = CHATGPT_CLIENT_ID;
      }
    } catch {
      // Malformed assertions fail closed.
    }
  }
  return {
    clientId,
    duplicate: params.getAll("client_id").length > 1,
    invalid: false,
  };
}

/** A fixed OAuth error code for logs; no error text or returned values. */
async function responseErrorClass(response: Response): Promise<string> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return "request_failed";
  }
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === "string" && OAUTH_ERRORS.has(body.error)
      ? body.error
      : "request_failed";
  } catch {
    return "request_failed";
  }
}

/**
 * A session bridge that signs the owner in through an external Google login and
 * then establishes this issuer's own session. The issuer keeps route admission
 * and client checks; the bridge only serves its start and callback steps.
 */
export interface GoogleLoginBridge {
  plugin: BetterAuthPlugin;
  /** Bridge tables, created by setup only. */
  schema: string;
  start(request: Request): Promise<Response>;
  finish(
    request: Request,
    handleAuth: (request: Request) => Promise<Response>,
  ): Promise<Response>;
}

/** Host targets supply the bridge; it receives the identity-schema pool. */
export type GoogleLogin = (
  pool: Pool,
  issuer: { baseURL: string; ownerId: string; secret: string },
) => GoogleLoginBridge;

export interface SocialLoginCredentials {
  clientId: string;
  clientSecret: string;
}

export interface BetterAuthConfig {
  publicOrigin: string;
  secret: string;
  ownerId: string;
  ownerEmail: string;
  allowedClientIds?: readonly string[];
  googleLogin?: GoogleLogin;
  /** Sign-in only for a provider account the owner linked while signed in. */
  socialLogin?: Partial<Record<SocialLoginProvider, SocialLoginCredentials>>;
}

const PROVIDER_TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "scope",
] as const;

/** An account row without upstream OAuth tokens; other fields are unchanged. */
function withoutProviderTokens<Account extends object>(account: Account) {
  const kept = { ...account } as Record<string, unknown>;
  for (const field of PROVIDER_TOKEN_FIELDS) {
    if (field in kept) {
      kept[field] = null;
    }
  }
  return kept as Account;
}

/** WebAuthn user verification (biometric or PIN) is required, not preferred. */
function requireUserVerification(userVerified: boolean | undefined) {
  if (userVerified !== true) {
    throw new APIError("UNAUTHORIZED", {
      message: "Passkey user verification is required.",
    });
  }
}

/** Public client redirects use https, or http on a loopback host. */
function isAllowedRedirect(url: URL): boolean {
  if (url.hash || url.username || url.password) {
    return false;
  }
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
  );
}

function metadataResourceUrl(
  input: Parameters<typeof fetchClientMetadataResource>[0],
): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/** The pool must use the isolated identity schema as its search_path. */
export function createBetterAuth(
  pool: Pool,
  config: BetterAuthConfig,
  options: { forSetup?: boolean } = {},
) {
  const origin = hostedOrigin(config.publicOrigin);
  const ownerEmail = config.ownerEmail.toLowerCase();
  const issuer = `${origin}/api/auth`;
  const resource = `${origin}/mcp`;
  const allowedClientIds = new Set([
    CHATGPT_CLIENT_ID,
    ...(config.allowedClientIds ?? []),
  ]);
  const google = config.googleLogin?.(pool, {
    baseURL: origin,
    ownerId: config.ownerId,
    secret: config.secret,
  });
  const socialProviders = SOCIAL_LOGIN_PROVIDERS.filter(
    (name) => config.socialLogin?.[name],
  );
  if (google && socialProviders.includes("google")) {
    throw new Error("Configure one Google login: the bridge or the provider");
  }
  // Login links are issued only server-side and handed to the caller that asked.
  let deliverLoginLink: ((url: string) => void) | undefined;
  let issuingLoginLink = Promise.resolve();
  // URL client IDs are fetched only for the one pinned ChatGPT metadata document.
  if (
    [...allowedClientIds].some(
      (id) =>
        !id || (id !== CHATGPT_CLIENT_ID && !/^[A-Za-z0-9_-]{1,200}$/.test(id)),
    )
  ) {
    throw new Error("Invalid OAuth client allowlist");
  }
  const auth = betterAuth({
    appName: "Fonds",
    baseURL: origin,
    basePath: "/api/auth",
    database: pool,
    secret: config.secret,
    logger: { disabled: true },
    trustedOrigins: [origin],
    // Only the privileged setup/test process may use the bootstrap password.
    // The deployed application admits browser sessions through passkeys,
    // operator-issued login links and owner-linked Google or GitHub accounts.
    emailAndPassword: {
      enabled: options.forSetup === true,
      disableSignUp: !options.forSetup,
    },
    socialProviders: Object.fromEntries(
      socialProviders.map((name) => [
        name,
        {
          ...config.socialLogin![name]!,
          disableSignUp: true,
          disableImplicitSignUp: true,
        },
      ]),
    ),
    account: {
      // Fonds needs no provider API access: sign-in never refreshes the row.
      updateAccountOnSignIn: false,
      // The owner row keeps its administrative email, so a provider account is
      // never matched by email: it signs in only after the signed-in owner links it.
      accountLinking: {
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        trustedProviders: [],
        // Passkeys and operator login links remain, so the last linked
        // provider may be removed.
        allowUnlinkingAll: true,
      },
    },
    advanced: {
      // Without trustedProxies, Better Auth accepts only one valid address here.
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      database: {
        generateId: ({ model }) =>
          model === "user" ? config.ownerId : randomUUID(),
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) =>
            !!options.forSetup && user.email.toLowerCase() === ownerEmail,
        },
      },
      session: {
        create: {
          before: async (session) => session.userId === config.ownerId,
        },
      },
      // Linked providers bind the owner by account ID only; their OAuth tokens
      // would give access to the owner's Google or GitHub account, so none are kept.
      account: {
        create: {
          before: async (account) => ({ data: withoutProviderTokens(account) }),
        },
        update: {
          before: async (account) => ({ data: withoutProviderTokens(account) }),
        },
      },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    plugins: [
      jwt({ jwt: { issuer } }),
      passkey({
        rpID: new URL(origin).hostname,
        rpName: "Fonds",
        origin,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        registration: {
          requireSession: true,
          afterVerification: ({ verification }) =>
            requireUserVerification(
              verification.registrationInfo?.userVerified,
            ),
        },
        authentication: {
          afterVerification: ({ verification }) =>
            requireUserVerification(
              verification.authenticationInfo.userVerified,
            ),
        },
      }),
      magicLink({
        storeToken: "hashed",
        disableSignUp: true,
        expiresIn: LOGIN_LINK_SECONDS,
        sendMagicLink: async ({ url }) => {
          if (!deliverLoginLink) {
            throw new APIError("NOT_FOUND");
          }
          deliverLoginLink(url);
        },
      }),
      ...(google ? [google.plugin] : []),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource,
        scopes: BETTER_AUTH_SCOPES,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        grantTypes: [...GRANT_TYPES],
        clientPrivileges: async () => false,
      }),
      cimd({
        metadataProfile: "mcp-2026-07-28",
        isMetadataDocumentUrlAllowed: (url) => url === CHATGPT_CLIENT_ID,
        fetchClientMetadataResource: (input, init) => {
          const url = metadataResourceUrl(input);
          if (url !== CHATGPT_CLIENT_ID && url !== CHATGPT_JWKS_URL) {
            throw new Error("OAuth metadata resource is not allowed");
          }
          return fetchClientMetadataResource(input, init);
        },
      }),
    ],
  });

  /** Better Auth 1.7.10 adds this issuer's UserInfo audience to OpenID grants. */
  function hasUnexpectedAudience(audience: string | string[] | undefined) {
    if (Array.isArray(audience)) {
      return audience.some(
        (entry) => entry !== resource && entry !== `${issuer}/oauth2/userinfo`,
      );
    }
    return audience !== resource;
  }

  const provider: HostedAuthProvider = {
    issuer,
    authorizationScopes: BETTER_AUTH_SCOPES,
    async authenticate(request) {
      const authorization = request.headers.get("authorization");
      if (
        !authorization?.startsWith("Bearer ") ||
        request.headers.has("dpop")
      ) {
        return null;
      }
      try {
        // Official verifier, using this issuer's durable signing keys without an HTTP self-call.
        const claims = await verifyJwsAccessToken(authorization.slice(7), {
          jwksFetch: () => auth.api.getJwks(),
          // The verifier's five-minute cache (refetched on an unknown key ID)
          // avoids a key-table query on every bearer request.
          jwksCacheKey: auth,
          verifyOptions: {
            issuer,
            audience: resource,
            typ: "at+jwt",
            requiredClaims: ["exp", "sub", "client_id", "scope"],
          },
        });
        if (
          claims.sub !== config.ownerId ||
          hasUnexpectedAudience(claims.aud) ||
          typeof claims.client_id !== "string" ||
          !allowedClientIds.has(claims.client_id) ||
          claims.azp !== claims.client_id ||
          claims.cnf !== undefined ||
          typeof claims.scope !== "string"
        ) {
          return null;
        }
        return {
          source: "better-auth",
          subject: claims.sub,
          ownerId: config.ownerId,
          resource,
          clientId: claims.client_id,
          scopes: claims.scope.split(" ").filter(Boolean),
          ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}),
          ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
        };
      } catch {
        return null;
      }
    },
  };

  /** Exact Better Auth endpoints exposed publicly; everything else is 404. */
  const protocolRoutes = new Set([
    "/api/auth/jwks",
    ...(options.forSetup ? ["/api/auth/sign-in/email"] : []),
    "/api/auth/sign-out",
    "/api/auth/get-session",
    "/api/auth/.well-known/oauth-authorization-server",
    "/api/auth/.well-known/openid-configuration",
    "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/consent",
    "/api/auth/oauth2/revoke",
    "/api/auth/oauth2/userinfo",
    ...PASSKEY_ROUTES,
    "/api/auth/magic-link/verify",
    ...(socialProviders.length
      ? [
          "/api/auth/sign-in/social",
          "/api/auth/link-social",
          "/api/auth/unlink-account",
          ...socialProviders.map((name) => `/api/auth/callback/${name}`),
        ]
      : []),
  ]);

  async function routePublicRequest(
    request: Request,
    url: URL,
    client: ClientParameters,
  ): Promise<Response> {
    const path = url.pathname;
    const requestOrigin = request.headers.get("origin");
    if (
      url.origin !== origin ||
      (requestOrigin !== null && requestOrigin !== origin)
    ) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (GOOGLE_ROUTES.has(path)) {
      if (!google) {
        return new Response(null, { status: 404 });
      }
      if (request.method !== "GET") {
        return new Response(null, { status: 405 });
      }
      if (path === "/google/start") {
        if (!allowedClientIds.has(client.clientId ?? "")) {
          return new Response("Invalid authorization request.", {
            status: 400,
          });
        }
        return google.start(request);
      }
      if (path === "/google/callback") {
        return google.finish(request, auth.handler);
      }
      return new Response(
        "Google sign-in failed. Reconnect from ChatGPT and try again.",
        {
          status: 400,
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    }
    if (path === ACCOUNT_PAGE) {
      if (request.method !== "GET") {
        return new Response(null, { status: 405 });
      }
      return ownerAccountResponse(request);
    }
    if (PAGE_ROUTES.has(path)) {
      if (request.method !== "GET") {
        return new Response(null, { status: 405 });
      }
      const { secret } = await auth.$context;
      return betterAuthPage(request, {
        secret,
        ownerEmail,
        consent: path === "/consent",
        allowedClientIds,
        googleBridge: google !== undefined,
        socialProviders,
        allowPassword: options.forSetup === true,
      });
    }
    if (!path.startsWith("/.well-known/") && !protocolRoutes.has(path)) {
      return new Response(null, { status: 404 });
    }
    if (CLIENT_ROUTES.has(path)) {
      if (client.invalid) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      if (
        client.duplicate ||
        !client.clientId ||
        !allowedClientIds.has(client.clientId)
      ) {
        return Response.json({ error: "invalid_client" }, { status: 400 });
      }
    }
    return auth.handler(request);
  }

  function classifyClient(clientId: string | null) {
    if (clientId === CHATGPT_CLIENT_ID) {
      return "chatgpt";
    }
    if (!clientId) {
      return "none";
    }
    return allowedClientIds.has(clientId) ? "provisioned" : "unknown";
  }

  /** Auth/login routes, or null for application routes. Logs fixed classes only. */
  async function handlePublicRequest(
    request: Request,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const route = url.pathname;
    // The shared HTTP boundary advertises issuer authorization scopes, including
    // offline_access; the MCP plugin's resource metadata filters OIDC scopes.
    if (
      route === "/.well-known/oauth-protected-resource/mcp" ||
      !isAuthRoute(route)
    ) {
      return null;
    }
    const client = await clientParameters(request, url);
    if (!LOGGED_ROUTES.has(route)) {
      return routePublicRequest(request, url, client);
    }
    const clientClass = classifyClient(client.clientId);
    const log = (status: number, error: string | null) =>
      console.info(
        JSON.stringify({
          event: "fonds_auth_response",
          route,
          client: clientClass,
          status,
          error,
        }),
      );
    try {
      const response = await routePublicRequest(request, url, client);
      log(
        response.status,
        response.status >= 400 ? await responseErrorClass(response) : null,
      );
      return response;
    } catch (error) {
      log(500, "server_error");
      throw error;
    }
  }

  function setupOnly() {
    if (!options.forSetup) {
      throw new Error("Auth setup is disabled");
    }
  }

  /** The signed-in owner's passkeys and linked providers, or a sign-in hint. */
  async function ownerAccountResponse(request: Request): Promise<Response> {
    const session = await auth.api.getSession({ headers: request.headers });
    if (session?.user.id !== config.ownerId) {
      return ownerAccountPage({ signedIn: false });
    }
    const [passkeys, accounts] = await Promise.all([
      auth.api.listPasskeys({ headers: request.headers }),
      auth.api.listUserAccounts({ headers: request.headers }),
    ]);
    return ownerAccountPage({
      signedIn: true,
      passkeys: passkeys.map(({ id, name, createdAt }) => ({
        id,
        name: name ?? null,
        createdAt,
      })),
      socialProviders,
      linkedAccounts: accounts.flatMap((account) =>
        socialProviders.includes(account.providerId as SocialLoginProvider)
          ? [
              {
                id: account.id,
                provider: account.providerId as SocialLoginProvider,
              },
            ]
          : [],
      ),
    });
  }

  /**
   * A one-time, ten-minute owner sign-in link for the operator who requested it.
   * Only its hash is stored; it is never logged or sent anywhere.
   */
  async function issueOwnerLoginLink(): Promise<string> {
    setupOnly();
    if (!(await verifiedOwner())) {
      throw new Error("Run setup first: the configured owner does not exist");
    }
    const issue = issuingLoginLink.then(async () => {
      let url: string | undefined;
      deliverLoginLink = (value) => {
        url = value;
      };
      try {
        await auth.api.signInMagicLink({
          body: { email: ownerEmail, callbackURL: ACCOUNT_PAGE },
          headers: new Headers(),
        });
      } finally {
        deliverLoginLink = undefined;
      }
      if (!url) {
        throw new Error("Login link was not issued");
      }
      return url;
    });
    issuingLoginLink = issue.then(
      () => undefined,
      () => undefined,
    );
    return issue;
  }

  async function ensureResource() {
    const { adapter } = await auth.$context;
    const existing = await adapter.findOne({
      model: "oauthResource",
      where: [{ field: "identifier", value: resource }],
    });
    if (!existing) {
      await adapter.create({
        model: "oauthResource",
        data: {
          identifier: resource,
          name: "Fonds",
          disabled: false,
          dpopBoundAccessTokensRequired: false,
          policyVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
  }

  async function migrate() {
    setupOnly();
    const migration = await getMigrations(auth.options);
    if (migration.schemaProblems.length) {
      throw new Error("Auth schema migration needs manual review");
    }
    await migration.runMigrations();
    // Provider initialization can precede table creation and intentionally defer its seed.
    await ensureResource();
    if (google) {
      await pool.query(google.schema);
    }
  }

  /**
   * The configured owner, marked verified, or undefined before setup created it.
   * The operator provisions the owner, so it is verified: Better Auth would
   * otherwise treat a login link as proof of an unverified email and revoke the
   * owner's other accounts and sessions.
   */
  async function verifiedOwner() {
    const { adapter } = await auth.$context;
    const existing = await adapter.findOne<{
      id: string;
      email: string;
      emailVerified: boolean;
    }>({
      model: "user",
      where: [{ field: "email", value: ownerEmail }],
    });
    if (!existing) {
      return undefined;
    }
    if (existing.id !== config.ownerId) {
      throw new Error("Configured owner differs from existing auth account");
    }
    if (!existing.emailVerified) {
      await adapter.update({
        model: "user",
        where: [{ field: "id", value: config.ownerId }],
        update: { emailVerified: true },
      });
    }
    return { id: existing.id, email: existing.email };
  }

  async function bootstrapOwner(
    password: string,
  ): Promise<{ id: string; email: string }> {
    setupOnly();
    // The password credential only seeds the row; browser login never uses it.
    const existing = await verifiedOwner();
    if (existing) {
      return existing;
    }
    const result = await auth.api.signUpEmail({
      body: { name: "Owner", email: ownerEmail, password },
    });
    if (result.user.id !== config.ownerId) {
      throw new Error("Owner bootstrap identity mismatch");
    }
    const created = await verifiedOwner();
    if (!created) {
      throw new Error("Owner bootstrap identity mismatch");
    }
    return created;
  }

  async function provisionPublicClient(input: {
    clientId: string;
    redirectUris: string[];
    name?: string;
  }): Promise<void> {
    setupOnly();
    await ensureResource();
    if (
      input.clientId === CHATGPT_CLIENT_ID ||
      !allowedClientIds.has(input.clientId) ||
      !input.redirectUris.length
    ) {
      throw new Error("Client must be explicitly allowlisted for setup");
    }
    for (const redirect of input.redirectUris) {
      if (!isAllowedRedirect(new URL(redirect))) {
        throw new Error("Invalid public client redirect URI");
      }
    }
    const { adapter } = await auth.$context;
    const existing = await adapter.findOne<{
      redirectUris: string[];
      tokenEndpointAuthMethod: string;
      userId: string;
      requirePKCE: boolean;
      skipConsent: boolean;
      disabled: boolean;
      scopes: string[];
      grantTypes: string[];
    }>({
      model: "oauthClient",
      where: [{ field: "clientId", value: input.clientId }],
    });
    if (existing) {
      if (
        existing.tokenEndpointAuthMethod !== "none" ||
        JSON.stringify(existing.redirectUris) !==
          JSON.stringify(input.redirectUris) ||
        existing.userId !== config.ownerId ||
        existing.requirePKCE !== true ||
        existing.skipConsent !== false ||
        existing.disabled !== false ||
        JSON.stringify(existing.scopes) !==
          JSON.stringify(BETTER_AUTH_SCOPES) ||
        JSON.stringify(existing.grantTypes) !== JSON.stringify(GRANT_TYPES)
      ) {
        throw new Error(
          "Existing OAuth client differs from setup configuration",
        );
      }
    } else {
      await adapter.create({
        model: "oauthClient",
        data: {
          clientId: input.clientId,
          name: input.name ?? "Fonds verification client",
          userId: config.ownerId,
          redirectUris: input.redirectUris,
          tokenEndpointAuthMethod: "none",
          applicationType: "native",
          grantTypes: [...GRANT_TYPES],
          responseTypes: ["code"],
          scopes: BETTER_AUTH_SCOPES,
          requirePKCE: true,
          skipConsent: false,
          disabled: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
    const link = await adapter.findOne({
      model: "oauthClientResource",
      where: [
        { field: "clientId", value: input.clientId },
        { field: "resourceId", value: resource },
      ],
    });
    if (!link) {
      await adapter.create({
        model: "oauthClientResource",
        data: {
          clientId: input.clientId,
          resourceId: resource,
          createdAt: new Date(),
        },
      });
    }
  }

  /** Background delivery rechecks durable permission instead of storing a bearer. */
  async function hasActiveEventReadGrant(principal: {
    ownerId: string;
    clientId: string;
    sessionId?: string;
  }): Promise<boolean> {
    if (
      principal.ownerId !== config.ownerId ||
      !allowedClientIds.has(principal.clientId)
    ) {
      return false;
    }
    const { adapter } = await auth.$context;
    const user = await adapter.findOne<{ id: string }>({
      model: "user",
      where: [{ field: "id", value: principal.ownerId }],
      select: ["id"],
    });
    const client = await adapter.findOne<{ disabled?: boolean }>({
      model: "oauthClient",
      where: [{ field: "clientId", value: principal.clientId }],
      select: ["disabled"],
    });
    if (!user || !client || client.disabled === true) {
      return false;
    }
    const grants = await adapter.findMany<{
      scopes: string[];
      resources?: string[];
    }>({
      model: "oauthRefreshToken",
      where: [
        { field: "userId", value: principal.ownerId },
        { field: "clientId", value: principal.clientId },
        // Event authorization follows owner/client continuity. Offline grants
        // survive browser logout; the provider clears their sid via SET NULL.
        // Better Auth stores the revocation timestamp; an active grant is NULL.
        { field: "revoked", value: null },
        { field: "expiresAt", operator: "gt", value: new Date() },
      ],
      select: ["scopes", "resources"],
      limit: 100,
    });
    return grants.some(
      (grant) =>
        grant.scopes.includes("financial:read") &&
        grant.resources?.includes(resource),
    );
  }

  return {
    auth,
    provider,
    handlePublicRequest,
    migrate,
    bootstrapOwner,
    provisionPublicClient,
    issueOwnerLoginLink,
    hasActiveEventReadGrant,
  };
}
