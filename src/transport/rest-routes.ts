/**
 * One `/v1` route of an operation. The HTTP service registers it, the REST
 * client calls it and the API description documents it, so all three agree.
 */
export interface RestRoute {
  operation: string;
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

/** Registration order: a static path precedes a parameter path it would match. */
export const REST_ROUTES: readonly RestRoute[] = [
  { operation: "list_connections", method: "GET", path: "/v1/connections" },
  {
    operation: "get_connection",
    method: "GET",
    path: "/v1/connections/:connectionId",
  },
  { operation: "list_accounts", method: "GET", path: "/v1/accounts" },
  { operation: "get_account", method: "GET", path: "/v1/accounts/:accountId" },
  { operation: "list_cards", method: "GET", path: "/v1/cards" },
  { operation: "get_card", method: "GET", path: "/v1/cards/:cardId" },
  {
    operation: "refresh_connection",
    method: "POST",
    path: "/v1/connections/:connectionId/refreshes",
    accepted: refreshStillRunning,
  },
  {
    // Without a connection, refresh_connection starts every connection's.
    operation: "refresh_connection",
    operationId: "refresh_all_connections",
    method: "POST",
    path: "/v1/refreshes",
    excluded: ["connectionId"],
    accepted: refreshStillRunning,
  },
  {
    operation: "list_refreshes",
    method: "GET",
    path: "/v1/connections/:connectionId/refreshes",
  },
  { operation: "get_refresh", method: "GET", path: "/v1/refreshes/:refreshId" },
  { operation: "list_transactions", method: "GET", path: "/v1/transactions" },
  {
    operation: "get_transaction_totals",
    method: "GET",
    path: "/v1/transactions/totals",
  },
  {
    operation: "get_transaction",
    method: "GET",
    path: "/v1/transactions/:transactionId",
  },
  { operation: "list_events", method: "GET", path: "/v1/events" },
  {
    operation: "list_sync_runs",
    method: "GET",
    path: "/v1/connections/:connectionId/sync-runs",
  },
  {
    operation: "update_annotation",
    method: "PATCH",
    path: "/v1/transactions/:transactionId/annotation",
  },
  {
    operation: "undo_annotation",
    method: "POST",
    path: "/v1/annotations/undo",
  },
  {
    operation: "link_pending_transaction",
    method: "POST",
    path: "/v1/transactions/:transactionId/link-pending",
  },
  {
    operation: "unlink_pending_transaction",
    method: "POST",
    path: "/v1/transactions/:transactionId/unlink-pending",
  },
  {
    operation: "confirm_removal",
    method: "POST",
    path: "/v1/transactions/:transactionId/removal",
  },
];

/** The inputs a route's path carries, in path order. */
export function pathInputs(route: RestRoute): string[] {
  return [...route.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => name!);
}
