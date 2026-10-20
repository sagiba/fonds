#!/usr/bin/env bash
# Starts the two disposable libSQL servers the storage suites use (see
# docs/internals/storage-testing.md#libsql-http) and prints their URLs as
# `export` lines. `stop` removes them. Synthetic test data only.
#
#   eval "$(scripts/libsql-test-servers.sh start)"
#   scripts/libsql-test-servers.sh stop
#
# FONDS_LIBSQL_HOST is the host that reaches published container ports:
# 127.0.0.1 on CI runners, host.docker.internal inside a Docker-backed devcontainer.
set -euo pipefail

# The official server image, pinned by version and multi-arch index digest.
IMAGE="ghcr.io/tursodatabase/libsql-server:v0.24.32@sha256:dedf5273da945d90f3b85fe367ed8f821349117ac2c488bf43c4a6bf9f2123e0"
HOST="${FONDS_LIBSQL_HOST:-127.0.0.1}"
PREFIX="${FONDS_LIBSQL_PREFIX:-fonds-libsql-test}"

port() {
  docker port "$1" "$2" | head -n 1 | sed 's/.*://'
}

wait_ready() {
  for _ in $(seq 1 60); do
    if curl --silent --fail --output /dev/null "http://$HOST:$1/health"; then
      return 0
    fi
    sleep 1
  done
  echo "libSQL server on port $1 did not become ready" >&2
  docker logs "$2" >&2 || true
  return 1
}

start() {
  stop >/dev/null 2>&1 || true
  docker run --detach --rm --name "$PREFIX-default" \
    --publish 127.0.0.1::8080 --publish 127.0.0.1::9090 \
    --entrypoint /bin/sqld "$IMAGE" \
    --db-path /var/lib/sqld/default \
    --http-listen-addr 0.0.0.0:8080 --admin-listen-addr 0.0.0.0:9090 >/dev/null
  # The large-capture profile raises response limits for its 64 MiB capture.
  docker run --detach --rm --name "$PREFIX-large" \
    --publish 127.0.0.1::8080 --publish 127.0.0.1::9090 \
    --entrypoint /bin/sqld "$IMAGE" \
    --db-path /var/lib/sqld/large \
    --http-listen-addr 0.0.0.0:8080 --admin-listen-addr 0.0.0.0:9090 \
    --max-response-size 256MB --max-total-response-size 256MB >/dev/null
  local default_http large_http large_admin
  default_http=$(port "$PREFIX-default" 8080)
  large_http=$(port "$PREFIX-large" 8080)
  large_admin=$(port "$PREFIX-large" 9090)
  wait_ready "$default_http" "$PREFIX-default"
  wait_ready "$large_http" "$PREFIX-large"
  # Only on this fresh disposable server: replace the empty default namespace
  # with the explicit large-test profile (128 MiB rows, 60-second transactions).
  curl --silent --show-error --fail --request DELETE \
    "http://$HOST:$large_admin/v1/namespaces/default" >/dev/null
  curl --silent --show-error --fail --request POST \
    --header 'Content-Type: application/json' \
    --data '{"max_row_size":134217728,"txn_timeout_s":60}' \
    "http://$HOST:$large_admin/v1/namespaces/default/create" >/dev/null
  echo "export FONDS_TEST_LIBSQL_HTTP_URL=http://$HOST:$default_http"
  echo "export FONDS_TEST_LIBSQL_LARGE_HTTP_URL=http://$HOST:$large_http"
}

stop() {
  docker rm --force "$PREFIX-default" "$PREFIX-large" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
