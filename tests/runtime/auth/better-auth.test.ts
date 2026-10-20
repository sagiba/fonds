import { createHash, randomBytes } from "node:crypto";

import { memoryAdapter } from "better-auth/adapters/memory";
import { symmetricDecrypt } from "better-auth/crypto";
import { getSchema } from "better-auth/db";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { neonGoogleLogin } from "../../../deploy/neon/neon-login.js";
import {
  CHATGPT_CLIENT_ID,
  createBetterAuth,
} from "../../../src/runtime/auth/better-auth.js";
import { createHttpService } from "../../../src/transport/http.js";

const cimdSigning = vi.hoisted(() => ({
  privateKey: undefined as CryptoKey | undefined,
}));

// Exercise the real pinned issuer/protocol against synthetic in-memory adapter state.
// Hosted migrations/durability are verified separately against PostgreSQL.
vi.mock("better-auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("better-auth")>();
  return {
    ...original,
    betterAuth: (options: Parameters<typeof original.betterAuth>[0]) =>
      original.betterAuth({
        ...options,
        database: memoryAdapter(
          Object.fromEntries(
            Object.keys(getSchema(options!)).map((model) => [model, []]),
          ),
        ),
      }),
  };
});
vi.mock("@better-auth/cimd/node", async () => {
  const { generateKeyPair, exportJWK } = await import("jose");
  const pair = await generateKeyPair("RS256");
  cimdSigning.privateKey = pair.privateKey;
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "synthetic-chatgpt-client-key",
    alg: "RS256",
    use: "sig",
  };
  return {
    fetchClientMetadataResource: vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === "https://chatgpt.com/oauth/jwks.json") {
        return Response.json({ keys: [jwk] });
      }
      return Response.json({
        client_id: "https://chatgpt.com/oauth/client.json",
        client_name: "Synthetic ChatGPT",
        redirect_uris: ["https://chatgpt.com/oauth/synthetic-callback"],
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_signing_alg: "RS256",
        jwks_uri: "https://chatgpt.com/oauth/jwks.json",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }),
  };
});

