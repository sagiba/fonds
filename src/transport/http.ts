import { timingSafeEqual } from "node:crypto";

import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { routePath } from "hono/route";

import type { EventService } from "../application/events.js";
import {
  type Application,
  type Operation,
  publicError,
} from "../application/operations.js";
import {
  acceptedIdentity,
  FINANCIAL_SCOPES,
  type FinancialScope,
  type HostedAuthProvider,
  hostedOrigin,
  LOOPBACK_HOSTS,
  operationScope,
  permits,
  type TrustedIdentity,
} from "./auth.js";
import { createMcpHttpHandler, opensSubscriptionStream } from "./mcp.js";
import { openApiDocument } from "./openapi.js";
import { pathInputs, REST_ROUTES, type RestRoute } from "./rest-routes.js";

const MAX_BODY_BYTES = 64 * 1024;
const LOG_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;
const LOG_MCP_METHODS = [
  "server/discover",
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
  "tools/list",
  "tools/call",
  "initialize",
  "ping",
] as const;

/** Query parameters that carry booleans as the literal text true or false. */
const BOOLEAN_QUERY_KEYS = new Set([
  "includeSuperseded",
  "detail",
  "includeEvidence",
  "cardPresent",
  "threeDSecureUsed",
  "recurring",
]);

class InputError extends Error {}

const failure = (code: string, message: string) => ({
  error: { code, message },
});

/**
 * One request's diagnostics. A body without a declared length is counted as it
 * is sent, and its entry is emitted when the body ends or its reader cancels
 * it: a long-lived MCP stream logs when it closes.
 */
export interface HttpRequestLog {
  method: (typeof LOG_HTTP_METHODS)[number] | "OTHER";
  route: string;
  status: number;
  /** Time until the response headers were ready; a streamed body may end later. */
  durationMs: number;
  /** The request's declared Content-Length, when it declared a valid one. */
  requestBytes?: number;
  /** Response body bytes sent; absent when no response was produced. */
  responseBytes?: number;
  /** Untrusted request-header classifications, never parsed request-body values. */
  mcpMethod?: (typeof LOG_MCP_METHODS)[number] | "other" | "unspecified";
  /** A date-shaped protocol version, or a fixed class for anything else. */
  mcpProtocol?: string;
}

type RouteHandler = (request: Request) => Promise<Response | null | undefined>;

/** Who a static bearer token authenticates: the owner, as one local client. */
export const LOCAL_IDENTITY = { ownerId: "owner", clientId: "local" } as const;

export type HttpServiceOptions = {
  onRequest?: (entry: HttpRequestLog) => void | Promise<void>;
  events?: EventService;
} & (
  | {
      token: string;
      authProvider?: never;
      publicApiDescription?: never;
      publicOrigin?: never;
      ownerId?: never;
      platformRoutes?: never;
      publicRoutes?: never;
    }
  | {
      authProvider: HostedAuthProvider;
      publicOrigin: string;
      ownerId: string;
      token?: never;
      /**
       * Requests authenticated by the hosting platform, such as native triggers
       * at an internal Host. They run before the public Host guard, so each
       * handler must accept only its exact path and enforce its own caller checks.
       */
      platformRoutes?: RouteHandler;
      /** Unauthenticated login/discovery routes, after the Host and body guards. */
      publicRoutes?: RouteHandler;
      /** Serve the API description without authentication; a local service always does. */
      publicApiDescription?: boolean;
    }
);

function classifyMcpMethod(value: string | undefined) {
  if (value === undefined) {
    return "unspecified";
  }
  return LOG_MCP_METHODS.find((allowed) => allowed === value) ?? "other";
}

