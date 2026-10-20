import { serve } from "@hono/node-server";

import type { EventService } from "../application/events.js";
import type { FinancialStore } from "../application/financial-store.js";
import {
  type Application,
  createApplication,
} from "../application/operations.js";
import { createHttpService } from "../transport/http.js";
import { StateError } from "./state.js";

/** What a launcher composes over its store, such as `createLocalService`. */
export interface ComposedNodeService {
  application: Application;
  events?: EventService;
  /** Started once the service listens; stopped and settled at shutdown. */
  scheduler?: {
    start(): void;
    stop(): void;
    settled(): Promise<void>;
  };
}

/** The signal ends the composition's collections at shutdown. */
export type NodeServiceComposition = (
  signal: AbortSignal,
) => ComposedNodeService | Promise<ComposedNodeService>;

export interface NodeServiceOptions {
  token: string;
  port?: number;
  /** Without one, the store's operations only. */
  compose?: NodeServiceComposition;
}

/** Same authenticated HTTP/MCP surface for every SQL adapter. */
export async function startNodeService(
  store: FinancialStore,
  options: NodeServiceOptions,
) {
  const shutdown = new AbortController();
  const composed = await options.compose?.(shutdown.signal);
  const service = createHttpService(
    composed?.application ?? createApplication(store),
    {
      token: options.token,
      ...(composed?.events && { events: composed.events }),
    },
  );
  const scheduler = composed?.scheduler;
  const running = await listen(
    (request) => service.app.fetch(request),
    {
      // Interrupted refreshes record their state before the store closes.
      stop: async () => {
        scheduler?.stop();
        shutdown.abort();
        await service.stop();
      },
      dispose: async () => {
        // A scheduled run is not a request the listener drains.
        await scheduler?.settled();
        await service.close();
      },
    },
    { hostname: "127.0.0.1", port: options.port ?? 8787 },
  );
  scheduler?.start();
  return running;
}

/** How long close() waits for accepted requests before closing their connections. */
export const DRAIN_DEADLINE_MS = 5_000;

/** What a listener shuts down, in order, around draining accepted requests. */
export interface ListenedService {
  /** Ends long-lived work (subscription streams, collections) so requests can finish. */
  stop(): Promise<void>;
  /** Releases resources accepted requests may still use, such as database pools. */
  dispose?(): Promise<void>;
}

/**
 * Serves a fetch handler on Node until close(), which stops accepting
 * connections, stops the service, waits up to DRAIN_DEADLINE_MS for accepted
 * requests and their responses, closes any connection still open, and only
 * then disposes the service. The deadline bounds stopping and draining, not
 * dispose(): a handler still running after it has lost its client but may
 * still hold resources that dispose() waits for.
 */
export async function listen(
  fetch: (
    request: Request,
    socketAddress: string | undefined,
  ) => Response | Promise<Response>,
  service: ListenedService,
  address: { hostname: string; port: number },
) {
  // A handler can outlive its connection, for example after its client gives up.
  const handlers = new Set<Promise<Response>>();
  // The socket is plain HTTP, so an https: URL can only come from an
  // absolute-form request target; scheme claims belong to an explicit proxy mode.
  const server = serve({
    fetch: (request, { incoming }) => {
      if (new URL(request.url).protocol !== "http:") {
        return new Response(null, { status: 400 });
      }
      const handled = (async () =>
        fetch(request, incoming.socket.remoteAddress))();
      const forget = () => handlers.delete(handled);
      handlers.add(handled);
      handled.then(forget, forget);
      return handled;
    },
    ...address,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    await service.stop();
    await service.dispose?.();
    server.close();
    throw error;
  }
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    throw new Error("Missing server address");
  }
  let closing: Promise<void> | undefined;
  // A response still being written when close() drains leaves a keep-alive
  // connection behind. Close idle connections only after every accepted response
  // has closed: Node treats an ended but still-buffered pipelined response as idle.
  // Responses are tracked by connection because queued pipelined responses on an
  // aborted connection never emit close on some supported Node 24 releases.
  const openResponses = new Map<object, object>();
  const closeIdleConnections = () => {
    if ("closeIdleConnections" in server) {
      server.closeIdleConnections();
    }
  };
  const closeIdleWhenDrained = () => {
    if (closing && openResponses.size === 0) {
      closeIdleConnections();
    }
  };
  server.on("connection", (socket) => {
    socket.once("close", () => {
      for (const [response, connection] of openResponses) {
        if (connection === socket) {
          openResponses.delete(response);
        }
      }
      closeIdleWhenDrained();
    });
  });
  server.on("request", (request, response) => {
    openResponses.set(response, request.socket);
    response.once("close", () => {
      openResponses.delete(response);
      closeIdleWhenDrained();
    });
  });
  const host = bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
  return {
    url: `http://${host}:${bound.port}`,
    close: () => {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        let stopFailure: { error: unknown } | undefined;
        const drained = (async () => {
          try {
            await service.stop();
          } catch (error) {
            // Accepted requests may still be running: drain, then report it.
            stopFailure = { error };
          }
          closeIdleConnections();
          await closed;
          while (handlers.size > 0) {
            await Promise.allSettled(handlers);
          }
          return true;
        })();
        let deadline: NodeJS.Timeout | undefined;
        try {
          const drainedInTime = await Promise.race([
            drained,
            new Promise<false>((resolve) => {
              deadline = setTimeout(resolve, DRAIN_DEADLINE_MS, false);
            }),
          ]);
          if (!drainedInTime) {
            if ("closeAllConnections" in server) {
              server.closeAllConnections();
            }
            await closed;
          }
        } finally {
          clearTimeout(deadline);
          await service.dispose?.();
        }
        if (stopFailure) {
          throw stopFailure.error;
        }
      })();
      return closing;
    },
  };
}

/** Environment variables are read by the process, never accepted as model inputs. */
export function serviceOptionsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeServiceOptions {
  const token = env.FONDS_API_TOKEN;
  if (!token) {
    throw new Error("FONDS_API_TOKEN is required");
  }
  const portText = env.PORT ?? "8787";
  if (!/^\d+$/.test(portText) || Number(portText) > 65535) {
    throw new Error("Invalid port");
  }
  return { token, port: Number(portText) };
}

export async function runNodeService<
  Store extends FinancialStore & { close(): Promise<void> },
>(
  connect: () => Promise<Store>,
  /** The launcher's composition over its opened store, if any. */
  compose?: (
    store: Store,
    signal: AbortSignal,
  ) => ReturnType<NodeServiceComposition>,
  env: NodeJS.ProcessEnv = process.env,
) {
  let store: Store | undefined;
  try {
    const options = serviceOptionsFromEnvironment(env);
    store = await connect();
    // Check connectivity and schema before advertising readiness.
    await store.listConnections();
    const opened = store;
    const running = await startNodeService(store, {
      ...options,
      ...(compose && {
        compose: (signal: AbortSignal) => compose(opened, signal),
      }),
    });
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void running
        .close()
        .then(() => store!.close())
        .catch(() => {
          process.stderr.write("Service shutdown failed.\n");
          process.exitCode = 1;
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stderr.write(`Fonds listening at ${running.url}; MCP at /mcp.\n`);
  } catch (error) {
    try {
      await store?.close();
    } catch {
      // Startup and cleanup errors share the same fixed, secret-free diagnostic.
    }
    process.stderr.write(
      error instanceof StateError
        ? `${error.message}\n`
        : "Could not start service. Check backend configuration, schema, token and port availability.\n",
    );
    process.exitCode = 1;
  }
}
