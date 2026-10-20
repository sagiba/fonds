import {
  type CallToolResult,
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";

import type { EventService } from "../application/events.js";
import { type Application, publicError } from "../application/operations.js";
import { FONDS_VERSION } from "../application/version.js";
import { operationScope, permits } from "./auth.js";
import { registerMcpEvents } from "./mcp-events.js";

function toolResult(value: unknown, isError = false): CallToolResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Application operation must return an object");
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

/** One tool definition per shared application operation, usable over HTTP or stdio. */
export function createMcpServer(
  application: Application,
  scopes?: readonly string[],
  events?: EventService,
): McpServer {
  const server = new McpServer({
    name: "fonds",
    version: FONDS_VERSION,
  });
  if (events) {
    registerMcpEvents(server, events);
  }
  for (const operation of application.operations) {
    server.registerTool(
      operation.name,
      {
        description: operation.description,
        inputSchema: operation.inputSchema,
        outputSchema: operation.outputSchema,
        annotations: {
          readOnlyHint: operation.readOnly,
          destructiveHint: operation.access === "write",
          idempotentHint: operation.access === "read",
          openWorldHint: operation.openWorld ?? false,
        },
      },
      async (input) => {
        if (
          scopes !== undefined &&
          !permits(scopes, operationScope(operation))
        ) {
          return toolResult(
            { error: { code: "forbidden", message: "Permission denied." } },
            true,
          );
        }
        try {
          return toolResult(await operation.execute(input));
        } catch (error) {
          const { code, message } = publicError(error);
          return toolResult({ error: { code, message } }, true);
        }
      },
    );
  }
  return server;
}

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * Whether a request opens a modern `subscriptions/listen` stream, which stays
 * open until its client leaves. The SDK rejects a modern request whose
 * Mcp-Method header and body disagree; legacy requests are not cross-checked
 * and never open one.
 */
export async function opensSubscriptionStream(request: Request) {
  return (
    request.headers.get("mcp-method") === "subscriptions/listen" &&
    !(await isLegacyRequest(request, undefined, {
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    }))
  );
}

/** Authentication and Host/Origin checks belong to the HTTP wrapper. Missing grants deny tools by default. */
export function createMcpHttpHandler(
  application: Application,
  options: { events?: EventService } = {},
): McpHttpHandler {
  return createMcpHandler(
    (context) =>
      createMcpServer(
        application,
        [...(context.authInfo?.scopes ?? [])],
        options.events,
      ),
    {
      legacy: "stateless",
      responseMode: "json",
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    },
  );
}
