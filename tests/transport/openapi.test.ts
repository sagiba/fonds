import { Validator } from "@seriousme/openapi-schema-validator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplication } from "../../src/application/operations.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { createHttpService } from "../../src/transport/http.js";

const token = "synthetic-test-only-000000000000000000000000";
const publicOrigin = "https://financial.synthetic.invalid";
const issuer = `${publicOrigin}/api/auth`;

/** Every documented route, written independently of the shared route table. */
const ROUTES = [
  ["get", "/v1/connections", "list_connections"],
  ["get", "/v1/connections/{connectionId}", "get_connection"],
  ["get", "/v1/cards", "list_cards"],
  ["get", "/v1/cards/{cardId}", "get_card"],
  ["get", "/v1/accounts", "list_accounts"],
  ["get", "/v1/accounts/{accountId}", "get_account"],
  ["get", "/v1/transactions", "list_transactions"],
  ["get", "/v1/transactions/{transactionId}", "get_transaction"],
  ["get", "/v1/transactions/totals", "get_transaction_totals"],
  ["get", "/v1/events", "list_events"],
  ["get", "/v1/connections/{connectionId}/sync-runs", "list_sync_runs"],
  ["patch", "/v1/transactions/{transactionId}/annotation", "update_annotation"],
  ["post", "/v1/connections/{connectionId}/refreshes", "refresh_connection"],
  ["post", "/v1/refreshes", "refresh_all_connections"],
  ["get", "/v1/refreshes/{refreshId}", "get_refresh"],
  ["get", "/v1/connections/{connectionId}/refreshes", "list_refreshes"],
  ["post", "/v1/annotations/undo", "undo_annotation"],
  [
    "post",
    "/v1/transactions/{transactionId}/link-pending",
    "link_pending_transaction",
  ],
  [
    "post",
    "/v1/transactions/{transactionId}/unlink-pending",
    "unlink_pending_transaction",
  ],
  ["post", "/v1/transactions/{transactionId}/removal", "confirm_removal"],
] as const;

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  schema: Record<string, unknown>;
}

interface DocumentedOperation {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: {
    content: {
      "application/json": {
        schema: { properties: object; required?: string[] };
      };
    };
  };
  responses: Record<string, unknown>;
  security: Record<string, string[]>[];
}

interface Document {
  [key: string]: unknown;
  servers?: { url: string }[];
  paths: Record<string, Record<string, DocumentedOperation>>;
  components: { securitySchemes: Record<string, unknown> };
}

let db: Database;
const services: ReturnType<typeof createHttpService>[] = [];

beforeEach(async () => {
  db = await openDatabase(":memory:");
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await db.close();
});

function hostedService() {
  const service = createHttpService(
    createApplication(db, {
      refreshes: {
        start: async () => {
          throw new Error("synthetic refresh unavailable");
        },
        startAll: async () => [],
      },
    }),
    {
      publicOrigin,
      ownerId: "owner",
      authProvider: {
        issuer,
        authorizationScopes: ["offline_access", "financial:read"],
        endpoints: {
          authorization: `${issuer}/oauth2/authorize`,
          token: `${issuer}/oauth2/token`,
        },
        authenticate: async (request) =>
          request.headers.get("authorization") === "Bearer synthetic"
            ? {
                source: "synthetic",
                subject: "owner",
                ownerId: "owner",
                resource: `${publicOrigin}/mcp`,
                clientId: "synthetic-client",
                scopes: ["financial:read", "financial:write"],
              }
            : null,
      },
    },
  );
  services.push(service);
  return service;
}

