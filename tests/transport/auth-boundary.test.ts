import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type Application,
  createApplication,
  operationDefinitions,
} from "../../src/application/operations.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import type {
  HostedAuthProvider,
  TrustedIdentity,
} from "../../src/transport/auth.js";
import { operationScope } from "../../src/transport/auth.js";
import {
  createHttpService,
  type HttpServiceOptions,
} from "../../src/transport/http.js";
import { createMcpHttpHandler } from "../../src/transport/mcp.js";

const publicOrigin = "https://financial.synthetic.invalid";
const issuer = "https://issuer.synthetic.invalid/auth";
const endpoints = {
  authorization: `${issuer}/authorize`,
  token: `${issuer}/token`,
};
const token = "synthetic-local-token-00000000000000000000";
const expectedScopes = {
  list_connections: "financial:read",
  get_connection: "financial:read",
  list_cards: "financial:read",
  get_card: "financial:read",
  list_accounts: "financial:read",
  get_account: "financial:read",
  list_transactions: "financial:read",
  get_transaction: "financial:read",
  get_transaction_totals: "financial:read",
  list_events: "financial:read",
  list_sync_runs: "financial:read",
  update_annotation: "financial:write",
  refresh_connection: "financial:write",
  get_refresh: "financial:read",
  list_refreshes: "financial:read",
  undo_annotation: "financial:write",
  link_pending_transaction: "financial:write",
  unlink_pending_transaction: "financial:write",
  confirm_removal: "financial:write",
} as const;
const routes = [
  ["list_connections", "GET", "/v1/connections"],
  ["get_connection", "GET", "/v1/connections/synthetic"],
  ["list_accounts", "GET", "/v1/accounts"],
  ["get_account", "GET", "/v1/accounts/synthetic"],
  ["list_cards", "GET", "/v1/cards"],
  ["get_card", "GET", "/v1/cards/synthetic"],
  ["list_transactions", "GET", "/v1/transactions"],
  ["get_transaction", "GET", "/v1/transactions/synthetic"],
  ["get_transaction_totals", "GET", "/v1/transactions/totals"],
  ["list_events", "GET", "/v1/events"],
  ["list_sync_runs", "GET", "/v1/connections/synthetic/sync-runs"],
  ["update_annotation", "PATCH", "/v1/transactions/synthetic/annotation"],
  ["refresh_connection", "POST", "/v1/connections/synthetic/refreshes"],
  ["refresh_connection", "POST", "/v1/refreshes"],
  ["get_refresh", "GET", "/v1/refreshes/synthetic"],
  ["list_refreshes", "GET", "/v1/connections/synthetic/refreshes"],
  ["undo_annotation", "POST", "/v1/annotations/undo"],
  [
    "link_pending_transaction",
    "POST",
    "/v1/transactions/synthetic/link-pending",
  ],
  [
    "unlink_pending_transaction",
    "POST",
    "/v1/transactions/synthetic/unlink-pending",
  ],
  ["confirm_removal", "POST", "/v1/transactions/synthetic/removal"],
] as const;
const services: ReturnType<typeof createHttpService>[] = [];
const clients: Client[] = [];

function identity(
  scopes: readonly string[],
  overrides: Partial<TrustedIdentity> = {},
): TrustedIdentity {
  return {
    source: "synthetic-issuer",
    subject: "synthetic-subject",
    ownerId: "owner-1",
    resource: `${publicOrigin}/mcp`,
    clientId: "synthetic-client",
    scopes,
    ...overrides,
  };
}

