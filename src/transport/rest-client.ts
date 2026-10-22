import { isPathAddressable } from "../application/financial-store.js";
import type {
  OperationInvoker,
  OperationName,
} from "../application/operations.js";
import { isHttpsOrLoopback, LOOPBACK_HOSTS } from "./auth.js";
import { OPERATION_ROUTES, pathInputs, type RestRoute } from "./rest-routes.js";

/** A failed remote call: the service's public error code and message only. */
export class RemoteOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** HTTPS, or plain HTTP to this machine only; a bearer never crosses the network unencrypted. */
export function remoteOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteOperationError(0, "invalid_remote", "Invalid remote URL.");
  }
  if (
    !isHttpsOrLoopback(url) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new RemoteOperationError(
      0,
      "invalid_remote",
      "The remote must be an https:// origin, or http:// on this machine, without a path.",
    );
  }
  return url.origin;
}

export function isLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(origin).hostname);
}

/**
 * Known public error codes with fixed local text. A remote's own messages are
 * never printed: another service's response could carry anything.
 */
const remoteErrors: Readonly<Record<string, string>> = {
  invalid_input: "Invalid operation input.",
  not_found: "Requested record was not found.",
  conflict:
    "State changed or the action conflicts with current state. Read it again before retrying.",
  output_too_large:
    "Requested output exceeds the response limit. Narrow the request.",
  unauthorized: "Authentication required.",
  forbidden: "Permission denied.",
  refresh_in_progress:
    "A refresh of this connection is already running. Read it with list_refreshes.",
  requires_attention:
    "The provider needs the owner's attention. Refreshes resume after an operator retry.",
  internal_error: "Operation failed.",
  unavailable: "Service unavailable.",
};

function invalidInput() {
  return new RemoteOperationError(
    0,
    "invalid_input",
    "Invalid operation input.",
  );
}

function isQueryValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function remoteError(status: number, payload: unknown) {
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" && Object.hasOwn(remoteErrors, code)
    ? new RemoteOperationError(status, code, remoteErrors[code]!)
    : new RemoteOperationError(
        status,
        "request_failed",
        `The remote request failed with HTTP ${status}.`,
      );
}

/** Calls operations through a deployment's REST API with a bearer token. */
export function createRestClient(options: {
  origin: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): OperationInvoker {
  const origin = remoteOrigin(options.origin);
  const send = options.fetch ?? fetch;
  return {
    async invoke(name, input) {
      const values = { ...(input as Record<string, unknown>) };
      const routes: readonly RestRoute[] = Object.hasOwn(OPERATION_ROUTES, name)
        ? OPERATION_ROUTES[name as OperationName]
        : [];
      // Of several routes, the one whose path the input fills and whose
      // refused inputs it omits, e.g. refreshing one connection or all.
      const route =
        routes.find(
          (entry) =>
            pathInputs(entry).every((key) => values[key] !== undefined) &&
            !entry.excluded?.some((key) => values[key] !== undefined),
        ) ?? routes[0];
      if (!route) {
        throw new RemoteOperationError(
          0,
          "unavailable",
          "Operation unavailable.",
        );
      }
      const path = route.path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
        const value = values[key];
        delete values[key];
        if (typeof value !== "string" || !isPathAddressable(value)) {
          throw invalidInput();
        }
        return encodeURIComponent(value);
      });
      const url = new URL(path, origin);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
      };
      let body: string | undefined;
      if (route.method === "GET") {
        for (const [key, value] of Object.entries(values)) {
          if (isQueryValue(value)) {
            url.searchParams.set(key, String(value));
          } else if (value !== undefined) {
            throw invalidInput();
          }
        }
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(values);
      }
      let response: Response;
      try {
        response = await send(url, {
          method: route.method,
          headers,
          ...(body !== undefined && { body }),
          // Redirects could carry the bearer elsewhere; the API never redirects.
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
      } catch {
        throw new RemoteOperationError(
          0,
          "unreachable",
          "The remote service could not be reached.",
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new RemoteOperationError(
          response.status,
          "invalid_response",
          "The remote service returned an invalid response.",
        );
      }
      if (!response.ok) {
        throw remoteError(response.status, payload);
      }
      return payload;
    },
  };
}
