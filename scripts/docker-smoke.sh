#!/usr/bin/env bash
# Builds and smoke-tests the image, on SQLite and as the hosted compose stack,
# with synthetic state only. CI runs it with FONDS_SMOKE_SKIP_BUILD=1 after
# building the image with its cache.
# Hosted checks run inside the container against localhost:8787, so they work
# wherever Docker publishes ports, and generated secrets never leave it.
set -euo pipefail
cd "$(dirname "$0")/.."

# A unique project and only compose.yaml: a developer's compose.override.yaml
# or environment never reaches the smoke stack, and concurrent runs stay apart.
project="fonds-smoke-$$"
export FONDS_PORT="${FONDS_SMOKE_PORT:-18787}"
export FONDS_POSTGRES_PASSWORD=synthetic-smoke-only
export FONDS_PUBLIC_ORIGIN=http://localhost:8787
compose() { docker compose -p "$project" -f compose.yaml "$@"; }
# The same stack with the embedded schedule turned on.
override="$(mktemp)"
scheduled() { docker compose -p "$project" -f compose.yaml -f "$override" "$@"; }
in_fonds() { compose exec -T fonds node --input-type=module -e "$1"; }
fail() {
  echo "smoke: $1" >&2
  exit 1
}
cleanup() {
  docker rm -f "$project-mcp" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm -f "$project-sqlite" >/dev/null 2>&1 || true
  rm -f "$override"
}
trap cleanup EXIT

if [ "${FONDS_SMOKE_SKIP_BUILD:-}" != 1 ]; then
  docker build -t fonds .
fi

echo "== sqlite"
docker run --rm fonds --help | grep -q "local SQLite CLI" || fail "sqlite --help"
version="$(node -p 'require("./package.json").version')"
[ "$(docker run --rm fonds --version)" = "$version" ] || fail "--version"
docker run --rm fonds demo | grep -q "Demo ledger ready" || fail "demo"
docker volume create "$project-sqlite" >/dev/null
# No --db: FONDS_HOME=/data puts the default ledger in the volume, so a second
# container finds it.
docker run --rm -v "$project-sqlite:/data" fonds \
  init --connection smoke --provider cal >/dev/null
# One request at a time: the server shuts down at end of input.
coproc MCP { docker run -i --rm --name "$project-mcp" -v "$project-sqlite:/data" fonds \
  serve --transport stdio; }
# Reads until the response with this id, into $reply. Not in a pipeline:
# coprocess descriptors are not available in subshells.
response() {
  while IFS= read -r -t 60 reply <&"${MCP[0]}"; do
    [[ "$reply" == *"\"id\":$1"[,}]* ]] && return 0
  done
  return 1
}
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' >&"${MCP[1]}"
response 1 || fail "sqlite stdio initialize"
printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' >&"${MCP[1]}"
response 2 && [[ "$reply" == *'"name":"list_transactions"'* ]] ||
  fail "sqlite stdio tools/list"
eval "exec ${MCP[1]}>&-"
wait "$MCP_PID" || true

echo "== hosted compose"
compose up -d --no-build --wait fonds
metadata='
const response = await fetch("http://localhost:8787/.well-known/oauth-protected-resource/mcp");
const body = await response.json();
if (response.status !== 200 || body.resource !== "http://localhost:8787/mcp") process.exit(1);'
in_fonds "$metadata" || fail "protected-resource metadata"

link="$(compose exec -T fonds fonds login-link)"
[[ "$link" == http://localhost:8787/* ]] || fail "login-link"

in_fonds '
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const { FONDS_REFRESH_SECRET: secret } = parseEnv(readFileSync("/data/fonds.env", "utf8"));
const response = await fetch("http://localhost:8787/internal/refresh/recent", {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  body: "{}",
});
const result = await response.json();
// One refresh per target; with no targets there is none.
if (response.status !== 200 || !Array.isArray(result.refreshes) || result.refreshes.length !== 0) process.exit(1);' ||
  fail "operator refresh with no connections"

trigger='
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const state = parseEnv(readFileSync("/data/fonds.env", "utf8"));
const response = await fetch("http://localhost:8787/internal/triggers/recent", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${state.FONDS_SCHEDULE_SECRET}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "smoke-trigger",
  },
  body: "{}",
});
const [status, count] = EXPECTED;
const { refreshes } = await response.json();
if (response.status !== status || !Array.isArray(refreshes) || refreshes.length !== count) process.exit(1);'
# The trigger's expected HTTP status and number of refreshes, such as [200, 0].
trigger_expects() { in_fonds "${trigger//EXPECTED/$1}"; }
runs() { "$1" logs fonds 2>/dev/null | grep -c '"event":"fonds_scheduled_refresh"' || true; }

echo "== schedule off by default"
trigger_expects '[200, 0]' || fail "external trigger"
[ "$(runs compose)" = 0 ] || fail "refresh without FONDS_REFRESH_SCHEDULE"

echo "== embedded schedule"
# Hourly at a minute already past its start jitter, so the first tick runs it.
minute=$(( (10#$(date -u +%M) + 55) % 60 ))
cat >"$override" <<YAML
services:
  fonds:
    environment:
      FONDS_REFRESH_SCHEDULE: hourly
      FONDS_REFRESH_TIME: "00:$(printf %02d "$minute")"
YAML
scheduled up -d --no-build --wait fonds
for _ in $(seq 1 30); do
  [ "$(runs scheduled)" = 1 ] && break
  sleep 2
done
[ "$(runs scheduled)" = 1 ] || fail "embedded scheduled refresh"
# The trigger and a restart find the occurrence recorded and never rerun it.
trigger_expects '[200, 0]' || fail "trigger with the embedded schedule"
scheduled restart fonds >/dev/null
scheduled up -d --no-build --wait fonds
sleep 5
[ "$(runs scheduled)" = 1 ] || fail "occurrence ran again"

echo "== restart keeps the installation"
compose restart fonds >/dev/null
compose up -d --no-build --wait fonds
in_fonds "$metadata" || fail "metadata after restart"
compose exec -T fonds fonds login-link | grep -q '^http://localhost:8787/' ||
  fail "login-link after restart"

echo "smoke: ok"