function setup(
  provider?: HostedAuthProvider,
  application: Application = {
    backend: "sqlite",
    operations: operationDefinitions.map((definition) => ({
      ...definition,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ name: z.string() }).strict(),
      execute: vi.fn(async () => ({ name: definition.name })),
    })),
  },
) {
  const authProvider = provider ?? {
    issuer,
    endpoints,
    async authenticate(request: Request) {
      const credential = request.headers.get("authorization");
      if (credential === "Bearer read") {
        return identity(["financial:read"]);
      }
      if (credential === "Bearer write") {
        return identity(["financial:write"]);
      }
      if (credential === "Bearer both") {
        return identity(["financial:read", "financial:write"]);
      }
      if (credential === "Bearer neither") {
        return identity(["financial"]);
      }
      return null;
    },
  };
  const service = createHttpService(application, {
    publicOrigin,
    ownerId: "owner-1",
    authProvider,
  });
  services.push(service);
  const request = (path: string, bearer?: string, init: RequestInit = {}) =>
    service.app.request(`${publicOrigin}${path}`, {
      ...init,
      headers: {
        ...(bearer && { authorization: `Bearer ${bearer}` }),
        ...(init.body !== undefined && { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  return { application, service, request };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("hosted trusted auth boundary", () => {
  it("rejects hosted MCP discovery and initialization without any financial grant", async () => {
    const { application, request } = setup();
    for (const method of ["server/discover", "initialize", "tools/list"]) {
      const response = await request("/mcp", "neither", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toContain(
        'error="insufficient_scope"',
      );
      expect(await response.json()).toEqual({
        error: { code: "forbidden", message: "Permission denied." },
      });
    }
    expect((await request("/mcp", "neither")).status).toBe(403);
    for (const operation of application.operations) {
      expect(operation.execute).not.toHaveBeenCalled();
    }
  });

  it("denies raw HTTP MCP tool execution by default when no grants were supplied", async () => {
    const { application } = setup();
    const handler = createMcpHttpHandler(application);
    const client = new Client({
      name: "synthetic-untrusted-raw-client",
      version: "1",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`), {
          fetch: async (input, init) => handler.fetch(new Request(input, init)),
        }),
      );
      for (const name of ["list_connections", "update_annotation"]) {
        expect(await client.callTool({ name, arguments: {} })).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "forbidden" } },
        });
      }
      for (const operation of application.operations) {
        expect(operation.execute).not.toHaveBeenCalled();
      }
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("advertises the exact shared /mcp resource and external issuer without local OAuth routes", async () => {
    const { request } = setup();
    const metadata = await request("/.well-known/oauth-protected-resource/mcp");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: `${publicOrigin}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: ["financial:read", "financial:write"],
    });
    for (const path of ["/health", "/v1/connections", "/mcp", "/oauth/token"]) {
      const response = await request(path, undefined, {
        headers: {
          "oai-authenticated-user-id": "owner-1",
          "x-forwarded-user": "owner-1",
        },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="financial:read financial:write"`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      (await request("/.well-known/oauth-authorization-server", "both")).status,
    ).toBe(404);
    expect((await request("/health", token)).status).toBe(401);
  });

  it("pins owner and resource and hides provider failures", async () => {
    for (const result of [
      identity(["financial:read"], { ownerId: "someone-else" }),
      identity(["financial:read"], { resource: publicOrigin }),
      identity(["financial:read"], { source: "" }),
      identity(["financial:read"], { subject: "" }),
      identity(["financial:read"], { clientId: "" }),
      null,
    ]) {
      const { request } = setup({
        issuer,
        endpoints,
        authenticate: async () => result,
      });
      expect((await request("/health", "read")).status).toBe(401);
    }
    const { request } = setup({
      issuer,
      endpoints,
      authenticate: async () => {
        throw new Error("synthetic-private-provider-response");
      },
    });
    const response = await request("/health", "read");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required." },
    });
  });

  it("rejects untrusted Host and Origin before consulting the provider", async () => {
    const authenticate = vi.fn(async () => identity(["financial:read"]));
    const { request, service } = setup({ issuer, endpoints, authenticate });
    for (const headers of [
      { Host: "attacker.invalid" },
      { Origin: "https://attacker.invalid" },
      { Origin: "null" },
    ]) {
      expect((await request("/health", "read", { headers })).status).toBe(403);
    }
    expect((await service.app.request("http://127.0.0.1/health")).status).toBe(
      403,
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(
      (
        await request("/health", "read", {
          headers: { Origin: publicOrigin, Host: new URL(publicOrigin).host },
        })
      ).status,
    ).toBe(200);
  });

  it("requires the operation's explicit scope on every REST route and health", async () => {
    const { application, request } = setup();
    for (const [name, method, path] of routes) {
      const operation = application.operations.find(
        (entry) => entry.name === name,
      )!;
      vi.mocked(operation.execute).mockClear();
      const readOnly = expectedScopes[name] === "financial:read";
      const init = { method, ...(method !== "GET" && { body: "{}" }) };
      const denied = await request(path, readOnly ? "write" : "read", init);
      expect(denied.status).toBe(403);
      expect(denied.headers.get("www-authenticate")).toContain(
        'error="insufficient_scope"',
      );
      expect(operation.execute).not.toHaveBeenCalled();
      expect(
        (await request(path, readOnly ? "read" : "write", init)).status,
      ).toBe(200);
      expect(operation.execute).toHaveBeenCalledOnce();
    }
    expect((await request("/health", "write")).status).toBe(403);
    expect((await request("/health", "neither")).status).toBe(403);
    expect((await request("/health", "read")).status).toBe(200);
  });

  it.each(["modern", "legacy"] as const)(
    "checks every %s MCP tool and isolates concurrent request grants",
    async (mode) => {
      const { application, service } = setup();

      async function connect(bearer: string) {
        const client = new Client(
          { name: "synthetic-auth-test", version: "1" },
          {
            versionNegotiation: {
              mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy",
            },
          },
        );
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`), {
            fetch: async (input, init) => {
              const request = new Request(input, init);
              request.headers.set("authorization", `Bearer ${bearer}`);
              return service.app.fetch(request);
            },
          }),
        );
        return client;
      }

      const [reader, writer] = await Promise.all([
        connect("read"),
        connect("write"),
      ]);
      for (const [name, scope] of Object.entries(expectedScopes)) {
        const operation = application.operations.find(
          (entry) => entry.name === name,
        )!;
        const [readResult, writeResult] = await Promise.all([
          reader.callTool({ name, arguments: {} }),
          writer.callTool({ name, arguments: {} }),
        ]);
        const denied = scope === "financial:read" ? writeResult : readResult;
        const allowed = scope === "financial:read" ? readResult : writeResult;
        expect(denied).toMatchObject({
          isError: true,
          structuredContent: {
            error: { code: "forbidden", message: "Permission denied." },
          },
        });
        expect(allowed.isError).not.toBe(true);
        expect(allowed.structuredContent).toEqual({ name });
        expect(operation.execute).toHaveBeenCalledOnce();
      }
    },
  );

  it("rejects request syntax before scope, and scope before operation validation", async () => {
    const db = await openDatabase(":memory:");
    try {
      const { request } = setup(undefined, createApplication(db));
      const path = "/v1/transactions/synthetic/annotation";
      const patch = (bearer: string, body: string) =>
        request(path, bearer, { method: "PATCH", body });
      // Malformed JSON fails before the grant is checked.
      const syntax = await patch("read", "{");
      expect(syntax.status).toBe(400);
      expect(await syntax.json()).toEqual({
        error: { code: "invalid_input", message: "Invalid request input." },
      });
      // Well-formed input missing expectedVersion: a read grant is refused
      // before the operation validates it; a write grant reaches validation.
      expect((await patch("read", "{}")).status).toBe(403);
      const invalid = await patch("write", "{}");
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: { code: "invalid_input", message: "Invalid operation input." },
      });
    } finally {
      await db.close();
    }
  });

  it("rejects mixed hosted/local configuration at runtime and malformed public origins", () => {
    const { application } = setup();
    const authProvider: HostedAuthProvider = {
      issuer,
      endpoints,
      authenticate: async () => null,
    };
    expect(() =>
      createHttpService(application, {
        token,
        publicOrigin,
        ownerId: "owner-1",
      } as unknown as HttpServiceOptions),
    ).toThrow("Invalid API token configuration");
    for (const invalid of [
      "http://financial.synthetic.invalid",
      `${publicOrigin}/`,
      `${publicOrigin}/mcp`,
      `${publicOrigin}?x=y`,
    ]) {
      expect(() =>
        createHttpService(application, {
          authProvider,
          publicOrigin: invalid,
          ownerId: "owner-1",
        }),
      ).toThrow();
    }
    const local = createHttpService(application, { token });
    services.push(local);
    return expect(
      local.app.request("http://127.0.0.1/health", {
        headers: { authorization: `Bearer ${token}` },
      }),
    ).resolves.toHaveProperty("status", 200);
  });
});

describe("operation scopes", () => {
  it("pins the scope every operation requires, apart from its MCP hints", async () => {
    const db = await openDatabase(":memory:");
    try {
      const application = createApplication(db, {
        refreshes: {
          start: vi.fn(),
          startAll: vi.fn(),
        },
      });
      expect(
        Object.fromEntries(
          application.operations.map((operation) => [
            operation.name,
            operationScope(operation),
          ]),
        ),
      ).toEqual(expectedScopes);
    } finally {
      await db.close();
    }
  });
});
