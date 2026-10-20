# Run the local HTTP and MCP service

Run the SQLite service locally, query it over loopback bearer HTTP, or connect a
trusted local MCP client over stdio; both serve the same
[operations](../api.md#operations) from `dist/server.js`. Synthetic development
needs no provider credentials, and collection is opt-in. Hosted setup is in the
[hosted-service guide](hosted-service.md).

## Start with synthetic data

Use Node 24.11 or newer. From the repository root, install and build, then create
the synthetic demo ledger and serve it over HTTP:

```sh
npm ci && npm run build
node dist/cli.js demo
node dist/server.js --db <the demo database demo printed>
```

`demo` creates `demo.sqlite` in the private data directory (`$FONDS_HOME`, otherwise
`~/.local/share/fonds` on Linux or `~/Library/Application Support/Fonds` on macOS,
created `0700`) and replays the committed synthetic CAL captures; running it again
changes nothing. Without `--db`, the CLI and the server use `fonds.sqlite` in the same
directory, which is where your own data goes. Pass `--db` to use any other private
database outside the repository.

HTTP listens at `http://127.0.0.1:8787`; MCP is `http://127.0.0.1:8787/mcp`.
`--port` selects another port; `--port 0` selects an available one and prints
its actual URL. Stop with Ctrl-C. Every endpoint, including `/health`, requires
`Authorization: Bearer <token>`: `FONDS_API_TOKEN` in the
[state directory](../database.md#state-directory-and-backup)'s `fonds.env`,
whose path the server prints (never the token). Back it up with the database.
The database, its journal files and `fonds.env` must be private, current-owner
regular files in private directories outside this repository; symlinks and hard
links are refused, and Fonds never changes existing permissions. The local
launcher has no public OAuth mode; use the [hosted service](hosted-service.md)
for remote OAuth access.

To query without placing the token in a command argument, use another terminal
and set `FONDS_STATE_FILE` to the `fonds.env` path printed at startup:

```sh
node --input-type=module - "$FONDS_STATE_FILE" <<'JS'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const token = parseEnv(readFileSync(process.argv[2], 'utf8')).FONDS_API_TOKEN;
const response = await fetch('http://127.0.0.1:8787/v1/transactions?connectionId=demo&limit=10', {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
JS
```

The [API reference](../api.md) owns routes, filters, cursors and the
[version-guarded annotation update](../api.md#annotations).

## Use the command line

The CLI runs the [operations](../api.md#operations) as kebab-case commands and
flags. `list`, `get`, `totals`, `events`, `annotate`, `link` and `remove` are
short aliases; `<command> --help` prints one operation's description and flags.
Set `DEMO_DB` to the path `demo` printed, or drop `--db` to use your default
ledger:

```sh
node dist/cli.js list --db "$DEMO_DB" --connection-id demo --limit 5
node dist/cli.js get --db "$DEMO_DB" --transaction-id TRANSACTION_ID
node dist/cli.js annotate --db "$DEMO_DB" \
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
node dist/cli.js list-connections --remote http://127.0.0.1:8787 --token-file ~/.fonds-token
```

Remote mode against an OAuth deployment needs a CLI login, which is not built yet.

### Operator commands

Every Node backend runs one operator CLI with the same commands, flags, output and
exit codes: `node dist/cli.js <command>` on SQLite (`fonds <command>` in the Docker
image), and `node server.js <command>` from the PostgreSQL target, which needs
`FONDS_DATABASE_URL` set to a `postgresql://` URL; the SQLite CLI refuses one and
uses `--db` or the default ledger.

| Command      | Does                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `init`       | Creates the database if needed, binds it to the state directory, and adds a connection        |
| `connect`    | Stores a connection's provider credentials encrypted, from hidden input or `--credentials-fd` |
| `collect`    | Collects now; without `--connection`, every connection with stored credentials, in turn       |
| `consume`    | Delivers the event feed to stdout as JSON lines and advances a consumer cursor                |
| `ingest`     | Archives and applies one captured provider response offline                                   |
| `backup`     | SQLite: a coherent copy of the ledger; on PostgreSQL use `pg_dump` and the state directory    |
| `login-link` | PostgreSQL: a one-time owner sign-in link for the hosted service                              |
| `demo`       | SQLite: a separate ledger of synthetic CAL data                                               |

Exit codes: 0 success, 1 failure or `busy` (such as `collect` while the server
refreshes the same connection), 2 partial collection, and 3 for a command this
backend lacks, named in one line. `collect` calls the provider through a
[refresh](../api.md#refreshes), like the server, and prints one
`collection_summary` with the status and summed counts; `list-refreshes` keeps
each result. Without dates it rereads the recent window; `--from`/`--to` request
a backfill for every collected connection. `--credentials-fd`, `--history-mode`,
`--search-window-months` and `--call-budget` need `--connection`. Without stored
credentials, `collect` asks with hidden input or reads a private file descriptor;
the [CAL](../providers/cal.md) and [Isracard](../providers/isracard.md) guides
list the fields. The server keeps serving while collection commits: for a synthetic
correction, `ingest` `tests/providers/cal/fixtures/recent-02.json` with a new
run ID and capture timestamp from another terminal, and new reads observe it.

## Connect an MCP client locally

For a host supporting stdio MCP, configure a command with absolute paths after
`npm run build`. `demo` prints ready-made versions for its ledger. For your own
default ledger, after `node dist/cli.js init` has created it, run this from the
repository root for Claude Code:

```sh
claude mcp add fonds -- node "$PWD/dist/server.js" --transport stdio
```

Other hosts take the same command as JSON, for example Claude Desktop's
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fonds": {
      "command": "node",
      "args": ["/absolute/path/to/fonds/dist/server.js", "--transport", "stdio"]
    }
  }
}
```

Without `--db` the server uses your default ledger; add
`"--db", "/absolute/private/path.sqlite"` for another one. Stdio needs no HTTP
token, and stdout carries only protocol messages. HTTP MCP clients can instead
use `/mcp` with the bearer header from private client configuration.
[MCP behavior](../api.md#mcp-and-events) is in the API reference.

## Refresh and Events on the server

The server offers [refreshes](../api.md#refreshes) on HTTP and stdio, and
[scheduling](hosted-service.md#scheduling), as the
[hosted service](hosted-service.md#collection-refresh-and-scheduling) does. Only
connections with credentials `connect` stored refresh (read at each refresh, so
`connect` needs no restart); others answer `not_found`. An authentication block
clears only when an operator `collect` succeeds. Refreshing calls the provider,
so give the token, or a stdio host, only to a client you trust to do that;
provider credentials and the token stay outside tool inputs and results.

Over HTTP the server also serves
[MCP Events](hosted-service.md#mcp-events-and-webhook-delivery) webhooks; the
[security model](../security-model.md#revocation) says how long a subscription
outlives a replaced token. Stdio offers no Events, since a stdio host has no
webhook identity, but a stdio server still delivers subscriptions made over
HTTP. Operational events (counts only) go to stderr.

## Other runtimes

For the PostgreSQL and Turso loopback bearer launchers, see
[storage backends](storage-backends.md). The PostgreSQL launcher offers refresh,
Events and scheduling in the same way; experimental Turso offers none of them.
