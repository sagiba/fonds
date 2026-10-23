import { Validator } from "@seriousme/openapi-schema-validator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Application,
  createApplication,
  operationDefinitions,
} from "../../src/application/operations.js";
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
/** The operation a route reaches when its operationId differs from the name. */
const REACHED: Readonly<Record<string, string>> = {
  refresh_all_connections: "refresh_connection",
};

type Schema = Record<string, unknown>;

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
  responses: Record<
    string,
    { content: { "application/json": { schema: Schema } } }
  >;
  security: Record<string, string[]>[];
}

interface Document {
  [key: string]: unknown;
  servers?: { url: string }[];
  paths: Record<string, Record<string, DocumentedOperation>>;
  components: {
    schemas: Record<string, Schema>;
    securitySchemes: Record<string, unknown>;
  };
}

/** Each operation echoes its name and input, showing what a route delivered. */
const echoApplication: Application = {
  backend: "postgres",
  operations: operationDefinitions.map((definition) => ({
    ...definition,
    execute: async (input) => ({ name: definition.name, input }),
  })),
};

let db: Database;
const services: ReturnType<typeof createHttpService>[] = [];

beforeEach(async () => {
  db = await openDatabase(":memory:");
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await db.close();
});

function hostedService(
  application = echoApplication,
  publicApiDescription = true,
) {
  const service = createHttpService(application, {
    publicOrigin,
    ownerId: "owner",
    publicApiDescription,
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
  });
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

/** The first schema found under a property of this name, at any depth. */
function propertySchema(schema: unknown, name: string): Schema | undefined {
  if (schema === null || typeof schema !== "object") {
    return undefined;
  }
  const properties = (schema as { properties?: Record<string, Schema> })
    .properties;
  if (properties?.[name]) {
    return properties[name];
  }
  for (const entry of Object.values(schema)) {
    const found = propertySchema(entry, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function hostedRequest(
  service: ReturnType<typeof createHttpService>,
  method: string,
  path: string,
  input?: object,
) {
  return service.app.request(`${publicOrigin}${path}`, {
    method: method.toUpperCase(),
    headers: {
      Authorization: "Bearer synthetic",
      "Content-Type": "application/json",
    },
    ...(input && { body: JSON.stringify(input) }),
  });
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

  it("documents each route as delivering its inputs to its own operation", async () => {
    const service = hostedService();
    for (const [method, path, operationId] of ROUTES) {
      const pathInputs: Record<string, string> = {};
      const url = path.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
        pathInputs[name] = `synthetic-${name}`;
        return pathInputs[name];
      });
      const response =
        method === "get"
          ? await hostedRequest(service, method, `${url}?limit=5`)
          : await hostedRequest(service, method, url, { reason: "probe" });
      expect(await response.json(), `${method} ${path}`).toEqual({
        name: REACHED[operationId] ?? operationId,
        input: {
          ...pathInputs,
          ...(method === "get" ? { limit: 5 } : { reason: "probe" }),
        },
      });
    }
  });

  it("answers 202 while any refresh it started still runs", async () => {
    const summary = (status: string) => ({
      connectionId: "synthetic",
      reason: null,
      refresh: { status },
    });
    for (const [path, output, status] of [
      [
        "/v1/connections/synthetic/refreshes",
        { refresh: { status: "running" } },
        202,
      ],
      [
        "/v1/connections/synthetic/refreshes",
        { refresh: { status: "completed" } },
        200,
      ],
      [
        "/v1/refreshes",
        { refreshes: [summary("completed"), summary("pending")] },
        202,
      ],
      [
        "/v1/refreshes",
        { refreshes: [summary("completed"), summary("failed")] },
        200,
      ],
    ] as const) {
      const service = hostedService({
        backend: "postgres",
        operations: operationDefinitions.map((definition) => ({
          ...definition,
          execute: async () => output,
        })),
      });
      const response = await hostedRequest(service, "post", path, {});
      expect(response.status, JSON.stringify(output)).toBe(status);
    }
  });

  it("refuses an input its route carries elsewhere or excludes", async () => {
    const service = hostedService();
    for (const [method, path, input] of [
      ["get", "/v1/cards/synthetic?cardId=other"],
      ["get", "/v1/transactions?limit=5&limit=6"],
      [
        "patch",
        "/v1/transactions/synthetic/annotation",
        { transactionId: "other", expectedVersion: 0 },
      ],
      ["post", "/v1/connections/synthetic/refreshes", { connectionId: "x" }],
      ["post", "/v1/refreshes", { connectionId: "synthetic" }],
    ] as const) {
      const response = await hostedRequest(service, method, path, input);
      expect(response.status, `${method} ${path}`).toBe(400);
    }
  });

  it("carries the operations' own schemas and descriptions", async () => {
    const document = await hostedDocument();
    const transaction = operation(
      document,
      "get",
      "/v1/transactions/{transactionId}",
    ).responses["200"]!.content["application/json"].schema;
    const money = propertySchema(transaction, "amount");
    const decimal = propertySchema(money, "amount");
    expect(decimal?.type).toBe("string");
    const pattern = new RegExp(decimal?.pattern as string);
    expect(pattern.test("-12.30")).toBe(true);
    expect(pattern.test("1e3")).toBe(false);
    expect(propertySchema(transaction, "presence")?.enum).toEqual([
      "seen",
      "not_returned",
      "removed",
    ]);
    expect(propertySchema(transaction, "status")?.description).toEqual(
      expect.stringContaining("Source report status"),
    );
    for (const path of ["/v1/transactions", "/v1/transactions/totals"]) {
      const presence = operation(document, "get", path).parameters?.find(
        (parameter) => parameter.name === "presence",
      );
      expect(presence?.schema).toMatchObject({
        enum: ["seen", "not_returned", "removed", "current", "all"],
        default: "current",
      });
    }
    const metadata = operation(
      document,
      "patch",
      "/v1/transactions/{transactionId}/annotation",
    ).requestBody!.content["application/json"].schema.properties;
    expect(JSON.stringify(metadata)).toContain(
      '"$ref":"#/components/schemas/JsonValue"',
    );
    expect(document.components.schemas.JsonValue).toEqual(
      expect.objectContaining({ anyOf: expect.any(Array) }),
    );
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
      "400",
      "401",
      "403",
      "404",
      "409",
      "413",
      "500",
    ]);
    // Reads check no versions or lifecycle state, so they never conflict.
    expect(Object.keys(getTransaction.responses)).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "413",
      "500",
    ]);
    expect(
      operation(document, "get", "/v1/transactions/totals").parameters?.find(
        ({ name }) => name === "perspective",
      )?.schema.enum,
    ).toEqual(["spending", "billing"]);
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

  it("is not served by a hosted deployment that has not opted in", async () => {
    const service = hostedService(echoApplication, false);
    const anonymous = await service.app.request(
      `${publicOrigin}/v1/openapi.json`,
    );
    expect(anonymous.status).toBe(401);
    expect(
      (await hostedRequest(service, "get", "/v1/openapi.json")).status,
    ).toBe(404);
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
    for (const path of [
      "/v1/refreshes",
      "/v1/connections/synthetic/refreshes",
    ]) {
      const refresh = await service.app.request(
        `http://127.0.0.1:8787${path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      expect(refresh.status, path).toBe(404);
    }
    // The documented totals perspectives are the ones the service accepts.
    for (const [perspective, status] of [
      ["billing", 200],
      ["all", 400],
    ] as const) {
      const totals = await service.app.request(
        `http://127.0.0.1:8787/v1/transactions/totals?perspective=${perspective}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(totals.status, perspective).toBe(status);
    }
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