const config = {
  publicOrigin: "https://fonds.example.invalid",
  secret: "synthetic-better-auth-secret-00000000000000000000",
  ownerId: "synthetic-owner",
  ownerEmail: "owner@example.invalid",
  allowedClientIds: ["synthetic-client"],
};
const redirect = "http://127.0.0.1:8765/callback";
const bodyRequest = (path: string, body: unknown, cookie?: string) =>
  new Request(`${config.publicOrigin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: config.publicOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

describe("single-owner Better Auth issuer", () => {
  let service: ReturnType<typeof createBetterAuth>;
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    service = createBetterAuth(new Pool(), config, { forSetup: true });
    await service.bootstrapOwner("Synthetic-only-password-1234");
    await service.provisionPublicClient({
      clientId: "synthetic-client",
      redirectUris: [redirect],
    });
  });

  async function grant(
    scopes = "openid offline_access financial:read",
    clientId = "synthetic-client",
    callbackUri = redirect,
    assertionOnly = false,
  ) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUri,
      response_type: "code",
      scope: scopes,
      resource: `${config.publicOrigin}/mcp`,
      state: "synthetic-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorize = await service.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/oauth2/authorize?${query}`),
    );
    expect(authorize?.status).toBe(302);
    const login = new URL(
      authorize!.headers.get("location")!,
      config.publicOrigin,
    );
    expect(login.pathname, login.href).toBe("/sign-in");
    const loginPage = await service.handlePublicRequest(new Request(login));
    expect(loginPage?.status).toBe(200);
    const signIn = await service.handlePublicRequest(
      bodyRequest("/api/auth/sign-in/email", {
        email: config.ownerEmail,
        password: "Synthetic-only-password-1234",
        oauth_query: login.search.slice(1),
      }),
    );
    expect(signIn?.status).toBe(200);
    const cookie = signIn!.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const next = (await signIn!.json()) as { url: string };
    const consent = new URL(next.url, config.publicOrigin);
    expect(consent.pathname).toBe("/consent");
    const consentPage = await service.handlePublicRequest(
      new Request(consent, { headers: { Cookie: cookie } }),
    );
    expect(consentPage?.status).toBe(200);
    const accepted = await service.handlePublicRequest(
      bodyRequest(
        "/api/auth/oauth2/consent",
        { accept: true, oauth_query: consent.search.slice(1) },
        cookie,
      ),
    );
    expect(accepted?.status).toBe(200);
    const result = (await accepted!.json()) as { url: string };
    const callback = new URL(result.url);
    expect(callback.searchParams.get("state")).toBe("synthetic-state");
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: callback.searchParams.get("code")!,
      redirect_uri: callbackUri,
      code_verifier: verifier,
      resource: `${config.publicOrigin}/mcp`,
    });
    if (clientId === CHATGPT_CLIENT_ID) {
      tokenBody.set(
        "client_assertion_type",
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      tokenBody.set("client_assertion", await clientAssertion());
      if (assertionOnly) {
        tokenBody.delete("client_id");
      }
    }
    const token = await service.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      }),
    );
    expect(token?.status).toBe(200);
    return (await token!.json()) as {
      access_token: string;
      refresh_token: string;
    };
  }

  async function clientAssertion(overrides: Record<string, unknown> = {}) {
    if (!cimdSigning.privateKey) {
      throw new Error("Synthetic client key missing");
    }
    return new SignJWT({
      iss: CHATGPT_CLIENT_ID,
      sub: CHATGPT_CLIENT_ID,
      aud: `${config.publicOrigin}/api/auth/oauth2/token`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: randomBytes(20).toString("hex"),
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-chatgpt-client-key" })
      .sign(cimdSigning.privateKey);
  }

  it("issues resource-bound owner tokens through password, consent and PKCE; refreshes durably stored grants", async () => {
    const tokens = await grant();
    const identity = await service.provider.authenticate(
      new Request(`${config.publicOrigin}/mcp`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(identity).toMatchObject({
      ownerId: config.ownerId,
      subject: config.ownerId,
      clientId: "synthetic-client",
      resource: `${config.publicOrigin}/mcp`,
    });
    expect(identity?.scopes).toContain("financial:read");
    expect(identity?.scopes).not.toContain("financial:write");
    const refreshed = await service.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "synthetic-client",
          refresh_token: tokens.refresh_token,
          resource: `${config.publicOrigin}/mcp`,
        }),
      }),
    );
    expect(refreshed?.status).toBe(200);
    const refreshedTokens = (await refreshed!.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(
      await service.provider.authenticate(
        new Request(`${config.publicOrigin}/mcp`, {
          headers: { Authorization: `Bearer ${refreshedTokens.access_token}` },
        }),
      ),
    ).toMatchObject({
      ownerId: config.ownerId,
      clientId: "synthetic-client",
      resource: `${config.publicOrigin}/mcp`,
    });
    const withoutResource = await service.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "synthetic-client",
          refresh_token: refreshedTokens.refresh_token,
        }),
      }),
    );
    expect(withoutResource?.status).toBe(200);
    const withoutResourceTokens = (await withoutResource!.json()) as {
      access_token: string;
    };
    expect(
      await service.provider.authenticate(
        new Request(`${config.publicOrigin}/mcp`, {
          headers: {
            Authorization: `Bearer ${withoutResourceTokens.access_token}`,
          },
        }),
      ),
    ).toMatchObject({
      ownerId: config.ownerId,
      clientId: "synthetic-client",
      resource: `${config.publicOrigin}/mcp`,
    });
    const parts = tokens.access_token.split(".");
    parts[1] = Buffer.from(JSON.stringify({ sub: "intruder" })).toString(
      "base64url",
    );
    expect(
      await service.provider.authenticate(
        new Request(`${config.publicOrigin}/mcp`, {
          headers: { Authorization: `Bearer ${parts.join(".")}` },
        }),
      ),
    ).toBeNull();
  });

  it.each([false, true])(
    "discovers/resource-links ChatGPT CIMD and verifies private_key_jwt (assertion-only=%s)",
    async (assertionOnly) => {
      const tokens = await grant(
        "openid offline_access financial:read",
        CHATGPT_CLIENT_ID,
        "https://chatgpt.com/oauth/synthetic-callback",
        assertionOnly,
      );
      expect(
        await service.provider.authenticate(
          new Request(`${config.publicOrigin}/mcp`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          }),
        ),
      ).toMatchObject({
        ownerId: config.ownerId,
        clientId: CHATGPT_CLIENT_ID,
        resource: `${config.publicOrigin}/mcp`,
      });
    },
  );

  it("delegates only admitted Google bridge routes to the injected bridge", async () => {
    const start = vi.fn(async () => new Response("started"));
    const finish = vi.fn(async () => new Response("finished"));
    const googleLogin = vi.fn(() => ({
      plugin: { id: "synthetic-google-bridge" },
      schema: "",
      start,
      finish,
    }));
    const pool = new Pool();
    const runtime = createBetterAuth(pool, { ...config, googleLogin });
    expect(googleLogin).toHaveBeenCalledWith(pool, {
      baseURL: config.publicOrigin,
      ownerId: config.ownerId,
      secret: config.secret,
    });
    const route = (path: string, init: RequestInit = {}) =>
      runtime.handlePublicRequest(
        new Request(`${config.publicOrigin}${path}`, init),
      );
    for (const [path, init, status] of [
      ["/google/start?client_id=unknown-client", {}, 400],
      ["/google/start?client_id=synthetic-client", { method: "POST" }, 405],
      [
        "/google/start?client_id=synthetic-client",
        { headers: { Origin: "https://attacker.invalid" } },
        403,
      ],
    ] as const) {
      expect((await route(path, init))?.status).toBe(status);
    }
    expect(start).not.toHaveBeenCalled();
    const started = await route("/google/start?client_id=synthetic-client");
    expect(await started?.text()).toBe("started");
    expect(start).toHaveBeenCalledOnce();
    const finished = await route("/google/callback?state=synthetic");
    expect(await finished?.text()).toBe("finished");
    expect(finish).toHaveBeenCalledWith(
      expect.any(Request),
      runtime.auth.handler,
    );
    const withoutBridge = createBetterAuth(new Pool(), config);
    expect(
      (
        await withoutBridge.handlePublicRequest(
          new Request(`${config.publicOrigin}/google/start`),
        )
      )?.status,
    ).toBe(404);
  });

  it("keeps deployed sign-in to passkeys and Google and rejects public password, signup and login-link routes", async () => {
    const runtime = createBetterAuth(new Pool(), {
      ...config,
      googleLogin: neonGoogleLogin({
        upstreamURL: "https://managed.neon.tech/neondb/auth",
        allowedEmail: "owner@example.invalid",
      }),
    });
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/magic-link",
      "/api/auth/sign-in/social",
      "/api/auth/link-social",
      "/api/auth/passkey/update-passkey",
    ]) {
      expect(
        (
          await runtime.handlePublicRequest(
            bodyRequest(path, {
              email: config.ownerEmail,
              password: "Synthetic-only-password-1234",
            }),
          )
        )?.status,
      ).toBe(404);
    }
    const authorize = new URL(
      `${config.publicOrigin}/api/auth/oauth2/authorize`,
    );
    authorize.search = new URLSearchParams({
      client_id: "synthetic-client",
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid financial:read",
      resource: `${config.publicOrigin}/mcp`,
      state: "synthetic-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update("synthetic-proof")
        .digest("base64url"),
    }).toString();
    const started = await service.handlePublicRequest(new Request(authorize));
    const loginUrl =
      started!.headers.get("location") ??
      ((await started!.json()) as { url: string }).url;
    const loginLocation = new URL(loginUrl, config.publicOrigin);
    expect(loginLocation.pathname).toBe("/sign-in");
    const page = await runtime.handlePublicRequest(new Request(loginLocation));
    expect(page?.status).toBe(200);
    const html = await page!.text();
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Sign in with a passkey");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("/api/auth/sign-in/email");
    expect(html).not.toContain("/api/auth/sign-in/social");
  });

  it("checks the owner's active client grant independently of browser-session expiry or deletion", async () => {
    const tokens = await grant();
    const identity = await service.provider.authenticate(
      new Request(`${config.publicOrigin}/mcp`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(identity?.sessionId).toEqual(expect.any(String));
    const principal = {
      ownerId: config.ownerId,
      clientId: "synthetic-client",
      sessionId: identity!.sessionId!,
    };
    expect(await service.hasActiveEventReadGrant(principal)).toBe(true);
    const { adapter } = await service.auth.$context;
    await adapter.update({
      model: "session",
      where: [{ field: "id", value: principal.sessionId }],
      update: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await service.hasActiveEventReadGrant(principal)).toBe(true);
    const refreshed = await service.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: principal.clientId,
          refresh_token: tokens.refresh_token,
        }),
      }),
    );
    expect(refreshed?.status).toBe(200);
    const rotated = (await refreshed!.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(decodeJwt(rotated.access_token).sid).toBe(principal.sessionId);
    expect(await service.hasActiveEventReadGrant(principal)).toBe(true);
    // Match PostgreSQL's ON DELETE SET NULL, which the memory adapter does not enforce.
    await adapter.delete({
      model: "session",
      where: [{ field: "id", value: principal.sessionId }],
    });
    await adapter.update({
      model: "oauthRefreshToken",
      where: [
        { field: "sessionId", value: principal.sessionId },
        { field: "revoked", value: null },
      ],
      update: { sessionId: null },
    });
    expect(await service.hasActiveEventReadGrant(principal)).toBe(true);
    expect(
      await service.hasActiveEventReadGrant({
        ownerId: principal.ownerId,
        clientId: principal.clientId,
      }),
    ).toBe(true);
    expect(
      await service.hasActiveEventReadGrant({
        ...principal,
        ownerId: "another-owner",
      }),
    ).toBe(false);
    const revoked = await service.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "synthetic-client",
          token: rotated.refresh_token,
          token_type_hint: "refresh_token",
        }),
      }),
    );
    expect(revoked?.status).toBe(200);
    expect(await service.hasActiveEventReadGrant(principal)).toBe(false);
    await grant("openid profile offline_access financial:read");
    // Renewed authorization for this same owner/client restores grant continuity.
    expect(await service.hasActiveEventReadGrant(principal)).toBe(true);
  });

  it.each([
    "revoked",
    "expired",
    "no-read-scope",
    "no-resource",
    "wrong-resource",
    "disabled-client",
    "deleted-client",
    "deleted-owner",
  ] as const)("rejects an event grant with %s", async (scenario) => {
    const tokens = await grant();
    const principal = {
      ownerId: config.ownerId,
      clientId: "synthetic-client",
      sessionId: decodeJwt(tokens.access_token).sid as string,
    };
    const { adapter } = await service.auth.$context;
    if (scenario === "disabled-client") {
      await adapter.update({
        model: "oauthClient",
        where: [{ field: "clientId", value: principal.clientId }],
        update: { disabled: true },
      });
    } else if (scenario === "deleted-client") {
      await adapter.delete({
        model: "oauthClient",
        where: [{ field: "clientId", value: principal.clientId }],
      });
    } else if (scenario === "deleted-owner") {
      await adapter.delete({
        model: "user",
        where: [{ field: "id", value: principal.ownerId }],
      });
    } else {
      const updates = {
        revoked: { revoked: new Date() },
        expired: { expiresAt: new Date(Date.now() - 60_000) },
        "no-read-scope": { scopes: ["offline_access", "financial:write"] },
        "no-resource": { resources: null },
        "wrong-resource": { resources: ["https://wrong.invalid/mcp"] },
      };
      await adapter.update({
        model: "oauthRefreshToken",
        where: [{ field: "sessionId", value: principal.sessionId }],
        update: updates[scenario],
      });
    }
    expect(await service.hasActiveEventReadGrant(principal)).toBe(false);
  });

  it("accepts verified assertion-only revocation and rejects mismatched explicit clients", async () => {
    const tokens = await grant(
      "openid offline_access financial:read",
      CHATGPT_CLIENT_ID,
      "https://chatgpt.com/oauth/synthetic-callback",
      true,
    );
    for (const explicitClient of ["synthetic-client", CHATGPT_CLIENT_ID]) {
      const mismatched = await service.handlePublicRequest(
        new Request(`${config.publicOrigin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: explicitClient,
            refresh_token: tokens.refresh_token,
            client_assertion_type:
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: await clientAssertion(
              explicitClient === CHATGPT_CLIENT_ID
                ? { sub: "synthetic-client" }
                : {},
            ),
          }),
        }),
      );
      expect([400, 401]).toContain(mismatched?.status);
    }
    const revoked = await service.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await clientAssertion({
            aud: service.provider.issuer,
          }),
        }),
      }),
    );
    expect(revoked?.status).toBe(200);
  });

  it("rejects invalid ChatGPT private-key assertions and logs only fixed diagnostic values", async () => {
    await grant(
      "openid offline_access financial:read",
      CHATGPT_CLIENT_ID,
      "https://chatgpt.com/oauth/synthetic-callback",
    );
    for (const assertion of [
      await clientAssertion({ aud: "https://wrong.invalid/token" }),
      await clientAssertion({ exp: 1 }),
      "malformed.synthetic.assertion",
    ]) {
      const response = await service.handlePublicRequest(
        new Request(`${config.publicOrigin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CHATGPT_CLIENT_ID,
            refresh_token: "synthetic-invalid-refresh",
            client_assertion_type:
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: assertion,
          }),
        }),
      );
      expect([400, 401]).toContain(response?.status);
      expect(await response!.json()).toMatchObject({ error: "invalid_client" });
    }
    const logged = vi
      .mocked(console.info)
      .mock.calls.map(
        ([value]) => JSON.parse(value as string) as Record<string, unknown>,
      );
    expect(logged.at(-1)).toEqual({
      event: "fonds_auth_response",
      route: "/api/auth/oauth2/token",
      client: "chatgpt",
      status: expect.any(Number),
      error: "invalid_client",
    });
    expect(JSON.stringify(logged)).not.toContain(
      "Synthetic-only-password-1234",
    );
    expect(JSON.stringify(logged)).not.toContain("synthetic-invalid-refresh");
    expect(JSON.stringify(logged)).not.toContain("client_assertion");
  });

  it("serves protected-resource and issuer discovery through the actual HTTP wrapper and advertises refresh access", async () => {
    const http = createHttpService(
      { backend: "postgres", operations: [] },
      {
        publicOrigin: config.publicOrigin,
        ownerId: config.ownerId,
        authProvider: service.provider,
        publicRoutes: service.handlePublicRequest,
      },
    );
    try {
      const anonymous = await http.app.request(`${config.publicOrigin}/mcp`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain(
        'scope="openid profile offline_access financial:read financial:write"',
      );
      const protectedResource = await http.app.request(
        `${config.publicOrigin}/.well-known/oauth-protected-resource/mcp`,
      );
      expect(protectedResource.status).toBe(200);
      const metadata = (await protectedResource.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
      };
      expect(metadata.resource).toBe(`${config.publicOrigin}/mcp`);
      expect(metadata.authorization_servers).toEqual([service.provider.issuer]);
      expect(metadata.scopes_supported).toContain("offline_access");
      for (const path of [
        "/.well-known/oauth-authorization-server/api/auth",
        "/api/auth/.well-known/oauth-authorization-server",
      ]) {
        const response = await http.app.request(
          `${config.publicOrigin}${path}`,
        );
        expect(response.status).toBe(200);
        const issuerMetadata = (await response.json()) as Record<
          string,
          unknown
        >;
        expect(issuerMetadata.issuer).toBe(service.provider.issuer);
        expect(issuerMetadata.code_challenge_methods_supported).toContain(
          "S256",
        );
        expect(issuerMetadata.client_id_metadata_document_supported).toBe(true);
        expect(issuerMetadata.registration_endpoint).toBeUndefined();
      }
    } finally {
      await http.close();
    }
  });

  it("supports an explicit financial write consent and renders the consequences", async () => {
    const tokens = await grant(
      "openid offline_access financial:read financial:write",
    );
    expect(
      (
        await service.provider.authenticate(
          new Request(`${config.publicOrigin}/v1/connections`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          }),
        )
      )?.scopes,
    ).toContain("financial:write");
  });

  it("rejects issuer-signed tokens for another owner, client, issuer, audience, expired grant or sender binding", async () => {
    const tokens = await grant();
    const context = await service.auth.$context;
    // These are exclusively fresh, synthetic memory-adapter signing keys.
    const stored = await context.adapter.findOne<{
      id: string;
      alg: string;
      privateKey: string;
    }>({ model: "jwks", where: [] });
    if (!stored) {
      throw new Error("Synthetic signing key missing");
    }
    const key = await importJWK(
      JSON.parse(
        await symmetricDecrypt({
          key: context.secretConfig,
          data: JSON.parse(stored.privateKey),
        }),
      ),
      stored.alg,
    );
    const claims = decodeJwt(tokens.access_token);
    for (const override of [
      { sub: "another-owner" },
      { client_id: "not-allowed", azp: "not-allowed" },
      { azp: "different-client" },
      { aud: "https://elsewhere.invalid/mcp" },
      {
        aud: [
          "https://fonds.example.invalid/mcp",
          "https://elsewhere.invalid/mcp",
        ],
      },
      { iss: "https://other-issuer.invalid/api/auth" },
      { exp: Math.floor(Date.now() / 1000) - 60 },
      { cnf: { jkt: "synthetic-binding" } },
    ]) {
      const token = await new SignJWT({ ...claims, ...override })
        .setProtectedHeader({ alg: stored.alg, kid: stored.id, typ: "at+jwt" })
        .sign(key);
      expect(
        await service.provider.authenticate(
          new Request(`${config.publicOrigin}/mcp`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ),
        JSON.stringify(override),
      ).toBeNull();
    }
  });

  it("rejects arbitrary clients, metadata URLs, public signup and registration before issuer handling", async () => {
    for (const client of [
      "unregistered-client",
      "https://attacker.example/client.json",
      `${CHATGPT_CLIENT_ID}?evil=1`,
    ]) {
      const response = await service.handlePublicRequest(
        new Request(
          `${config.publicOrigin}/api/auth/oauth2/authorize?client_id=${encodeURIComponent(client)}`,
        ),
      );
      expect(response?.status).toBe(400);
      expect(await response!.json()).toEqual({ error: "invalid_client" });
    }
    for (const path of [
      "/sign-up/email",
      "/oauth2/register",
      "/oauth2/create-client",
      "/oauth2/admin/create-client",
      "/update-user",
    ]) {
      expect(
        (await service.handlePublicRequest(bodyRequest(`/api/auth${path}`, {})))
          ?.status,
      ).toBe(404);
    }
    expect(
      await service.handlePublicRequest(
        new Request(`${config.publicOrigin}/v1/transactions`),
      ),
    ).toBeNull();
    expect(
      (
        await service.handlePublicRequest(
          new Request(`${config.publicOrigin}/api/auth/jwks`, {
            headers: { Origin: "https://evil.invalid" },
          }),
        )
      )?.status,
    ).toBe(403);
  });

  it("rejects forged page queries and disables setup in the runtime factory", async () => {
    expect(
      (
        await service.handlePublicRequest(
          new Request(
            `${config.publicOrigin}/sign-in?client_id=synthetic-client&scope=financial:write`,
          ),
        )
      )?.status,
    ).toBe(400);
    const runtime = createBetterAuth(new Pool(), config);
    await expect(
      runtime.bootstrapOwner("Synthetic-only-password-1234"),
    ).rejects.toThrow("setup is disabled");
    await expect(
      runtime.provisionPublicClient({
        clientId: "synthetic-client",
        redirectUris: [redirect],
      }),
    ).rejects.toThrow("setup is disabled");
    await expect(
      runtime.auth.api.signUpEmail({
        body: {
          email: config.ownerEmail,
          name: "Owner",
          password: "Synthetic-only-password-1234",
        },
      }),
    ).rejects.toThrow();
    expect(await service.bootstrapOwner("Unused-repeat-password-123")).toEqual({
      id: config.ownerId,
      email: config.ownerEmail,
    });
    await service.provisionPublicClient({
      clientId: "synthetic-client",
      redirectUris: [redirect],
    });
    await expect(
      service.provisionPublicClient({
        clientId: "synthetic-client",
        redirectUris: ["http://127.0.0.1:8765/other"],
      }),
    ).rejects.toThrow("differs");
  });
});
