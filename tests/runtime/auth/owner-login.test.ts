import { createHash, randomBytes } from "node:crypto";

import { memoryAdapter } from "better-auth/adapters/memory";
import { getSchema } from "better-auth/db";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBetterAuth } from "../../../src/runtime/auth/better-auth.js";
import { syntheticAuthenticator } from "../../helpers/webauthn.js";

// Exercise the real pinned issuer and plugins against synthetic in-memory state.
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
const config = {
  publicOrigin: "https://fonds.example.invalid",
  secret: "synthetic-better-auth-secret-00000000000000000000",
  ownerId: "synthetic-owner",
  ownerEmail: "owner@example.invalid",
  allowedClientIds: ["synthetic-client"],
};
const redirect = "http://127.0.0.1:8765/callback";

const cookiesOf = (response: Response, previous = "") => {
  const jar = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair]),
  );
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0]!;
    jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }
  return [...jar.values()].join("; ");
};

describe("owner login methods", () => {
  let service: ReturnType<typeof createBetterAuth>;
  let authenticator: ReturnType<typeof syntheticAuthenticator>;

  const request = (
    path: string,
    init: RequestInit & { cookie?: string } = {},
  ) =>
    service.handlePublicRequest(
      new Request(`${config.publicOrigin}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Origin: config.publicOrigin,
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
      }),
    ) as Promise<Response>;
  const post = (path: string, body: unknown, cookie?: string) =>
    request(path, {
      method: "POST",
      body: JSON.stringify(body),
      ...(cookie ? { cookie } : {}),
    });

  async function signInWithLink() {
    const link = new URL(await service.issueOwnerLoginLink());
    const verified = await request(link.pathname + link.search);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(
      `${config.publicOrigin}/account`,
    );
    return { link, cookie: cookiesOf(verified) };
  }

  async function signedOAuthQuery() {
    const query = new URLSearchParams({
      client_id: "synthetic-client",
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid financial:read",
      resource: `${config.publicOrigin}/mcp`,
      state: "synthetic-state",
      code_challenge: createHash("sha256")
        .update(randomBytes(32).toString("base64url"))
        .digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorize = await request(`/api/auth/oauth2/authorize?${query}`);
    const login = new URL(
      authorize.headers.get("location")!,
      config.publicOrigin,
    );
    expect(login.pathname).toBe("/sign-in");
    return login.search.slice(1);
  }

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    authenticator = syntheticAuthenticator(
      "fonds.example.invalid",
      config.publicOrigin,
    );
    service = createBetterAuth(new Pool(), config, { forSetup: true });
    await service.bootstrapOwner("Synthetic-only-password-1234");
    await service.provisionPublicClient({
      clientId: "synthetic-client",
      redirectUris: [redirect],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues login links only server-side, stores their hash and accepts each once", async () => {
    const deployed = createBetterAuth(new Pool(), config);
    await expect(deployed.issueOwnerLoginLink()).rejects.toThrow(
      "Auth setup is disabled",
    );
    expect(
      (await post("/api/auth/sign-in/magic-link", { email: config.ownerEmail }))
        .status,
    ).toBe(404);
    const link = new URL(await service.issueOwnerLoginLink());
    expect(link.pathname).toBe("/api/auth/magic-link/verify");
    const token = link.searchParams.get("token")!;
    const { adapter } = await service.auth.$context;
    const pending = await adapter.findMany<{
      identifier: string;
      value: string;
    }>({ model: "verification" });
    expect(pending.map((row) => row.identifier)).toContain(
      `magic-link:${createHash("sha256").update(token).digest("base64url")}`,
    );
    expect(
      pending.some(
        (row) => row.identifier.includes(token) || row.value.includes(token),
      ),
    ).toBe(false);
    const verified = await request(link.pathname + link.search);
    expect(cookiesOf(verified)).toMatch(/session_token=/);
    const reused = await request(link.pathname + link.search);
    expect(reused.headers.getSetCookie().join()).not.toMatch(/session_token=/);
    expect(reused.headers.get("location")).toMatch(/error=/);
  });

  it("keeps the owner's setup credential and reruns setup after a login link", async () => {
    await signInWithLink();
    await signInWithLink();
    const { adapter } = await service.auth.$context;
    expect(
      await adapter.findMany({
        model: "account",
        where: [{ field: "providerId", value: "credential" }],
      }),
    ).toHaveLength(1);
    await expect(
      service.bootstrapOwner("Synthetic-only-password-1234"),
    ).resolves.toMatchObject({ id: config.ownerId });
    expect(
      await adapter.findOne({
        model: "user",
        where: [{ field: "id", value: config.ownerId }],
      }),
    ).toMatchObject({ emailVerified: true });
  });

  it("repairs an owner created unverified before issuing a recovery link", async () => {
    const { adapter } = await service.auth.$context;
    // The owner shape earlier setups left behind.
    await adapter.update({
      model: "user",
      where: [{ field: "id", value: config.ownerId }],
      update: { emailVerified: false },
    });
    await signInWithLink();
    expect(
      await adapter.findMany({
        model: "account",
        where: [{ field: "providerId", value: "credential" }],
      }),
    ).toHaveLength(1);
    expect(
      await adapter.findOne({
        model: "user",
        where: [{ field: "id", value: config.ownerId }],
      }),
    ).toMatchObject({ emailVerified: true });
  });

  it("refuses a login link before setup created the owner", async () => {
    const empty = createBetterAuth(new Pool(), config, { forSetup: true });
    await expect(empty.issueOwnerLoginLink()).rejects.toThrow(
      "Run setup first",
    );
  });

  it("rejects an expired login link", async () => {
    const link = new URL(await service.issueOwnerLoginLink());
    const { adapter } = await service.auth.$context;
    await adapter.updateMany({
      model: "verification",
      where: [],
      update: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await request(link.pathname + link.search);
    expect(expired.headers.getSetCookie().join()).not.toMatch(/session_token=/);
  });

  it("serves the account page only to the signed-in owner, with private page headers", async () => {
    const anonymous = await request("/account");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toContain("login link");
    const { cookie } = await signInWithLink();
    const page = await request("/account", { cookie });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toMatch(
      /script-src 'nonce-[^']+'; connect-src 'self'/,
    );
    const html = await page.text();
    expect(html).toContain("No passkeys yet");
    expect(html).toContain('data-action="add-passkey"');
    expect(html).not.toContain(config.ownerEmail);
  });

  async function registerPasskey(cookie: string, userVerified = true) {
    const options = await request(
      "/api/auth/passkey/generate-register-options",
      {
        cookie,
      },
    );
    expect(options.status).toBe(200);
    const body = (await options.json()) as {
      challenge: string;
      rp: { id: string };
      authenticatorSelection: { userVerification: string; residentKey: string };
    };
    expect(body.rp.id).toBe("fonds.example.invalid");
    expect(body.authenticatorSelection).toMatchObject({
      userVerification: "required",
      residentKey: "required",
    });
    return post(
      "/api/auth/passkey/verify-registration",
      { response: authenticator.register(body.challenge, userVerified) },
      cookiesOf(options, cookie),
    );
  }

  it("registers passkeys only for a signed-in owner whose device verified them", async () => {
    expect(
      (await request("/api/auth/passkey/generate-register-options")).status,
    ).toBe(401);
    const { cookie } = await signInWithLink();
    const unverified = await registerPasskey(cookie, false);
    expect(unverified.status).toBe(401);
    expect(await unverified.json()).toMatchObject({
      message: "Passkey user verification is required.",
    });
    const { adapter } = await service.auth.$context;
    expect(await adapter.findMany({ model: "passkey" })).toEqual([]);
    expect((await registerPasskey(cookie)).status).toBe(200);
    expect(await adapter.findMany({ model: "passkey" })).toEqual([
      expect.objectContaining({
        userId: config.ownerId,
        credentialID: authenticator.id,
      }),
    ]);
    const page = await (await request("/account", { cookie })).text();
    expect(page).toContain('data-action="remove-passkey"');
  });

  async function passkeySignIn(oauthQuery: string, userVerified = true) {
    const options = await request(
      "/api/auth/passkey/generate-authenticate-options",
    );
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    return post(
      "/api/auth/passkey/verify-authentication",
      {
        response: authenticator.authenticate(challenge, userVerified),
        oauth_query: oauthQuery,
      },
      cookiesOf(options),
    );
  }

  it("signs in with a verified passkey and resumes the signed OAuth authorization", async () => {
    const { cookie } = await signInWithLink();
    expect((await registerPasskey(cookie)).status).toBe(200);
    const oauthQuery = await signedOAuthQuery();
    const unverified = await passkeySignIn(oauthQuery, false);
    expect(unverified.status).toBe(401);
    expect(await unverified.clone().json()).toMatchObject({
      message: "Passkey user verification is required.",
    });
    expect(unverified.headers.getSetCookie().join()).not.toMatch(
      /session_token=/,
    );
    const verified = await passkeySignIn(oauthQuery);
    expect(verified.status).toBe(200);
    expect(verified.headers.getSetCookie().join()).toMatch(/session_token=/);
    const next = (await verified.json()) as { url: string };
    expect(new URL(next.url, config.publicOrigin).pathname).toBe("/consent");
  });

  it("offers a passkey on the sign-in page and keeps the login-link hint", async () => {
    const page = await request(`/sign-in?${await signedOAuthQuery()}`);
    const html = await page.text();
    expect(html).toContain('data-action="passkey"');
    expect(html).toContain("userVerification:'required'");
    expect(html).toContain("login link from your deployment");
    expect(html).not.toContain("/api/auth/sign-in/social");
  });
});

describe("owner-linked social login", () => {
  let service: ReturnType<typeof createBetterAuth>;
  let googleSubject: string;

  const request = (
    path: string,
    init: RequestInit & { cookie?: string } = {},
  ) =>
    service.handlePublicRequest(
      new Request(`${config.publicOrigin}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Origin: config.publicOrigin,
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
      }),
    ) as Promise<Response>;

  /** Starts a Google flow and completes its callback with the synthetic subject. */
  async function googleCallback(path: string, body: unknown, cookie = "") {
    const started = await request(path, {
      method: "POST",
      body: JSON.stringify(body),
      ...(cookie ? { cookie } : {}),
    });
    expect(started.status).toBe(200);
    const authorization = new URL(
      ((await started.json()) as { url: string }).url,
    );
    expect(authorization.origin).toBe("https://accounts.google.com");
    return request(
      `/api/auth/callback/google?code=synthetic-code&state=${authorization.searchParams.get("state")}`,
      { cookie: cookiesOf(started, cookie) },
    );
  }

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    googleSubject = "google-owner-account";
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url !== "https://oauth2.googleapis.com/token") {
        return realFetch(input, init);
      }
      const claims = Buffer.from(
        JSON.stringify({
          sub: googleSubject,
          email: "someone@synthetic.invalid",
          email_verified: true,
          name: "Synthetic Person",
        }),
      ).toString("base64url");
      return Response.json({
        access_token: "synthetic-access-token",
        id_token: `eyJhbGciOiJub25lIn0.${claims}.`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    service = createBetterAuth(
      new Pool(),
      {
        ...config,
        socialLogin: {
          google: {
            clientId: "synthetic-google-client",
            clientSecret: "synthetic-google-secret",
          },
        },
      },
      { forSetup: true },
    );
    await service.bootstrapOwner("Synthetic-only-password-1234");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs in only with the provider account the signed-in owner linked", async () => {
    const unlinked = await googleCallback("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/",
      disableRedirect: true,
    });
    expect(unlinked.headers.getSetCookie().join()).not.toMatch(
      /session_token=/,
    );
    expect(
      (
        await request("/api/auth/link-social", {
          method: "POST",
          body: JSON.stringify({ provider: "google" }),
        })
      ).status,
    ).toBe(401);
    const link = new URL(await service.issueOwnerLoginLink());
    const owner = cookiesOf(await request(link.pathname + link.search));
    const linked = await googleCallback(
      "/api/auth/link-social",
      { provider: "google", callbackURL: "/account", disableRedirect: true },
      owner,
    );
    expect(
      new URL(linked.headers.get("location")!, config.publicOrigin).pathname,
    ).toBe("/account");
    const { adapter } = await service.auth.$context;
    expect(
      await adapter.findMany({
        model: "account",
        where: [{ field: "providerId", value: "google" }],
      }),
    ).toEqual([
      expect.objectContaining({
        userId: config.ownerId,
        accountId: "google-owner-account",
        accessToken: null,
        refreshToken: null,
        idToken: null,
      }),
    ]);
    const signedIn = await googleCallback("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/",
      disableRedirect: true,
    });
    expect(signedIn.headers.getSetCookie().join()).toMatch(/session_token=/);
    const [account] = await adapter.findMany<Record<string, unknown>>({
      model: "account",
      where: [{ field: "providerId", value: "google" }],
    });
    expect(account).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    googleSubject = "google-other-account";
    const other = await googleCallback("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/",
      disableRedirect: true,
    });
    expect(other.headers.getSetCookie().join()).not.toMatch(/session_token=/);
    const users = await adapter.findMany<{ id: string; email: string }>({
      model: "user",
    });
    expect(users).toEqual([
      expect.objectContaining({ id: config.ownerId, email: config.ownerEmail }),
    ]);
    // A later login link keeps the binding; the account page unlinks by account ID.
    const again = new URL(await service.issueOwnerLoginLink());
    const session = cookiesOf(await request(again.pathname + again.search));
    const page = await (await request("/account", { cookie: session })).text();
    const accountId = /data-action="unlink" data-id="([^"]+)"/.exec(page)?.[1];
    expect(accountId).toBeDefined();
    const removal = await request("/api/auth/unlink-account", {
      method: "POST",
      body: JSON.stringify({ accountId }),
      cookie: session,
    });
    expect(removal.status).toBe(200);
    expect(
      await adapter.findMany({
        model: "account",
        where: [{ field: "providerId", value: "google" }],
      }),
    ).toEqual([]);
  });

  it("offers GitHub as a configured provider with its own callback route", async () => {
    const github = createBetterAuth(new Pool(), {
      ...config,
      socialLogin: {
        github: {
          clientId: "synthetic-github-client",
          clientSecret: "synthetic-github-secret",
        },
      },
    });
    const started = await github.handlePublicRequest(
      new Request(`${config.publicOrigin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: config.publicOrigin,
        },
        body: JSON.stringify({ provider: "github", disableRedirect: true }),
      }),
    );
    expect(started?.status).toBe(200);
    expect(
      new URL(((await started!.json()) as { url: string }).url).origin,
    ).toBe("https://github.com");
    expect(
      (
        await github.handlePublicRequest(
          new Request(`${config.publicOrigin}/api/auth/callback/google`),
        )
      )?.status,
    ).toBe(404);
    expect(
      (
        await github.handlePublicRequest(
          new Request(`${config.publicOrigin}/api/auth/callback/github`),
        )
      )?.status,
    ).not.toBe(404);
  });

  it("rejects configuring both a Google bridge and the Google provider", () => {
    expect(() =>
      createBetterAuth(new Pool(), {
        ...config,
        socialLogin: {
          google: { clientId: "synthetic", clientSecret: "synthetic" },
        },
        googleLogin: () => ({
          plugin: { id: "synthetic-google-bridge" },
          schema: "",
          start: async () => new Response(),
          finish: async () => new Response(),
        }),
      }),
    ).toThrow("Configure one Google login");
  });
});
