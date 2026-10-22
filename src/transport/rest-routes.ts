export interface RestRoute {
  method: "GET" | "POST" | "PATCH";
  /** `:name` segments are taken from the operation input. */
  path: string;
  /** Answers 202 while the work it started is still running. */
  accepted?: boolean;
}

/** Each operation's `/v1` route, shared by the REST client and the API description. */
export const restRoutes: Readonly<Record<string, RestRoute>> = {
  list_connections: { method: "GET", path: "/v1/connections" },
  get_connection: { method: "GET", path: "/v1/connections/:connectionId" },
  list_cards: { method: "GET", path: "/v1/cards" },
  get_card: { method: "GET", path: "/v1/cards/:cardId" },
  list_accounts: { method: "GET", path: "/v1/accounts" },
  get_account: { method: "GET", path: "/v1/accounts/:accountId" },
  list_transactions: { method: "GET", path: "/v1/transactions" },
  get_transaction: {
    method: "GET",
    path: "/v1/transactions/:transactionId",
  },
  get_transaction_totals: { method: "GET", path: "/v1/transactions/totals" },
  list_events: { method: "GET", path: "/v1/events" },
  list_sync_runs: {
    method: "GET",
    path: "/v1/connections/:connectionId/sync-runs",
  },
  update_annotation: {
    method: "PATCH",
    path: "/v1/transactions/:transactionId/annotation",
  },
  refresh_connection: {
    method: "POST",
    path: "/v1/connections/:connectionId/refreshes",
    accepted: true,
  },
  get_refresh: { method: "GET", path: "/v1/refreshes/:refreshId" },
  list_refreshes: {
    method: "GET",
    path: "/v1/connections/:connectionId/refreshes",
  },
  undo_annotation: { method: "POST", path: "/v1/annotations/undo" },
  link_pending_transaction: {
    method: "POST",
    path: "/v1/transactions/:transactionId/link-pending",
  },
  unlink_pending_transaction: {
    method: "POST",
    path: "/v1/transactions/:transactionId/unlink-pending",
  },
  confirm_removal: {
    method: "POST",
    path: "/v1/transactions/:transactionId/removal",
  },
};

/** refresh_connection without a connectionId starts every connection's refresh. */
export const REFRESH_ALL_ROUTE: RestRoute = {
  method: "POST",
  path: "/v1/refreshes",
  accepted: true,
};
