# Hosted service

The hosted service is Fonds on PostgreSQL with an OAuth issuer, the REST API and
MCP, refresh, scheduled collection and MCP Events. It is the same code on every
host; a host supplies only its environment and database, and on Neon its native
scheduler. Run it with
[Docker](docker.md) on your own machine or server, or on [Neon](neon-deployment.md).
The local-first SQLite service needs none of this; see [local development](local-development.md).

## Configuration

The PostgreSQL target serves the hosted service when `FONDS_PUBLIC_ORIGIN` is
set; without it, it serves the loopback bearer API. Run `node server.js` from
the `postgres` build target (`npm run build:targets -- postgres`), or the
`fonds:postgres` image.

| Variable                                                                           | Meaning                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FONDS_PUBLIC_ORIGIN`                                                              | The exact public origin clients use, such as `https://fonds.example.com`. Plain `http://` is a development exception for `localhost`, `127.0.0.1` and `[::1]` only.                                                                                                          |
| `FONDS_DATABASE_URL`                                                               | `postgresql://…` with at most one parameter, `sslmode`. A non-loopback host needs `sslmode=require`, `verify-ca` or `verify-full`, unless `FONDS_DATABASE_TLS=disable` states a private network (as in the compose stack).                                                   |
| `FONDS_STATE_DIR`                                                                  | Required: an owned `0700` directory. The first start writes `fonds.env` there with the installation's generated secrets, the only place they come from ([state directory](../database.md#state-directory-and-backup)).                                                       |
| `HOST`, `PORT`                                                                     | The listener; defaults `127.0.0.1` and `8787`. Containers use `0.0.0.0`.                                                                                                                                                                                                     |
| `FONDS_TRUST_PROXY=1`                                                              | Behind a TLS-terminating proxy or tunnel: only a request with the public `Host` and an `X-Forwarded-Proto` of the public scheme is addressed to the public origin; the proxy sets the [client address](#client-addresses). Never set this when clients reach Fonds directly. |
| `FONDS_REFRESH_SCHEDULE`                                                           | Off unless set: `daily` (recommended), `hourly` or hours such as `9,13,18`. See [scheduling](#scheduling).                                                                                                                                                                   |
| `FONDS_REFRESH_TIMEZONE`                                                           | The IANA time zone of the scheduled hours, such as `Asia/Jerusalem`; default `UTC`.                                                                                                                                                                                          |
| `FONDS_REFRESH_TIME`                                                               | `HH:MM`; by default a random time generated once and kept in the database. Set it only to pin the collection time.                                                                                                                                                           |
| `FONDS_CONNECTION_ID`, `FONDS_CONNECTION_PROVIDER`, `FONDS_CONNECTION_CREDENTIALS` | Optional, all or none: one connection whose credentials come from the environment (Neon's configuration). Others use `connect`.                                                                                                                                              |
| `FONDS_GOOGLE_CLIENT_ID`/`_SECRET`, `FONDS_GITHUB_CLIENT_ID`/`_SECRET`             | Optional owner-linked sign-in providers, each a complete pair.                                                                                                                                                                                                               |

The generated secrets in `fonds.env` include `FONDS_SCHEDULE_SECRET` (an external
scheduler's bearer) and `FONDS_REFRESH_SECRET` (the operator collection
endpoint, and what enables collection). The first start binds the database to
them, and Fonds then refuses it with any other secrets
([state directory and binding](../database.md#state-directory-and-backup)), so
back up the state directory with the database. On Neon the private env file is
the state.

The database must be a direct or session-mode connection: financial writes take
row locks and transaction-scoped advisory locks inside interactive transactions.
Transaction poolers (PgBouncer in transaction mode, Neon's `-pooler` endpoints)
break them; Fonds rejects `-pooler.` URLs.

On `SIGTERM` or `SIGINT` the service interrupts running refreshes, which keep the
captures they already fetched and resume on the next start, and gives accepted
requests five seconds before closing their connections
([node-service.ts](../../src/runtime/node-service.ts)).

### Client addresses

Better Auth rate-limits each client address on each `/api/auth` route (30
requests a minute by default, stricter on some sign-in routes). Fonds decides
that address where the request enters and gives Better Auth nothing else;
client-supplied forwarding headers never set it:

- **Directly**, without `FONDS_TRUST_PROXY`, it is the connection's peer.
  `X-Forwarded-For`, `X-Real-IP`, `Forwarded` and similar headers are ignored.
- **Behind `FONDS_TRUST_PROXY=N` proxies** (1 to 9; almost always 1), it is the
  Nth `X-Forwarded-For` entry from the right: the address the outermost proxy
  appended; entries further left are whatever the client sent. A missing or malformed entry (it must be a bare IPv4 or IPv6
  address) falls back to the connection's peer, so those requests share the
  proxy's limit. Each proxy must append the address it received the request
  from (nginx: `$proxy_add_x_forwarded_for`), and Fonds must be reachable only
  through them: a client that reaches Fonds, or an inner proxy, directly can
  choose its address.
- **On Neon**, it is the right-most `X-Forwarded-For` entry, or none if that is
  missing or not a bare IP address. Whether Neon's ingress sets it is
  [unverified](../security-model.md#known-limitations): confirm it on a real
  deployment, with the owner's authorization, before relying on the limit.

## Owner login and authorization

The sole owner signs in with a **passkey**, and on Neon also with Google
through the managed Neon Auth bridge. Owner-linked Google or GitHub sign-in is
optional on any host. The [security model](../security-model.md#admission) owns
who and which clients are admitted.

A one-time **login link** is how the owner enrolls the first passkey and
recovers access. It is generated where the deployment lives, never sent:

```sh
node server.js login-link                                 # any host, same environment
docker compose exec fonds node /app/server.js login-link  # the compose stack
npm run neon:setup -- login-link …                        # Neon, from the operator's laptop
```

The link expires in ten minutes and works once; only its hash is stored. It
appears only in that terminal: never paste it into chat, logs or tickets. Open
it in the browser you will use, then add a passkey on the account page
(`/account`). To connect ChatGPT after a login link, start the connection from
ChatGPT in the same browser: the link signs you in but does not resume a
pending authorization.

Passkeys require user verification (biometric or PIN) and are bound to the
public origin's hostname, so a changed domain needs new passkeys. Synced
passkeys (iCloud Keychain, Google Password Manager, a password manager) and
phone-assisted sign-in cover other machines; add more than one passkey.

Health requires `financial:read`; local static bearer credentials are not
accepted by the hosted service. Discovery and login/consent remain public. The
challenge and `/.well-known/oauth-protected-resource/mcp` advertise
`openid profile offline_access financial:read financial:write` so clients can
request refresh. ChatGPT signs its own `private_key_jwt` assertion, so no
owner-supplied client secret is needed. Token lifetime and what revoking a grant
stops are in the [security model](../security-model.md#revocation).

## Adding providers

Create a connection, then store its credentials encrypted with hidden input:

```sh
node server.js init --connection cal-main --provider cal
node server.js connect --connection cal-main
```

`connect` prompts for the provider's fields (see the [provider guides](../README.md#providers)),
or reads them from `--credentials-fd`, and stores them encrypted with
the state directory's `FONDS_CREDENTIALS_KEY`. Credentials never pass through
MCP, model context or logs. The next scheduled run collects the new connection.
On Neon, `--env-file` supplies the private env file instead
([Neon runbook](neon-deployment.md#add-a-stored-connection)).

## Collection, refresh and scheduling

Owner/model requests, schedules, operator retries and CLI `collect` create recorded
[refreshes](../api.md#refreshes). The
[design](../design.md#collection-and-evidence) defines rereads and commits. Each
refresh first recovers unfinished ingestion. Each start resolves targets from the
env-configured connection and stored credentials; unscoped starts, schedules and
operator retries cover all targets.
Refreshes run serially under each connection's
[collection lease](../../src/application/collection-lock.ts), across processes;
each month or recent window is bounded at ten minutes.

`fonds_sync` emits refresh/capture IDs, stage/reason codes, counts, durations and
failure categories. `observed` counts accepted identities per capture;
`extracted` counts parser inputs. Logs exclude source values, credentials and
private provider identifiers. For a bounded report or temporary raw archives, use
the [operator CLI](local-development.md#operator-commands).

The [API reference](../api.md#operations) lists the refresh tools and routes and
their grants. The SQLite server and the PostgreSQL loopback launcher offer the
same refreshes and Events behind their bearer token. Starting any launcher never
collects by itself, apart from resuming refreshes a stopped process left active.
A lost or expired client request is not proof the provider work did not run;
list the connection's refreshes before retrying.

Authentication failure or challenge marks the refresh `requiresAttention` and
blocks ordinary and scheduled refreshes until an operator retry succeeds. After
resolving it, POST `{}` to `/internal/collect/recent` on the public origin with
`Authorization: Bearer <FONDS_REFRESH_SECRET>`, or run
`node server.js collect --connection …`. The route refreshes every target past
the block and the cooldown, really calling each provider; the Neon runbook wraps
it as `neon:smoke --collect`. An `implausible_empty` rejection
([design](../design.md#identity-corrections-and-absence)) is logged in
`fonds_refresh` but sets no attention block: the cooldown still applies, and
scheduled collection can retry. The [provider guides](../README.md#providers)
say which adapters apply it.

### Scheduling

Scheduled collection is off until the operator turns it on with
`FONDS_REFRESH_SCHEDULE`:

| Value                    | Collects                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `daily` (recommended)    | Once a day at the installation's `FONDS_REFRESH_TIME`                                    |
| `hourly`                 | Every hour, at that time's minute                                                        |
| Hours, such as `9,13,18` | At each listed hour (0–23), at that minute: for example a few times during working hours |
| Absent or anything else  | Nothing; scheduled collection is off                                                     |

`FONDS_REFRESH_TIME` (`HH:MM`) is generated once per installation, with a
random hour and minute, and then kept: the Node host stores it in the database
on its first start, so every restart and replica shares it, and Neon's setup
writes it into its private env file. Installations therefore do not all reach a
provider at the same minute, which a provider can read as automation and flag.
Set it yourself only to pin the time. Hourly schedules and hour lists use only
its minute. The hours and the daily time are wall-clock times in
`FONDS_REFRESH_TIMEZONE`. On the day a daylight-saving change skips that
time, the run comes later by the length of the gap; a time the change repeats
runs once, at its first instant. A list of hours outside 0–23, an invalid time
or an unknown time zone stops the service from starting, with a message that
names the variable.

**On the Node host** (Docker, or `node server.js`) the service schedules itself,
as the SQLite server and the PostgreSQL loopback launcher also do
([collection-schedule.ts](../../src/runtime/collection-schedule.ts)). Each
occurrence starts a random zero to three minutes after its time and
[runs once](../database.md#scheduled-collections-and-settings-tables) across
restarts, replicas and the trigger endpoint below, though replicas with skewed
clocks can each run an adjacent occurrence. Missed occurrences never catch up in
a burst: after downtime, a suspend or a clock change only the latest runs, until
the next one is due, and the gap is recorded as a `missed`
[refresh](../api.md#refreshes) per target. A restart before the next occurrence
retakes a run that shutdown interrupted.

**An external scheduler** (cron, Cloud Scheduler, EventBridge) POSTs `{}` to
`/internal/triggers/recent` on the public origin with
`Authorization: Bearer <FONDS_SCHEDULE_SECRET>`; every call also resumes
refreshes a stopped process left active. Without `FONDS_REFRESH_SCHEDULE`,
retries of one occurrence that send the same `Idempotency-Key` header reuse its
refreshes; without the header each call is new. With the schedule set, the
header is not used: a call runs the latest due occurrence if nothing has claimed
it yet, and otherwise answers `{refreshes: []}`, so the endpoint and the
embedded schedule never collect twice in one occurrence. Neon uses its
[native trigger](neon-deployment.md#native-scheduled-collection) instead.

## MCP Events and webhook delivery

The hosted service advertises draft MCP Events; the
[API reference](../api.md#mcp-and-events) owns the subscription protocol, the
callback signing and the `changes.available` payload.

Delivery troubleshooting:

- **Acknowledgement.** Any 2xx acknowledges and advances the delivery cursor,
  not the consumer's checkpoint, even if the delivery budget ends during that
  request; the response body is discarded.
- **Retries.** Network failures, 408, 429, 5xx and statuses outside 200–599 retry
  with exponential backoff from one minute to one hour; 24 attempts (about 18
  hours of receiver downtime) exhaust the subscription. Redirects and other
  3xx/4xx, including 410 and 413, stop it at once. Unsubscribe marks it inactive.
- **Timing.** Due delivery runs for up to 30 seconds after every scheduled or
  operator run, even one with nothing to collect. The Node host also runs a pass
  about once a minute, with or without a schedule; there is no separate
  delivery process. On Neon delivery runs only with the native trigger and
  owner refreshes: with a daily schedule a failed delivery retries the next day
  and an API change waits for the next run, so choose hourly or a list of hours
  if a subscriber relies on timely Events.
- **Contract.** Historical `transaction.created` subscriptions are not converted
  or compatible. Delivery has synthetic verification only; accept it against
  the real host on each deployment.
