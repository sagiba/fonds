import { type core, z } from "zod";

import type { OperationDefinition } from "../application/operations.js";
import { FONDS_VERSION } from "../application/version.js";
import { jsonValueSchema } from "../domain/model.js";
import { operationScope } from "./auth.js";
import {
  REFRESH_ALL_ROUTE,
  type RestRoute,
  restRoutes,
} from "./rest-routes.js";

type JsonSchema = core.JSONSchema.JSONSchema;

type Convert = (schema: z.ZodType, io: "input" | "output") => JsonSchema;

/** How a client authenticates to the deployment the document describes. */
export type ApiSecurity =
  | { kind: "bearer" }
  | {
      kind: "oauth2";
      authorizationUrl: string;
      tokenUrl: string;
      scopes: readonly string[];
      /** The access-token audience REST shares with MCP. */
      resource: string;
    };

const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  openid: "Sign in as the owner.",
  profile: "Read the owner's profile.",
  offline_access: "Receive a refresh token.",
  "financial:read": "Read financial records.",
  "financial:write":
    "Annotate, match and remove transactions, and start refreshes.",
};

const QUERY_TYPES = new Set(["string", "integer", "number", "boolean"]);

/** Recursive schemas need a name: Zod emits them as definitions to reference. */
const namedSchemas = z.registry<{ id: string }>();
namedSchemas.add(jsonValueSchema, { id: "JsonValue" });

const DEFINITION_REF = "#/$defs/";

const errorSchema: JsonSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};

/** Points schema-local definition refs at the document's shared components. */
function relocateRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(relocateRefs);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "$ref" &&
      typeof entry === "string" &&
      entry.startsWith(DEFINITION_REF)
        ? `#/components/schemas/${entry.slice(DEFINITION_REF.length)}`
        : relocateRefs(entry),
    ]),
  );
}

/** Converts Zod schemas, hoisting their definitions into one shared map. */
function schemaConverter() {
  const components: Record<string, JsonSchema> = {};
  const convert: Convert = (schema, io) => {
    const converted = z.toJSONSchema(schema, { io, metadata: namedSchemas });
    const definitions = converted.$defs ?? {};
    // The document's dialect applies; definitions move to components.
    delete converted.$schema;
    delete converted.$defs;
    for (const [name, definition] of Object.entries(definitions)) {
      const relocated = relocateRefs(definition) as JsonSchema;
      const existing = components[name];
      if (existing && JSON.stringify(existing) !== JSON.stringify(relocated)) {
        throw new Error("Conflicting schema definitions share a name");
      }
      components[name] = relocated;
    }
    return relocateRefs(converted) as JsonSchema;
  };
  return { components, convert };
}

function describeOperation(
  definition: OperationDefinition,
  route: RestRoute,
  operationId: string,
  context: { convert: Convert; security: ApiSecurity },
  /** Input fields this route never accepts. */
  excluded: readonly string[] = [],
) {
  const input = context.convert(definition.inputSchema, "input");
  const properties = { ...input.properties } as Record<string, JsonSchema>;
  const required = new Set(input.required);
  const pathNames = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(
    ([, name]) => name!,
  );
  const parameters: object[] = pathNames.map((name) => {
    const schema = properties[name];
    if (!schema) {
      throw new Error("Route parameter missing from operation input");
    }
    return { name, in: "path", required: true, schema };
  });
  for (const name of [...pathNames, ...excluded]) {
    delete properties[name];
    required.delete(name);
  }
  let requestBody: object | undefined;
  if (route.method === "GET") {
    for (const [name, schema] of Object.entries(properties)) {
      // The HTTP route parses only scalar query values.
      if (typeof schema.type !== "string" || !QUERY_TYPES.has(schema.type)) {
        throw new Error("Operation input cannot travel as a query parameter");
      }
      parameters.push({
        name,
        in: "query",
        required: required.has(name),
        schema,
      });
    }
  } else {
    const body: JsonSchema = { ...input, properties, required: [...required] };
    if (required.size === 0) {
      delete body.required;
    }
    requestBody = {
      required: true,
      content: { "application/json": { schema: body } },
    };
  }
  const output = {
    content: {
      "application/json": {
        schema: context.convert(definition.outputSchema, "output"),
      },
    },
  };
  return {
    operationId,
    description: definition.description,
    ...(parameters.length > 0 && { parameters }),
    ...(requestBody && { requestBody }),
    responses: {
      200: { description: "The operation's output.", ...output },
      ...(route.accepted && {
        202: { description: "Started and still running.", ...output },
      }),
      default: { $ref: "#/components/responses/Error" },
    },
    security: [
      context.security.kind === "oauth2"
        ? { oauth2: [operationScope(definition)] }
        : { bearer: [] },
    ],
  };
}

function securitySchemes(security: ApiSecurity) {
  if (security.kind === "bearer") {
    return {
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "The local service's private API token.",
      },
    };
  }
  return {
    oauth2: {
      type: "oauth2",
      description: `Authorization code with PKCE (S256), for the deployment's admitted clients only. Access tokens are issued for the resource ${security.resource}, which REST and MCP share.`,
      flows: {
        authorizationCode: {
          authorizationUrl: security.authorizationUrl,
          tokenUrl: security.tokenUrl,
          refreshUrl: security.tokenUrl,
          scopes: Object.fromEntries(
            security.scopes.map((scope) => [
              scope,
              SCOPE_DESCRIPTIONS[scope] ?? "",
            ]),
          ),
        },
      },
    },
  };
}

/**
 * An OpenAPI 3.1 description of the `/v1` routes these operations serve. Schemas
 * come from the operations' own Zod schemas, so the document cannot drift from
 * what the service validates. Without `origin`, servers resolve relative to
 * the document's own URL.
 */
export function openApiDocument(
  operations: readonly OperationDefinition[],
  options: { origin?: string; security: ApiSecurity },
) {
  const { components, convert } = schemaConverter();
  const context = { convert, security: options.security };
  const paths: Record<string, Record<string, unknown>> = {};

  function add(route: RestRoute, operation: object) {
    const path = route.path.replace(/:([A-Za-z]+)/g, "{$1}");
    (paths[path] ??= {})[route.method.toLowerCase()] = operation;
  }

  for (const definition of operations) {
    const route = restRoutes[definition.name];
    if (!route) {
      throw new Error("Operation has no REST route");
    }
    add(route, describeOperation(definition, route, definition.name, context));
    if (definition.name === "refresh_connection") {
      add(
        REFRESH_ALL_ROUTE,
        describeOperation(
          definition,
          REFRESH_ALL_ROUTE,
          "refresh_all_connections",
          context,
          ["connectionId"],
        ),
      );
    }
  }
  return {
    openapi: "3.1.1",
    info: {
      title: "Fonds",
      version: FONDS_VERSION,
      description:
        "A single-owner financial evidence ledger. Money is an exact decimal string; keep each amount with its currency and amount basis.",
    },
    externalDocs: {
      url: "https://github.com/sagiba/fonds/blob/main/docs/api.md",
    },
    ...(options.origin !== undefined && {
      servers: [{ url: options.origin }],
    }),
    paths,
    components: {
      schemas: components,
      securitySchemes: securitySchemes(options.security),
      responses: {
        Error: {
          description: "A public error code and fixed message.",
          content: { "application/json": { schema: errorSchema } },
        },
      },
    },
  };
}
