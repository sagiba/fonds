# Install Fonds and connect a local assistant

Install Fonds, try synthetic data, then connect ChatGPT desktop or Claude to
your local SQLite ledger. No provider credentials are needed for the demo;
refresh is opt-in.

## Install and try the demo

Use Node.js 24.11 or newer (`node --version`). The commands below use a POSIX
shell on macOS or Linux; native Windows setup is unverified. Install the published package:

```sh
npm install --global fonds-finance
fonds --version
fonds demo
```

The package `fonds-finance` installs `fonds`. Repeat the install command to
update. If `fonds` is missing, add npm's global `bin` directory to `PATH`.

Alternatively, from source:

```sh
git clone https://github.com/sagiba/fonds.git
cd fonds
npm ci
npm run build
node dist/cli.js demo
```

For the remaining examples, replace `fonds <command>` with
`node dist/cli.js <command>`, except `fonds serve`, which is
`node dist/server.js`. The checkout is a development package, so `npm link`
does not install the `fonds` command. Keep the checkout and rerun the build after
pulling updates. Both installation paths print the same client setup.

`demo` creates `demo.sqlite` with invented CAL transactions, separately from
your default `fonds.sqlite`. Rerunning it does not reset annotations. Databases
live in `$FONDS_HOME`, otherwise `~/.local/share/fonds` on Linux or
`~/Library/Application Support/Fonds` on macOS. Fonds creates its data directory
as `0700`; use `--db` for another database outside the checkout.

## Connect an MCP client locally

`fonds demo` prints setup for its sample ledger. For an initialized real ledger:

```sh
fonds mcp-config
```

Add `--db /absolute/private/path.sqlite` for a different ledger. This prints
snippets; it does not install a client or modify its settings. The generated
configuration pins Node, the server, database and state directory to absolute
paths, so GUI apps need not inherit your shell's `PATH`, `FONDS_HOME` or
`FONDS_STATE_DIR`. No credentials or tokens appear in it.
For multiple ledgers in one client, give each a different server name: change
`fonds` in the printed add command or JSON key. Connection IDs inside a ledger
do not need separate MCP registrations.