/** A Content-Length header value as a safe integer; undefined unless decimal digits. */
function declaredLength(value: string | null | undefined) {
  if (value === null || value === undefined || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  return Math.min(Number(value.trim()), Number.MAX_SAFE_INTEGER);
}

/** Body bytes a response sends without reading it, when they are known up front. */
function fixedBodyBytes(response: Response, method: string) {
  if (
    method === "HEAD" ||
    response.body === null ||
    [204, 205, 304].includes(response.status)
  ) {
    return 0;
  }
  return declaredLength(response.headers.get("Content-Length"));
}

/** Passes a body through unchanged, reporting its byte count once it ends. */
function countedBody(
  body: ReadableStream<Uint8Array>,
  report: (bytes: number) => void,
) {
  // Locked at the first read, so a response that is never built stays readable.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bytes = 0;
  let reported = false;
  const finish = () => {
    if (!reported) {
      reported = true;
      try {
        report(bytes);
      } catch {
        // Counting is diagnostic; the body continues unchanged.
      }
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await (reader ??= body.getReader()).read();
        } catch (error) {
          finish();
          controller.error(error);
          return;
        }
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        finish();
        await (reader ?? body).cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function setSecurityHeaders(context: Context) {
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
}

function isJsonContentType(value: string | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function classifyMcpProtocol(value: string | undefined) {
  if (value === undefined) {
    return "unspecified";
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "other";
}

/** Single-owner HTTP boundary. Hosted issuer verification belongs to its selected provider. */
export function createHttpService(
  application: Application,
  options: HttpServiceOptions,
) {
  const hosted = options.authProvider !== undefined;
  if (!hosted) {
    // A static bearer must never be combined with public hosting.
    if (
      options.publicOrigin !== undefined ||
      options.platformRoutes !== undefined ||
      options.publicRoutes !== undefined ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(options.token)
    ) {
      throw new Error("Invalid API token configuration");
    }
  }
  const operations = new Map(
    application.operations.map((operation) => [operation.name, operation]),
  );
  // The route table covers the catalog at compile time; an application
  // assembled outside it could still carry an operation HTTP would not serve.
  for (const name of operations.keys()) {
    if (!REST_ROUTES.some((route) => route.operation === name)) {
      throw new Error("Operation has no REST route");
    }
  }
  const token = Buffer.from(options.token ?? "");
  const app = new Hono<{ Variables: { identity: TrustedIdentity } }>();
  const { onRequest } = options;
  if (onRequest) {
    const report = async (entry: HttpRequestLog) => {
      try {
        await onRequest(entry);
      } catch {
        // A logger failure is not the request's failure.
      }
    };
    app.use("*", async (context, next) => {
      const startedAt = performance.now();
      const method = context.req.method;
      // Read before the body guard drops the declared length from the request.
      const requestBytes = declaredLength(context.req.header("Content-Length"));
      let response: Response | undefined;
      try {
        await next();
        response = context.res;
      } finally {
        try {
          const isMcp = new URL(context.req.url).pathname === "/mcp";
          const entry: HttpRequestLog = {
            method:
              LOG_HTTP_METHODS.find((allowed) => allowed === method) ?? "OTHER",
            route: routePath(context) || "*",
            status: response?.status ?? 500,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            ...(requestBytes !== undefined && { requestBytes }),
            ...(isMcp && {
              mcpMethod: classifyMcpMethod(context.req.header("Mcp-Method")),
              mcpProtocol: classifyMcpProtocol(
                context.req.header("MCP-Protocol-Version"),
              ),
            }),
          };
          const body = response?.body;
          const fixed = response && fixedBodyBytes(response, method);
          if (!body || fixed !== undefined) {
            await report({
              ...entry,
              ...(fixed !== undefined && { responseBytes: fixed }),
            });
          } else {
            context.res = new Response(
              countedBody(body, (responseBytes) => {
                void report({ ...entry, responseBytes });
              }),
              response,
            );
          }
        } catch {
          // Diagnostics must never alter a response or expose request details.
        }
      }
    });
  }
  if (hosted && options.platformRoutes) {
    const { platformRoutes } = options;
    app.use("*", async (context, next) => {
      const response = await platformRoutes(context.req.raw);
      if (response) {
        return response;
      }
      await next();
    });
  }
  const mcp = createMcpHttpHandler(
    application,
    options.events ? { events: options.events } : {},
  );
  // Subscription streams stay open until their client leaves. stop() ends them
  // so a listener can drain while accepted MCP calls finish; close() ends those.
  const subscriptionStreams = new AbortController();
  // A derived Request's signal follows its init signal only while the Request
  // is reachable, and the MCP handler keeps only the signal. Each stream's body
  // keeps its Request reachable while it is served, so a garbage collection
  // cannot detach the stream from stop().
  const subscriptionRequests = new WeakMap<ReadableStream, Request>();
  const publicOrigin = hosted ? hostedOrigin(options.publicOrigin) : undefined;
  const resource = publicOrigin ? `${publicOrigin}/mcp` : "local";
  const authorizationScopes = hosted
    ? (options.authProvider.authorizationScopes ?? FINANCIAL_SCOPES)
    : FINANCIAL_SCOPES;
  const challenge = hosted
    ? `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="${authorizationScopes.join(" ")}"`
    : "Bearer";
  app.use("*", async (context, next) => {
    setSecurityHeaders(context);
    const url = new URL(context.req.url);
    // Reject DNS rebinding, cross-origin browser access and forwarded identity assertions.
    const expectedHost = hosted
      ? url.origin === publicOrigin
      : LOOPBACK_HOSTS.has(url.hostname);
    const host = context.req.header("Host");
    if (!expectedHost || (host !== undefined && host !== url.host)) {
      return context.json(failure("forbidden", "Untrusted host."), 403);
    }
    const origin = context.req.header("Origin");
    if (
      origin !== undefined &&
      origin !== url.origin &&
      origin !== publicOrigin
    ) {
      return context.json(failure("forbidden", "Untrusted origin."), 403);
    }
    await next();
    // Provider handlers may return their own Response rather than a Hono response.
    setSecurityHeaders(context);
  });
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) =>
      context.json(failure("too_large", "Request body is too large."), 413),
  });
  app.use("*", async (context, next) => {
    // Measure the stream even if the caller supplies a smaller Content-Length.
    // Public login/token endpoints receive the same bound as financial operations.
    if (context.req.raw.body && context.req.raw.headers.has("content-length")) {
      const headers = new Headers(context.req.raw.headers);
      headers.delete("content-length");
      context.req.raw = new Request(context.req.raw, { headers });
    }
    return limitBody(context, next);
  });
  if (hosted && options.publicRoutes) {
    const { publicRoutes } = options;
    app.use("*", async (context, next) => {
      const response = await publicRoutes(context.req.raw);
      if (response) {
        return response;
      }
      await next();
    });
  }
  if (hosted) {
    app.get("/.well-known/oauth-protected-resource/mcp", (context) =>
      context.json({
        resource,
        authorization_servers: [options.authProvider.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: authorizationScopes,
        resource_name: "Fonds",
      }),
    );
    app.get("/setup/plugin.zip", (context) =>
      context.json(
        {
          error: {
            code: "desktop_only_package",
            message:
              "Bundled MCP archives are desktop-only in ChatGPT. Register the remote server URL with OAuth and automatic client discovery for cloud use.",
          },
        },
        410,
      ),
    );
  }
  // The description holds no owner data, and importers fetch it before they
  // hold a token; a hosted deployment advertises it only when the operator opts in.
  if (!hosted || options.publicApiDescription) {
    let apiDocument: ReturnType<typeof openApiDocument> | undefined;
    app.get("/v1/openapi.json", (context) =>
      context.json(
        (apiDocument ??= openApiDocument(
          application.operations,
          hosted
            ? {
                origin: publicOrigin!,
                security: {
                  kind: "oauth2",
                  authorizationUrl:
                    options.authProvider.endpoints.authorization,
                  tokenUrl: options.authProvider.endpoints.token,
                  scopes: authorizationScopes,
                  resource,
                },
              }
            : { security: { kind: "bearer" } },
        )),
      ),
    );
  }
  const unauthenticated = (context: Context) => {
    context.header("WWW-Authenticate", challenge);
    return context.json(
      failure("unauthorized", "Authentication required."),
      401,
    );
  };
  app.use("*", async (context, next) => {
    if (hosted) {
      let identity: TrustedIdentity | null = null;
      try {
        identity = await options.authProvider.authenticate(context.req.raw);
      } catch {
        // Verifier failures are authentication failures.
      }
      if (!acceptedIdentity(identity, options.ownerId, resource)) {
        return unauthenticated(context);
      }
      context.set("identity", { ...identity, scopes: [...identity.scopes] });
      await next();
      return;
    }
    const authorization = context.req.header("Authorization") ?? "";
    const suppliedToken = Buffer.from(
      authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
    );
    if (
      suppliedToken.length !== token.length ||
      !timingSafeEqual(suppliedToken, token)
    ) {
      return unauthenticated(context);
    }
    context.set("identity", {
      source: "local",
      subject: LOCAL_IDENTITY.ownerId,
      ownerId: LOCAL_IDENTITY.ownerId,
      resource,
      clientId: LOCAL_IDENTITY.clientId,
      scopes: [...FINANCIAL_SCOPES],
    });
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof InputError) {
      return context.json(
        failure("invalid_input", "Invalid request input."),
        400,
      );
    }
    const result = publicError(error);
    return context.json(failure(result.code, result.message), result.status);
  });
  app.notFound((context) =>
    context.json(failure("not_found", "Route not found."), 404),
  );

  async function executeOperation(
    context: Context,
    operation: Operation,
    input: unknown,
    accepted?: (output: unknown) => boolean,
  ) {
    const denied = authorize(context, operationScope(operation));
    if (denied) {
      return denied;
    }
    const output = await operation.execute(input);
    return context.json(output, accepted?.(output) ? 202 : 200);
  }

  function authorize(context: Context, scope: FinancialScope) {
    if (permits(context.get("identity").scopes, scope)) {
      return;
    }
    context.header(
      "WWW-Authenticate",
      `${challenge}, error="insufficient_scope"`,
    );
    return context.json(failure("forbidden", "Permission denied."), 403);
  }

  function parseQueryInput(context: Context) {
    const values: Record<string, unknown> = {};
    const parameters = new URL(context.req.url).searchParams;
    for (const [key, value] of parameters) {
      if (Object.hasOwn(values, key)) {
        throw new InputError();
      }
      if (key === "limit") {
        if (!/^(0|[1-9][0-9]*)$/.test(value)) {
          throw new InputError();
        }
        values[key] = Number(value);
      } else if (BOOLEAN_QUERY_KEYS.has(key)) {
        if (value !== "true" && value !== "false") {
          throw new InputError();
        }
        values[key] = value === "true";
      } else {
        values[key] = value;
      }
    }
    return values;
  }

  async function parseJsonInput(context: Context) {
    if (!isJsonContentType(context.req.header("Content-Type"))) {
      throw new InputError();
    }
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      throw new InputError();
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new InputError();
    }
    return input as Record<string, unknown>;
  }

  /** An operation's input: its path segments, then its query or JSON body. */
  async function routeInput(context: Context, route: RestRoute) {
    const input =
      route.method === "GET"
        ? parseQueryInput(context)
        : await parseJsonInput(context);
    const path = pathInputs(route);
    // An input the path carries, or the route refuses, never arrives otherwise.
    if (
      [...path, ...(route.excluded ?? [])].some((name) =>
        Object.hasOwn(input, name),
      )
    ) {
      throw new InputError();
    }
    for (const name of path) {
      input[name] = context.req.param(name);
    }
    return input;
  }

  app.get(
    "/health",
    (context) =>
      authorize(context, "financial:read") ??
      context.json({
        service: "fonds",
        status: "ok",
        storage: application.backend,
        scope: hosted ? "hosted-single-owner" : "local-single-owner",
      }),
  );
  for (const route of REST_ROUTES) {
    // An optional capability's operation is absent, and so is its route.
    const operation = operations.get(route.operation);
    if (operation) {
      app.on(route.method, route.path, async (context) =>
        executeOperation(
          context,
          operation,
          await routeInput(context, route),
          route.accepted,
        ),
      );
    }
  }
  app.all("/mcp", async (context) => {
    const identity = context.get("identity");
    // MCP needs at least one financial grant; each tool checks its own scope.
    if (!FINANCIAL_SCOPES.some((scope) => permits(identity.scopes, scope))) {
      return authorize(context, "financial:read")!;
    }
    const subscription = (await opensSubscriptionStream(context.req.raw))
      ? new Request(context.req.raw, {
          signal: AbortSignal.any([
            context.req.raw.signal,
            subscriptionStreams.signal,
          ]),
        })
      : undefined;
    const response = await mcp.fetch(subscription ?? context.req.raw, {
      authInfo: {
        token: "",
        clientId: identity.clientId,
        scopes: [...identity.scopes],
        extra: { identity: { ...identity, scopes: [...identity.scopes] } },
      },
    });
    if (subscription && response.body) {
      subscriptionRequests.set(response.body, subscription);
    }
    return response;
  });
  return {
    app,
    /** Ends MCP subscription streams; accepted requests keep running. */
    stop: async () => {
      subscriptionStreams.abort();
    },
    /** Ends every MCP exchange still in flight. */
    close: async () => {
      await mcp.close();
    },
  };
}