async function hostedDocument() {
  const response = await hostedService().app.request(
    `${publicOrigin}/v1/openapi.json`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Document;
}

function operation(document: Document, method: string, path: string) {
  const entry = document.paths[path]?.[method];
  if (!entry) {
    throw new Error(`Undocumented ${method} ${path}`);
  }
  return entry;
}

describe("OpenAPI document", () => {
  it("is a valid OpenAPI 3.1 document listing exactly the served routes", async () => {
    const document = await hostedDocument();
    const result = await new Validator().validate(document);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    const documented = Object.entries(document.paths).flatMap(
      ([path, methods]) =>
        Object.entries(methods).map(([method, entry]) => [
          method,
          path,
          entry.operationId,
        ]),
    );
    expect(documented).toHaveLength(ROUTES.length);
    expect(documented).toEqual(expect.arrayContaining([...ROUTES]));
    // Pins each route's HTTP contract; the schemas themselves belong to Zod.
    const contract = Object.fromEntries(
      Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, entry]) => {
          const body = entry.requestBody?.content["application/json"].schema;
          const required = new Set(body?.required);
          return [
            `${method.toUpperCase()} ${path}`,
            {
              operationId: entry.operationId,
              scopes: entry.security.flatMap((scheme) =>
                Object.values(scheme).flat(),
              ),
              parameters: entry.parameters?.map(
                ({ name, in: where, required }) =>
                  `${where} ${name}${required ? " (required)" : ""}`,
              ),
              body:
                body &&
                Object.keys(body.properties).map(
                  (name) => `${name}${required.has(name) ? " (required)" : ""}`,
                ),
              responses: Object.keys(entry.responses),
            },
          ];
        }),
      ),
    );
    await expect(JSON.stringify(contract, null, 2) + "\n").toMatchFileSnapshot(
      "__snapshots__/openapi-routes.json",
    );
  });

  it("documents only routes the service serves", async () => {
    const service = hostedService();
    for (const [method, path] of ROUTES) {
      const response = await service.app.request(
        `${publicOrigin}${path.replace(/\{[A-Za-z]+\}/g, "synthetic")}`,
        {
          method: method.toUpperCase(),
          headers: {
            Authorization: "Bearer synthetic",
            "Content-Type": "application/json",
          },
          ...(method !== "get" && { body: "{}" }),
        },
      );
      const body = (await response.json()) as { error?: { message: string } };
      expect(body.error?.message, `${method} ${path}`).not.toBe(
        "Route not found.",
      );
    }
  });

  it("places path, query and body inputs as the routes read them", async () => {
    const document = await hostedDocument();
    const getTransaction = operation(
      document,
      "get",
      "/v1/transactions/{transactionId}",
    );
    expect(
      getTransaction.parameters?.map(({ name, in: where, required }) => [
        name,
        where,
        required,
      ]),
    ).toEqual([
      ["transactionId", "path", true],
      ["detail", "query", false],
      ["includeEvidence", "query", false],
    ]);
    expect(getTransaction.parameters?.[1]?.schema).toMatchObject({
      type: "boolean",
      default: true,
    });
    const perspective = operation(
      document,
      "get",
      "/v1/transactions",
    ).parameters?.find(({ name }) => name === "perspective");
    expect(perspective).toMatchObject({
      in: "query",
      required: false,
      schema: { enum: ["spending", "billing", "all"], default: "spending" },
    });

    const annotation = operation(
      document,
      "patch",
      "/v1/transactions/{transactionId}/annotation",
    );
    const annotationBody =
      annotation.requestBody!.content["application/json"].schema;
    expect(annotationBody.properties).not.toHaveProperty("transactionId");
    expect(annotationBody.required).toEqual(["expectedVersion"]);

    const refreshAll = operation(document, "post", "/v1/refreshes");
    expect(refreshAll.parameters).toBeUndefined();
    const refreshBody =
      refreshAll.requestBody!.content["application/json"].schema;
    expect(Object.keys(refreshBody.properties)).toEqual(["from", "to"]);
    expect(refreshBody.required).toBeUndefined();
    expect(Object.keys(refreshAll.responses)).toEqual([
      "200",
      "202",
      "default",
    ]);
  });

  it("declares the issuer's OAuth flow and each operation's scope", async () => {
    const document = await hostedDocument();
    expect(document.servers).toEqual([{ url: publicOrigin }]);
    expect(document.components.securitySchemes).toEqual({
      oauth2: {
        type: "oauth2",
        description: expect.stringContaining(`${publicOrigin}/mcp`),
        flows: {
          authorizationCode: {
            authorizationUrl: `${issuer}/oauth2/authorize`,
            tokenUrl: `${issuer}/oauth2/token`,
            refreshUrl: `${issuer}/oauth2/token`,
            scopes: {
              offline_access: expect.any(String),
              "financial:read": expect.any(String),
            },
          },
        },
      },
    });
    expect(operation(document, "get", "/v1/transactions").security).toEqual([
      { oauth2: ["financial:read"] },
    ]);
    // Reading an abandoned refresh continues it, but it is still a read grant.
    expect(
      operation(document, "get", "/v1/refreshes/{refreshId}").security,
    ).toEqual([{ oauth2: ["financial:read"] }]);
    expect(
      operation(document, "post", "/v1/transactions/{transactionId}/removal")
        .security,
    ).toEqual([{ oauth2: ["financial:write"] }]);
    expect(operation(document, "post", "/v1/refreshes").security).toEqual([
      { oauth2: ["financial:write"] },
    ]);
  });

  it("is served locally without the bearer and omits unavailable refreshes", async () => {
    const service = createHttpService(createApplication(db), { token });
    services.push(service);
    const response = await service.app.request(
      "http://127.0.0.1:8787/v1/openapi.json",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const document = (await response.json()) as Document;
    expect(document.servers).toBeUndefined();
    expect(document.components.securitySchemes).toEqual({
      bearer: {
        type: "http",
        scheme: "bearer",
        description: expect.any(String),
      },
    });
    expect(operation(document, "get", "/v1/events").security).toEqual([
      { bearer: [] },
    ]);
    expect(document.paths).not.toHaveProperty("/v1/refreshes");
    expect(
      document.paths["/v1/connections/{connectionId}/refreshes"],
    ).not.toHaveProperty("post");
    expect(
      (
        await service.app.request("http://127.0.0.1:8787/v1/openapi.json", {
          headers: { Host: "attacker.invalid" },
        })
      ).status,
    ).toBe(403);
  });
});