- **ChatGPT desktop:** in Settings → MCP servers → Add server, choose STDIO.
  Enter the generated JSON's `command`, `args` and `env` values, then save and
  restart. Alternatively, with Codex CLI installed on the same local host,
  run the printed `codex mcp add` command. They share
  [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
- **Claude Code:** run the printed `claude mcp add` command from the project
  where you will use it. It explicitly uses private local scope; change to
  `--scope user` to make it available across your projects
  ([scopes](https://code.claude.com/docs/en/mcp#local-scope)).
- **Claude Desktop:** open Settings → Developer → Edit Config, merge the
  printed `mcpServers` entry with existing entries, then fully quit and restart
  ([client instructions](https://modelcontextprotocol.io/docs/develop/connect-local-servers)).

Check `/mcp` or the client's MCP settings, then ask it to call `list_connections`.
For the demo, expect connection `demo`; ask for its totals by currency next.
The client starts and stops Fonds over stdio. You do not start an HTTP server
or supply an HTTP token. A trusted local client can read, annotate and request
refreshes across the ledger's connections; installing it does not refresh data.

For a failed connection, run the generated Node command manually with its
`FONDS_STATE_DIR` environment setting; it waits silently for MCP input on
success. Check the client's MCP logs for startup errors. Keep the state directory
with the database. After moving the installation or changing Node versions,
rerun `mcp-config` and replace the client entry. Remove `fonds-demo` in the
client's MCP settings when finished. **ChatGPT web** uses the
[hosted connection guide](chatgpt-connect.md), not these local settings.

## Add provider logins

Read [Your data stays yours](../../README.md#your-data-stays-yours) and the
provider guide ([CAL](../providers/cal.md), [Isracard](../providers/isracard.md))
before collecting. A connection represents one provider login, not one card or
billing account. Multiple logins, including the same provider, share one ledger:

```sh
fonds init
fonds connect cal
fonds connect isracard
fonds connect cal --name cal-other
fonds list-connections
fonds refresh
fonds mcp-config
```

`init` creates storage only and is safe to repeat. `connect` requires it first;
its default connection ID is the provider, and `--name` chooses another ID.
Use only accounts you own. `connect` prompts privately
for each login's fields and saves credentials for that connection; it does not
validate the login with the provider. `refresh`
without `--connection` refreshes all connections with saved credentials;
`fonds refresh --connection isracard` targets one. Cards and billing accounts
are discovered within each connection. Avoid overlapping card access, even
through different logins: connections remain separate, so ledger-wide totals
count overlapping records twice. Use `fonds totals --connection-id ID` to scope
totals to one login.
One MCP registration exposes all connections, including ones added later.
`fonds list --connection cal` filters CLI results to one connection.
Existing names are refused. To replace saved credentials, use
`fonds connect --connection ID`; then `fonds refresh --connection ID` verifies
the login. For offline archives, `fonds connect cal --name imported --offline`
adds a connection without credentials, ready for `ingest`.

## Local HTTP (optional)

```sh
fonds serve --db <the demo database demo printed>
```

HTTP listens at `http://127.0.0.1:8787`; MCP is `http://127.0.0.1:8787/mcp`.
`--port` selects another port; `--port 0` selects an available one and prints
its actual URL. Stop with Ctrl-C. Every endpoint except the
[API description](../api.md#operations), including `/health`, requires
`Authorization: Bearer <token>`: `FONDS_API_TOKEN` in the
[state directory](../database.md#state-directory-and-backup)'s `fonds.env`,
whose path the server prints (never the token). Back it up with the database.
The database, its journal files and `fonds.env` must be private, current-owner
regular files in private directories outside this repository; symlinks and hard
links are refused, and Fonds never changes existing permissions. The local
launcher has no public OAuth mode; use the [hosted service](hosted-service.md)
for remote OAuth access.

For CLI access, set `FONDS_STATE_FILE` to that printed path, then use the
private token-file example below.

The [API reference](../api.md) owns routes, filters, cursors and the
[version-guarded annotation update](../api.md#annotations).

## Use the command line

The CLI runs the [operations](../api.md#operations) as kebab-case commands and
flags. `list`, `get`, `totals`, `events`, `annotate`, `link` and `remove` are
short aliases; `<command> --help` prints one operation's description and flags.
`--connection` also works as an alias for operation commands’ `--connection-id`.
Set `DEMO_DB` to the path `demo` printed, or drop `--db` to use your default
ledger:

```sh
fonds list --db "$DEMO_DB" --connection-id demo --limit 5
fonds get --db "$DEMO_DB" --transaction-id TRANSACTION_ID
fonds annotate --db "$DEMO_DB" \
  --transaction-id TRANSACTION_ID --expected-version 0 --notes "Synthetic note" --tags '["demo"]'
```

Output is indented JSON in a terminal and one compact JSON line, the API's wire
format, when piped or redirected. Booleans take `true` or `false`, integers are decimal, list
and object fields take JSON, and an empty value clears a nullable text field.
Input is validated before the database opens.

`--remote <url>` sends the same commands to a running service's `/v1` API: an
`https://` origin, or `http://` on this machine. The bearer comes only from the
required `--token-file <private 0600 file>`, never from an argument or the
environment, and redirects are refused. For the local server, copy its token
into a private file once:

```sh
(umask 077; grep '^FONDS_API_TOKEN=' "$FONDS_STATE_FILE" | cut -d= -f2- > ~/.fonds-token)
fonds list-connections --remote http://127.0.0.1:8787 --token-file ~/.fonds-token
```

Remote mode against an OAuth deployment needs a CLI login, which is not built yet.

### Operator commands

Every Node backend runs one operator CLI with the same commands, flags, output and
exit codes: `fonds <command>`, from the npm package or the
[Docker image](docker.md). A `postgresql://` `FONDS_DATABASE_URL` selects
PostgreSQL; otherwise SQLite uses `--db` or the default ledger.

| Command      | Does                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| `init`       | Initializes storage and private state; adds no provider logins                             |
| `connect`    | Adds a provider login, or updates credentials with `--connection <id>`                     |
| `disconnect` | Removes stored credentials; later refreshes skip it; the ledger stays                      |
| `refresh`    | Refreshes now; without `--connection`, every connection with stored credentials, in turn   |
| `consume`    | Delivers the event feed to stdout as JSON lines and advances a consumer cursor             |
| `ingest`     | Archives and applies one captured provider response offline                                |
| `backup`     | SQLite: a coherent copy of the ledger; on PostgreSQL use `pg_dump` and the state directory |
| `login-link` | PostgreSQL: a one-time owner sign-in link for the hosted service                           |
| `mcp-config` | SQLite: prints setup for a local MCP client without changing client settings               |
| `demo`       | SQLite: a separate ledger of synthetic CAL data                                            |

Unavailable commands exit 3; otherwise 0 means success, 1 failure or `busy`, 2 partial
refresh. `refresh` calls the provider and prints a
`refresh_summary` of status and summed [counts](../api.md#refreshes);
`list-refreshes` keeps individual results. Without dates it rereads recent data;
`--from`/`--to` request backfill. `--credentials-fd`, `--history-mode`,
`--search-window-months` and `--call-budget` need `--connection`. Without stored
credentials it prompts secretly or reads the private descriptor; provider guides
list the fields.

`refresh --diagnostics` adds at most 200 structured stage/count entries, with
`truncated` and `dropped` indicating omitted entries. It contains no financial
values, provider fields or credentials. `--archive-days <days>` (1–30) opts into
temporary raw-response retention in the database, subject to provider redactions;
by default completed ingestion releases bodies. See
[evidence retention](../database.md#what-the-financial-tables-hold). These are operator flags,
not API or MCP inputs.

## Refresh and Events on the server

The server offers [refreshes](../api.md#refreshes) on HTTP and stdio, and
[scheduling](hosted-service.md#scheduling), as the
[hosted service](hosted-service.md#refresh-and-scheduling) does. Only
connections with credentials `connect` stored refresh (read at each refresh, so
`connect` needs no restart); others answer `not_found`. An authentication block
clears only when an operator `refresh` succeeds. Refreshing calls the provider,
so give the token, or a stdio host, only to a client you trust to do that;
provider credentials and the token stay outside tool inputs and results.

Over HTTP the server also serves
[MCP Events](hosted-service.md#mcp-events-and-webhook-delivery) webhooks; the
[security model](../security-model.md#revocation) says how long a subscription
outlives a replaced token. Stdio offers no Events, since a stdio host has no
webhook identity, but a stdio server still delivers subscriptions made over
HTTP. Structured operational metadata goes to stderr.

## Other runtimes

For the PostgreSQL and Turso loopback bearer launchers, see
[storage backends](storage-backends.md). The PostgreSQL launcher offers refresh,
Events and scheduling in the same way; experimental Turso offers none of them.
