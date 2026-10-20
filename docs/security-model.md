# Security model

Fonds is a self-hosted, single-owner service. This page states what it protects,
what it deliberately does not, and what the person running it is responsible for.
Report suspected vulnerabilities as [SECURITY.md](../SECURITY.md) describes.

## What Fonds protects

- **The owner's access.** A deployment has exactly one owner. Owner sign-in
  happens by passkey, a one-time login link issued from the deployment itself, or
  a Google or GitHub account the signed-in owner linked (Neon deployments can also
  use Neon's managed Google sign-in). See [admission](#admission).
- **Client access.** API and MCP clients act only through
  [OAuth grants](#admission) for the deployment's exact `/mcp` resource. The
  local SQLite
  server uses a private bearer token instead and listens on loopback only. That
  token can refresh connections whose credentials `connect` stored and subscribe
  to Events webhooks; a stdio host can refresh but not subscribe.
- **Provider credentials.** Credentials saved with `connect` are encrypted per
  connection (AES-256-GCM, bound to the connection and provider) with a key kept
  outside the database. Credentials never belong in MCP inputs or results, logs or
  committed files.
- **Request boundaries.** Hosted requests must match the configured public origin
  and Host, and operator and scheduler endpoints require their own secrets. For Neon's
  native schedule, the function routes
  `/internal/triggers/recent` ahead of the Host/Origin guard and accepts it only
  with Neon's reserved platform attestation header, a valid envelope naming the
  `collect-hourly` trigger, a scheduled timestamp and at most 8 KiB of JSON
  ([Neon runbook](guides/neon-deployment.md)). Webhook delivery refuses non-public
  network addresses. On Node hosts, auth rate limits key on a
  [client address](guides/hosted-service.md#client-addresses) from the connection
  or a proxy declared with `FONDS_TRUST_PROXY`, never from a header the client
  sets.
- **Financial records.** Writes are atomic. Defined financial fields and owner
  annotations are versioned; enrichment fields can update without a version, as
  the [API reference](api.md) documents. The evidence a record was derived from
  stays attached to it.

A way around any of these, from outside the deployment's own host, environment
and state, is a vulnerability. A copy of the database alone exposes the plaintext
ledger but must never expose provider credentials.

## Admission

- **No new accounts.** Public sign-up, dynamic client registration and browser
  password login are disabled. A Google or GitHub account signs in only after the
  signed-in owner links it; accounts are never matched or created by email. On
  Neon, the bridge pins the upstream user and Google account it first bound to the
  owner, so an unrelated managed Neon Auth account does not become the owner.
- **One client.** The only admitted OAuth client is ChatGPT's metadata document,
  `https://chatgpt.com/oauth/client.json`, authenticating with `private_key_jwt`.
  Fonds fetches only that document and its `https://chatgpt.com/oauth/jwks.json`
  keys.
- **Exact grants.** Each financial request needs the sole owner, the admitted
  client, the exact `/mcp` resource and the operation's scope, `financial:read` or
  `financial:write`; neither implies the other.
- **Bearers.** A valid owner session, access token or local token grants its
  holder the corresponding access; Fonds cannot tell a shared or stolen one apart.

## Revocation

- **Access tokens outlive revocation.** Access JWTs are verified locally by
  signature and expiry and last the pinned auth library's default of one hour.
  Revoking a refresh grant stops further refresh at once, but an access JWT
  already issued remains usable until it expires.
- **Events follow the current grant.** A subscription needs an active, unrevoked,
  unexpired grant with `financial:read` for the same owner, client and resource.
  Fonds rechecks it before each delivery, including retries, and stops delivering
  once none remains or the owner or client is removed or disabled.
  Logging out or a browser session expiring does not revoke an offline grant or
  stop its subscriptions.
- **Local tokens.** Replacing the local bearer token does not end an Events
  subscription made with it; unsubscribing or its expiry (at most seven days) does.

## Known limitations

These are deliberate and documented; reporting them is not needed, but a new
exploit that uses them still is.

- **The ledger is not encrypted at rest.** Financial records and archived source
  responses are stored as plain data in your database. Only stored provider
  credentials are encrypted.
- **Archives can contain personal data.** Financial responses are kept exactly as
  received, apart from the [documented exceptions](design.md#personal-data), and
  can include holder data.
- **Assistants see what they read.** An authorized client receives the records its
  grant permits; with ChatGPT or Claude, that data goes to the assistant's
  provider.
- **The host is trusted.** Whoever controls the server, its environment or the
  state directory controls the data and the credentials key.
- **Neon's client address is unverified.** On Neon, auth rate limits key on the
  right-most `X-Forwarded-For` entry, which Neon's ingress has not been confirmed
  to set; if it passes a client's header through, a client can evade the limit or
  use up another address's (not gain access).
- **An issued access token survives revocation** until it expires (see
  [revocation](#revocation)).
- **Collection uses providers' internal web APIs,** which can change or be blocked
  at any time.

## Your responsibilities

- Choose and secure the host, the database and the network path to them. Use TLS
  for remote databases and a TLS-terminating proxy for public hosted endpoints.
  Make the proxy the only way to reach Fonds, have it append the client's
  address to `X-Forwarded-For`, and declare it with `FONDS_TRUST_PROXY`.
- Back up the database together with its secrets (the state directory, or Neon's
  private env file); Fonds refuses a database with any other secrets
  ([state directory and backup](database.md#state-directory-and-backup)).
- Keep the deployment updated, and revoke grants and passkeys you no longer use.
- Decide which assistants and clients you connect, and what they may do.

## Out of scope

- Attacks that already require control of the deployment's host, its
  environment or state directory, or the host account.
- The providers' own systems, and the security of the assistants and hosting
  platforms you choose.
