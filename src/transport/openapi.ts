import { type core, z } from "zod";

import type { OperationDefinition } from "../application/operations.js";
import { FONDS_VERSION } from "../application/version.js";
import { jsonValueSchema } from "../domain/model.js";
import { operationScope } from "./auth.js";
import { pathInputs, REST_ROUTES, type RestRoute } from "./rest-routes.js";

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

/**
 * Recursive schemas need a name: Zod emits them as definitions to reference.
 * Replacing the global registry here hides its metadata, which `convert` restores.
 */
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

const challengeHeader = {
  "WWW-Authenticate": {
    description: "The Bearer challenge, naming the scopes to request.",
    schema: { type: "string" },
  },
};

/** The error statuses an operation route can answer; the API reference lists their codes. */
const ERROR_RESPONSES = {
  400: { name: "InvalidInput", description: "The input is invalid." },
  401: {
    name: "Unauthorized",
    description: "Authentication is missing or invalid.",
    headers: challengeHeader,
  },
  403: {
    name: "Forbidden",
    description:
      "The Host or Origin is untrusted, or the grant lacks the operation's scope.",
    headers: challengeHeader,
  },
  404: { name: "NotFound", description: "The record does not exist." },
  409: {
    name: "Conflict",
    description:
      "The request conflicts with current state. Read it again before retrying.",
  },
  413: {
    name: "TooLarge",
    description: "The request body or the output is too large.",
  },
  500: { name: "InternalError", description: "The operation failed." },
} as const;

/** Only writes check versions or lifecycle state, and so conflict. */
function errorStatuses(definition: OperationDefinition) {
  return ([400, 401, 403, 404, 409, 413, 500] as const).filter(
    (status) => status !== 409 || definition.access === "write",
  );
}

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
    const converted = z.toJSONSchema(schema, {
      io,
      metadata: namedSchemas,
      override: ({ zodSchema, jsonSchema }) => {
        const metadata = { ...z.globalRegistry.get(zodSchema) };
        delete metadata.id;
        Object.assign(jsonSchema, metadata);
      },
    });
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
  context: { convert: Convert; security: ApiSecurity },
) {
  const input = context.convert(definition.inputSchema, "input");
  const properties = { ...input.properties } as Record<string, JsonSchema>;
  const required = new Set(input.required);
  const path = pathInputs(route);
  const parameters: object[] = path.map((name) => {
    const schema = properties[name];
    if (!schema) {
      throw new Error("Route parameter missing from operation input");
    }
    return { name, in: "path", required: true, schema };
  });
  for (const name of [...path, ...(route.excluded ?? [])]) {
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
    operationId: route.operationId ?? route.operation,
    description: definition.description,
    ...(parameters.length > 0 && { parameters }),
    ...(requestBody && { requestBody }),
    responses: {
      200: { description: "The operation's output.", ...output },
      ...(route.accepted && {
        202: { description: "Started and still running.", ...output },
      }),
      ...Object.fromEntries(
        errorStatuses(definition).map((status) => [
          status,
          {
            $ref: `#/components/responses/${ERROR_RESPONSES[status].name}`,
          },
        ]),
      ),
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
 * An OpenAPI 3.1 description of the `/v1` routes these operations serve, from
 * the route table the HTTP service registers and the operations' Zod schemas.
 * Without `origin`, servers resolve relative to the document's own URL.
 */
export function openApiDocument(
  operations: readonly OperationDefinition[],
  options: { origin?: string; security: ApiSecurity },
) {
  const { components, convert } = schemaConverter();
  const context = { convert, security: options.security };
  const definitions = new Map(
    operations.map((definition) => [definition.name, definition]),
  );
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of REST_ROUTES) {
    const definition = definitions.get(route.operation);
    if (definition) {
      const path = route.path.replace(/:([A-Za-z]+)/g, "{$1}");
      (paths[path] ??= {})[route.method.toLowerCase()] = describeOperation(
        definition,
        route,
        context,
      );
    }
  }
  return {
    openapi: "3.1.1",
    info: {
      title: "Fonds",
      version: FONDS_VERSION,
      description:
        "A single-owner financial evidence ledger. Money is an exact decimal string; keep each amount with its currency and amount basis. Schemas give each input's shape; rules across inputs are stated in each operation's description, and the service answers 400 when one is broken.",
    },
    externalDocs: {
      url: "https://github.com/sagiba/fonds/blob/main/docs/api.md",
    },
    ...(options.origin !== undefined && {
      servers: [{ url: options.origin }],
    }),
    paths,
    components: {
      schemas: { ...components, Error: errorSchema },
      securitySchemes: securitySchemes(options.security),
      responses: Object.fromEntries(
        Object.values(ERROR_RESPONSES).map(({ name, ...response }) => [
          name,
          {
            ...response,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        ]),
      ),
    },
  };
}
