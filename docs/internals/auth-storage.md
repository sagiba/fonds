# Hosted identity storage

This identity section of the [database reference](../database.md) covers the
PostgreSQL `identity` namespace that the
[Better Auth configuration](../../src/runtime/auth/better-auth.ts) and
[Neon Google bridge](../../deploy/neon/neon-login.ts) create: who owns it, what
the bridge stores, where SQL differs from library behavior and what recovery needs.

## Ownership and verification

Better Auth, `@better-auth/core`, `@better-auth/mcp`, `@better-auth/oauth-provider`,
`@better-auth/cimd` and `@better-auth/passkey` are pinned to **1.7.10**, and move together. Configured
plugins are JWT signing, passkeys, magic-link login links, the MCP OAuth provider,
CIMD and, on Neon, the application Google bridge. Optional Google/GitHub sign-in
uses Better Auth's built-in social providers. Database-backed rate limiting is
enabled. The library migration API creates 14 vendor-owned tables; Neon setup
additionally provisions the two bridge tables below. Vendor schema
changes belong to an intentional package/configuration upgrade, rather than the
financial Drizzle schema or a product rename.

The vendor schema is the pinned library's, not application-managed DDL to copy or
maintain independently, so this page does not transcribe its columns and indexes.
The schema facts below come from running the configured migration against a fresh
disposable PostgreSQL 18.6 schema with invented configuration and a synthetic
resource seed, and inspecting its columns, constraints and indexes; inspect it the
same way, never on a live database or owner identity. These are **local issuer tables**, not
Neon's upstream managed Google-authentication database.

Every vendor table has a required `id text` primary key with no SQL default: the
application generates the configured owner ID for `user` and UUIDs elsewhere, and
the assertion replay guard uses a digest ID. There are no CHECK constraints, so
keys and NOT NULL do not validate OAuth policy or nested JSON.

## Application bridge tables

### `identity.fonds_neon_login`

Ten-minute, single-use state for a signed local OAuth request and the browser that
started the upstream Google round trip. A callback must match both hashes and
unexpired state. Successful consumption deletes the row; starting another login
also cleans expired rows. No background TTL service or expiry index is implied.

The row holds SHA-256 hashes of the random state and of an independent browser
binding cookie, the issuer-signed query that resumes the exact request, and the
allowlisted upstream challenge cookies kept server-side for the round trip. This is
sensitive transient authentication state, not financial collection evidence.

### `identity.fonds_neon_identity`

Durable pinning of the one Fonds owner to the verified upstream issuer/user and
Google account. Initial linking requires the configured verified email; later
logins must match the pinned stable IDs. The email itself is not stored. Matching
email alone cannot relink a changed upstream identity. An explicit administrative
remap is a separate action. Normal Function startup never alters the table.

The DDL for both tables is `bridgeSchema` in
[neon-login.ts](../../deploy/neon/neon-login.ts).

## Better Auth managed tables

| Table                  | Holds                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                 | The local owner, created by setup. Google admission is verified and pinned separately by the bridge.                                                                                                                                                                                                 |
| `session`              | Browser sessions. Logout does not revoke an offline OAuth refresh grant.                                                                                                                                                                                                                             |
| `account`              | Provider account links and the administrative bootstrap credential. An owner-linked Google or GitHub account binds the owner by `accountId`; database hooks null its upstream tokens, expiries and `scope`, and sign-in never refreshes the row. The Neon bridge's Google credentials stay upstream. |
| `verification`         | Purpose-dependent short-lived protocol values: hashed owner login links (magic-link `storeToken: "hashed"`) and passkey ceremony challenges. Not a public document or a financial source archive.                                                                                                    |
| `passkey`              | WebAuthn public keys and authenticator metadata only, never biometrics.                                                                                                                                                                                                                              |
| `rateLimit`            | Rate-limit counters. The window and maximum are application configuration, not SQL CHECKs.                                                                                                                                                                                                           |
| `jwks`                 | Durable issuer signing key pairs. Publishing the public key does not make `privateKey` public; encoding, encryption and rotation belong to the JWT plugin.                                                                                                                                           |
| `oauthClient`          | Client registration and policy. Metadata arrays are JSONB; `jwks` is library-encoded text.                                                                                                                                                                                                           |
| `oauthResource`        | Protected-resource policy; setup seeds the MCP resource. Nullable policy columns inherit provider defaults, and SQL does not interpret their OAuth semantics.                                                                                                                                        |
| `oauthClientResource`  | One row per client and resource. `clientId` is the public client identifier, not `oauthClient.id`; `resourceId` is the resource identifier URL, not `oauthResource.id`.                                                                                                                              |
| `oauthRefreshToken`    | Refresh grants and rotation/replay state. `revoked` is a nullable timestamp. Session deletion sets `sessionId` null, so an offline grant survives browser logout.                                                                                                                                    |
| `oauthAccessToken`     | Opaque access-token records. Resource access JWTs are verified with the signing keys, so not every issued JWT has a row.                                                                                                                                                                             |
| `oauthConsent`         | Owner/client consent, including resources, scopes and requested UserInfo claims; distinct from sessions and refresh grants.                                                                                                                                                                          |
| `oauthClientAssertion` | Single-use `private_key_jwt` replay guard keyed by a digest of the assertion. `expiresAt` marks when a row can be removed; no application job prunes it.                                                                                                                                             |

## SQL versus library defaults

Library insertion defaults are distinct from SQL defaults. The provider schema
declares application-side defaults such as client `disabled=false`,
`clientCredentialsScopes=[]`, `dpopBoundAccessTokens=false`, and resource
`disabled=false`, `dpopBoundAccessTokensRequired=false`, `policyVersion=1`, while
those physical columns are nullable with **no SQL default**. Core user
`emailVerified` and rate-limit `lastRequest` also have library insertion behavior.
Call the pinned library rather than assuming direct inserts with omitted fields are
equivalent. Array columns (`scopes`, `resources`, client redirects and similar) are
library-validated JSONB; `metadata`, `customClaims` and token `confirmation` are
library JSON with no application-owned schema. Do not copy them into financial
records.

There is no application authorization-code table, Google token table, bespoke OAuth
issuer or in-memory financial credential store. A table does not mean its feature
is enabled: client credentials, dynamic registration, DPoP and arbitrary resource
selection are not admitted.

## Authorization and recovery

The issuer is `/api/auth` and the protected resource is the public origin's `/mcp`.
Fonds checks the exact owner, client, resource and operation scopes, not merely the
existence of a row. The [security model](../security-model.md#admission) owns
admitted clients, token lifetime, revocation and a subscriber's grant; the
[hosted-service guide](../guides/hosted-service.md#owner-login-and-authorization)
owns login links, passkeys and rate limits.

Setup uses `getMigrations(auth.options)` and rejects reported schema problems
before running library migrations, then seeds the resource and provisions bridge
tables. It is a privileged explicit setup path, not a public runtime migration
endpoint. Authentication recovery must include this namespace and its private
signing/state material as well as application-owned bridge mappings. Financial
backups alone do not restore hosted authorization or subscription state. A pin
upgrade moves all six packages; schema problems need reviewed conversion,
not dropped `identity` tables.
