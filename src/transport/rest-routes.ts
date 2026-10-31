import type { OperationName } from "../application/operations.js";

/**
 * One `/v1` route of an operation. The HTTP service registers it, the REST
 * client calls it and the API description documents it, so all three agree.
 */
export interface RestRoute {
  /** The API description's name for the route; defaults to the operation's. */
  operationId?: string;
  method: "GET" | "POST" | "PATCH";
  /**
   * `:name` segments carry the input of that name. A GET reads its other
   * inputs from the query; other methods from a JSON object body.
   */
  path: string;
  /** Inputs this route refuses wherever they appear. */
  excluded?: readonly string[];
  /** Answers 202 instead of 200 when this holds for the output. */
  accepted?: (output: unknown) => boolean;
}

/** A refresh it started is still running in the background. */
function refreshStillRunning(output: unknown) {
  const { refresh, refreshes = [] } = output as {
    refresh?: { status: string };
    refreshes?: { refresh: { status: string } | null }[];
  };
  return [refresh, ...refreshes.map((entry) => entry.refresh)].some(
    (item) => item?.status === "pending" || item?.status === "running",
  );
}

/**
 * Each operation's routes; a missing operation fails to compile. Routes register
 * in this order, so a static path precedes a parameter path it would also match.
 */
export const OPERATION_ROUTES = {
  list_connections: [{ method: "GET", path: "/v1/connections" }],
  get_connection: [{ method: "GET", path: "/v1/connections/:connectionId" }],
  get_connection_coverage: [
    { method: "GET", path: "/v1/connections/:connectionId/coverage" },
  ],
  list_accounts: [{ method: "GET", path: "/v1/accounts" }],
  get_account: [{ method: "GET", path: "/v1/accounts/:accountId" }],
  list_cards: [{ method: "GET", path: "/v1/cards" }],
  get_card: [{ method: "GET", path: "/v1/cards/:cardId" }],
  refresh_connection: [
    {
      method: "POST",
      path: "/v1/connections/:connectionId/refreshes",
      accepted: refreshStillRunning,
    },
    // Without a connection, refresh_connection starts every connection's.
    {
      operationId: "refresh_all_connections",
      method: "POST",
      path: "/v1/refreshes",
      excluded: ["connectionId"],
      accepted: refreshStillRunning,
    },
  ],
  list_refreshes: [
    { method: "GET", path: "/v1/connections/:connectionId/refreshes" },
  ],
  get_refresh: [{ method: "GET", path: "/v1/refreshes/:refreshId" }],
  list_transactions: [{ method: "GET", path: "/v1/transactions" }],
  get_transaction_totals: [{ method: "GET", path: "/v1/transactions/totals" }],
  get_transaction: [{ method: "GET", path: "/v1/transactions/:transactionId" }],
  list_events: [{ method: "GET", path: "/v1/events" }],
  list_sync_runs: [
    { method: "GET", path: "/v1/connections/:connectionId/sync-runs" },
  ],
  update_annotation: [
    { method: "PATCH", path: "/v1/transactions/:transactionId/annotation" },
  ],
  undo_annotation: [{ method: "POST", path: "/v1/annotations/undo" }],
  link_pending_transaction: [
    { method: "POST", path: "/v1/transactions/:transactionId/link-pending" },
  ],
  unlink_pending_transaction: [
    { method: "POST", path: "/v1/transactions/:transactionId/unlink-pending" },
  ],
  confirm_removal: [
    { method: "POST", path: "/v1/transactions/:transactionId/removal" },
  ],
} satisfies Record<OperationName, readonly [RestRoute, ...RestRoute[]]>;

export interface OperationRoute extends RestRoute {
  operation: OperationName;
}

/** Every route with its operation, in registration order. */
export const REST_ROUTES: readonly OperationRoute[] = Object.entries(
  OPERATION_ROUTES,
).flatMap(([operation, routes]) =>
  routes.map((route) => ({ ...route, operation: operation as OperationName })),
);

/** The inputs a route's path carries, in path order. */
export function pathInputs(route: RestRoute): string[] {
  return [...route.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => name!);
}
