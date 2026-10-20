import {
  type AuthInfo,
  type McpServer,
  ProtocolError,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  CallbackEndpointError,
  EventError,
  eventListSchema,
  type EventPrincipal,
  type EventService,
  eventSubscribeSchema,
  eventUnsubscribeSchema,
} from "../application/events.js";

const principalSchema = z
  .object({
    ownerId: z.string().min(1),
    clientId: z.string().min(1),
    scopes: z.array(z.string()),
  })
  .loose();

/** Identity binding only; the event service owns the `financial:read` check. */
function principal(authInfo?: AuthInfo): EventPrincipal {
  const identity = principalSchema.safeParse(authInfo?.extra?.identity);
  if (!identity.success || authInfo?.clientId !== identity.data.clientId) {
    throw new ProtocolError(-32001, "Permission denied.");
  }
  return {
    ownerId: identity.data.ownerId,
    clientId: identity.data.clientId,
    scopes: authInfo.scopes,
  };
}

/** SDK 2.3.1 supports draft Events through its validated custom-method API. */
export function registerMcpEvents(server: McpServer, events: EventService) {
  const capabilities: ServerCapabilities & { events: Record<string, never> } = {
    events: {},
  };
  server.server.registerCapabilities(capabilities);

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CallbackEndpointError) {
        throw new ProtocolError(error.code, error.message, {
          reason: error.reason,
        });
      }
      if (error instanceof EventError) {
        throw new ProtocolError(error.code, error.message);
      }
      if (error instanceof ProtocolError) {
        throw error;
      }
      if (error instanceof z.ZodError) {
        throw new ProtocolError(-32602, "Invalid event parameters.");
      }
      throw new ProtocolError(-32603, "Event operation failed.");
    }
  }

  // The protocol's reserved _meta envelope is not part of application arguments.
  const meta = z.record(z.string(), z.unknown()).optional();
  server.server.setRequestHandler(
    "events/list",
    {
      params: eventListSchema.extend({ _meta: meta }),
    },
    (params, context) =>
      run(() =>
        events.list(principal(context.http?.authInfo), {
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        }),
      ),
  );
  server.server.setRequestHandler(
    "events/subscribe",
    {
      params: eventSubscribeSchema.extend({ _meta: meta }),
    },
    (params, context) => {
      const { name, arguments: args, delivery, cursor, ttlMs } = params;
      return run(() =>
        events.subscribe(principal(context.http?.authInfo), {
          name,
          arguments: args,
          delivery,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
        }),
      );
    },
  );
  server.server.setRequestHandler(
    "events/unsubscribe",
    {
      params: eventUnsubscribeSchema.extend({ _meta: meta }),
    },
    (params, context) =>
      run(() =>
        events.unsubscribe(principal(context.http?.authInfo), {
          name: params.name,
          arguments: params.arguments,
          delivery: params.delivery,
        }),
      ),
  );
}
