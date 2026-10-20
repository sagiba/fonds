# Connect ChatGPT over MCP

ChatGPT connects to a [hosted service](hosted-service.md) deployment at its
public origin (`FONDS_PUBLIC_ORIGIN`), which must be HTTPS and reachable from the
internet. A [Docker](docker.md) stack on your own machine needs a TLS proxy or a
[tunnel](docker.md#quick-tunnel) in front of it; on [Neon](neon-deployment.md)
the origin is the Function URL.

Use ChatGPT's **Add custom MCP server** flow with this Server URL:

```text
https://YOUR_PUBLIC_ORIGIN/mcp
```

1. Open Plugins, select the plus button, then **Add custom MCP server**.
2. Choose **Server URL** and enter the URL above. Use a distinct name such as Fonds.
3. Choose **OAuth**. Leave static client ID and client secret empty; select **CIMD** when offered. Leave advanced authorization/token URL overrides empty.
4. Create/connect. On Fonds's login page, sign in with a passkey or an owner-linked Google/GitHub account (on Neon, also **Continue with Google** with the configured owner Google account, which needs no Google app of your own), then approve the requested access. Without a passkey yet, first open a [login link](hosted-service.md#owner-login-and-authorization) in the same browser, add a passkey on `/account`, then connect.
5. Install/enable the resulting plugin in the existing dot and call `list_connections`. Verify the expected connection and read synthetic data before enabling collection.

These UI and CIMD steps follow the
[official custom-server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and [OAuth guide](https://developers.openai.com/plugins/build/auth).

## Authentication behavior

Discovery points to the Fonds issuer at the same origin's `/api/auth`, and `/mcp`
is the exact token resource for both MCP and REST. The flow uses PKCE and
interactive owner login and consent; the scopes it advertises are in
[owner login and authorization](hosted-service.md#owner-login-and-authorization).
The [security model](../security-model.md#admission) owns who and which clients
are admitted, and [what revocation stops](../security-model.md#revocation). On
Neon, Google sign-in uses Neon's shared credentials, labelled for development
and testing; see
[Neon owner login](neon-deployment.md#owner-login-and-authorization).

## Refresh and notifications

Use the connection ID `list_connections` returns. `refresh_connection` starts a
[refresh](../api.md#refreshes) that calls the provider and needs
`financial:write`; `get_refresh`, `list_refreshes` and `list_sync_runs` read
progress with `financial:read`. After an interrupted request, read refreshes
before retrying. Normal read tools never start collection. Only an
[operator retry](hosted-service.md#collection-refresh-and-scheduling)
(`node server.js collect`, or `neon:smoke --collect` on Neon) that succeeds
clears an authentication block. [Scheduled collection](hosted-service.md#scheduling) is
off until the deployment sets `FONDS_COLLECTION_SCHEDULE`; verify one scheduled
run on each new deployment.

The server also advertises draft [MCP Events](hosted-service.md#mcp-events-and-webhook-delivery).
Installing the plugin does not prove ChatGPT subscribed, and subscription
renewal has not been verified against a real host yet. If the host does not
show the current event catalog, refresh the connection's metadata
([official guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata))
and start a fresh conversation. Verify `changes.available` is advertised, then
distinguish discovery from an actual callback subscription. Do not delete
transactions to manufacture a notification test.

## Verification and troubleshooting

Verify login, consent, scope-restricted reads and writes and event behavior on
the deployed revision. Smoke checks and scripted tests do not establish the real
ChatGPT connection, or a real browser's Origin, cookies or CSP redirect
behavior; repeat the real Connect flow after changing those paths. Installing
the plugin alone proves neither owner login nor event delivery.

If a sign-in callback fails, report only its non-secret visible error. There is
no password fallback ([admission](../security-model.md#admission)); verify
public password and sign-up denial on your own deployment. Never share cookies,
bearer tokens, full callback URLs or private environment and credential files.

A normal code redeploy should preserve the stored owner and grants; replacing
auth state or rotating secrets is a different operation requiring separate
acceptance. The [hosted-service guide](hosted-service.md) owns setup and
recovery constraints.
