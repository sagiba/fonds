# Docker

Two images come from the repository's `Dockerfile`. Each installs only its
target's deploy manifest, so an image carries one database driver.

| Image             | Build                                                | Runs                                                                                                    |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fonds` (default) | `docker build -t fonds .`                            | The local-first SQLite CLI; `fonds serve` for MCP over stdio or loopback HTTP                           |
| `fonds:postgres`  | `docker build --target postgres -t fonds:postgres .` | The [hosted service](hosted-service.md), and the [operator CLI](local-development.md#operator-commands) |

Both run as the image's non-root `node` user (uid 1000) with data in `/data`.
`scripts/docker-smoke.sh` builds both and checks them with synthetic state.

## The SQLite image

The image sets `FONDS_HOME=/data`, so without `--db` the ledger is
`/data/fonds.sqlite`, with its [state](../database.md#state-directory-and-backup)
in `/data/fonds.env`. Fonds requires the directory `0700` and the files `0600`,
owned by the user it runs as; a named volume satisfies that:

```sh
docker volume create fonds-data
docker run --rm -v fonds-data:/data fonds init --connection cal-main --provider cal
docker run --rm -it -v fonds-data:/data fonds connect --connection cal-main
docker run --rm -it -v fonds-data:/data fonds collect --connection cal-main
```

`connect` and `collect` prompt with hidden input, so they need `-it`. For a host
directory instead, run as your own user so the ownership checks pass:
`--user "$(id -u):$(id -g)" -v "$HOME/fonds-data:/data"`, with
`chmod 700 "$HOME/fonds-data"`.

An MCP client can start the image over stdio, with no network and no token:

```sh
claude mcp add fonds -- docker run -i --rm -v fonds-data:/data fonds \
  serve --transport stdio
```

The SQLite HTTP server binds only `127.0.0.1` inside the container, so a
published port cannot reach it; for loopback HTTP, run Node from a
[checkout](local-development.md).

## The hosted stack

`compose.yaml` runs PostgreSQL 18 on a private network and the hosted service:

```sh
docker compose up -d --build
```

The first start creates the schemas, the owner and the generated secrets in the
`state` volume (`/data/fonds.env`), then serves on `http://localhost:8787`,
published only on `127.0.0.1`. The database password defaults to a local-only
value; set `FONDS_POSTGRES_PASSWORD` in a `.env` file beside `compose.yaml`
before the first start to choose your own. Use only letters, digits and `-._~`:
compose places it in the database URL as is. `FONDS_PORT` changes the published
port; set `FONDS_PUBLIC_ORIGIN` to match.

Print a [login link](hosted-service.md#owner-login-and-authorization), open it
and add a passkey on the account page, then add providers; `connect` prompts for
the credentials with hidden input:

```sh
docker compose exec fonds node /app/server.js login-link
docker compose exec fonds node /app/server.js init --connection cal-main --provider cal
docker compose exec fonds node /app/server.js connect --connection cal-main
```

Nothing is collected until you choose a [schedule](hosted-service.md#scheduling).
Add it to the `.env` file and recreate the service:

```sh
echo FONDS_COLLECTION_SCHEDULE=daily >> .env
docker compose up -d
```

`.env` also takes `FONDS_COLLECTION_TIMEZONE`; to pin `FONDS_COLLECTION_TIME`, set
it under the `fonds` service's `environment` in `compose.override.yaml`. The
service runs the schedule itself, with no scheduler container, and logs each run
as `fonds_scheduled_collection` (`docker compose logs fonds`). Operation commands
such as `docker compose exec fonds node /app/server.js list-connections` use the
same database.

### Backup, restore and upgrades

Back up the `postgres` and `state` volumes together: the database is
[bound to](../database.md#state-directory-and-backup) the secrets in the state
volume and refuses to start with any other. Stop the stack for a consistent copy,
or use `pg_dump` inside the `postgres` container plus a copy of `/data/fonds.env`.

To upgrade, pull the new revision and run `docker compose up -d --build`; the next
start applies its [migrations](../database.md#migrations).

## Quick tunnel

A Cloudflare quick tunnel gives a temporary public URL, such as for trying
ChatGPT against a local stack, with no account:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Put the printed `https://…trycloudflare.com` URL and proxy trust in
`compose.override.yaml` (Git ignores it; Compose loads it), then run
`docker compose up -d`:

```yaml
services:
  fonds:
    environment:
      FONDS_PUBLIC_ORIGIN: https://example.trycloudflare.com
      FONDS_TRUST_PROXY: "1"
```

`FONDS_TRUST_PROXY` takes the public scheme and the
[client address](hosted-service.md#client-addresses) that auth rate limits use
from the tunnel's forwarded headers; never set it when clients reach Fonds
directly. Whether a Cloudflare tunnel delivers the visitor's address as the last
`X-Forwarded-For` entry is unverified. Limits:

- The URL changes whenever the tunnel restarts. The public origin is part of
  every OAuth grant, so reconnect ChatGPT and other clients after a change.
- Passkeys are bound to the hostname, so a new URL needs a new `login-link`
  sign-in.
- Quick tunnels do not support server-sent events; Fonds answers MCP with JSON,
  so this does not affect it.

For anything lasting, use a named tunnel or a TLS proxy with a stable hostname.
