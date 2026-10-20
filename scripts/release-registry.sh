# Registry lookups for the release workflow, sourced by its steps. Each fails
# closed: only a confirmed absence counts as absent (status 3); any other
# registry or network error fails, so it can never pass for "nothing there".

# The integrity npm serves for name@version; status 3 when the version does not exist.
npm_integrity() {
  local out err status
  err="$(mktemp)"
  out="$(npm view "$1@$2" dist.integrity 2>"$err")" && status=0 || status=$?
  if [ "$status" = 0 ] && [ -n "$out" ]; then
    echo "$out"
  elif grep -q 'code E404' "$err"; then
    status=3
  else
    cat "$err" >&2
    status=1
  fi
  rm -f "$err"
  return "$status"
}

# Every published version of a package, one per line; none before its first.
npm_versions() {
  local out err status
  err="$(mktemp)"
  out="$(npm view "$1" versions --json 2>"$err")" && status=0 || status=$?
  if [ "$status" = 0 ]; then
    echo "$out" | jq -r 'if type == "array" then .[] else . end'
  elif ! grep -q 'code E404' "$err"; then
    cat "$err" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
}

# The version an npm dist-tag points to; empty when the tag does not exist.
npm_channel() {
  npm view "$1" "dist-tags.$2"
}

# Runs `docker buildx imagetools inspect` for a reference; status 3 when the
# registry reports that it does not exist.
image_inspect() {
  local err status
  err="$(mktemp)"
  docker buildx imagetools inspect "$@" 2>"$err" && status=0 || status=$?
  if [ "$status" != 0 ]; then
    if grep -q ': not found$' "$err"; then
      status=3
    else
      cat "$err" >&2
    fi
  fi
  rm -f "$err"
  return "$status"
}

# The digest of the index a reference names.
image_digest() {
  local manifest
  manifest="$(image_inspect "$1" --format '{{json .Manifest}}')" || return
  echo "$manifest" | jq -r .digest
}

# The Linux platform images that references name, sorted on one line.
image_platforms() {
  local reference manifest
  for reference in "$@"; do
    manifest="$(image_inspect "$reference" --format '{{json .Manifest}}')" || return
    echo "$manifest" | jq -r '.manifests[] | select(.platform.os == "linux") | .digest'
  done | sort | paste -sd ' '
}

# The version label a tag's images carry, or - when the tag does not exist.
image_version() {
  local image status
  image="$(image_inspect "$1" --format '{{json .Image}}')" && status=0 || status=$?
  if [ "$status" = 3 ]; then
    echo -
    return 0
  fi
  [ "$status" = 0 ] || return "$status"
  echo "$image" | jq -r '(if has("config") then [.] else [.[]] end)
    | [.[] | .config.Labels["org.opencontainers.image.version"]] | unique
    | if length == 1 and (.[0] | type) == "string" then .[0]
      else error("missing or inconsistent version labels") end'
}
