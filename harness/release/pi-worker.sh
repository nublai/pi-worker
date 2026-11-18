#!/bin/sh
# pi-worker release wrapper (docs/plan/install.md section 1): bin/pi-worker in the release tarball. Runs the bundled
# CLI (dist/main.js next to this bin directory, also through a symlink such as ~/.local/bin/pi-worker) on the host's
# node, and refuses a missing or too old node with one typed JSON line on stderr, exit 1, before anything runs.
# build.sh replaces @NODE_FLOOR@ with the release's Node floor (X.Y.Z, from package.json engines).
set -eu
floor='@NODE_FLOOR@'

refuse() {
  printf '%s\n' "$1" >&2
  exit 1
}

# 0 when version $1 (X.Y.Z...) is at least $2 (X.Y.Z); 1 otherwise, also for anything that is not a version.
at_least() {
  case "$1" in [0-9]*.[0-9]*.[0-9]*) ;; *) return 1 ;; esac
  have=$1 want=$2
  for _ in 1 2 3; do
    h=${have%%.*} w=${want%%.*}
    h=${h%%[!0-9]*}
    case "$h" in '' | *[!0-9]*) return 1 ;; esac
    [ "$h" -gt "$w" ] && return 0
    [ "$h" -lt "$w" ] && return 1
    have=${have#*.} want=${want#*.}
  done
  return 0
}

node=$(command -v node 2>/dev/null) ||
  refuse "{\"error\":\"node_missing\",\"effect\":\"no_effect\",\"required\":\">=$floor\"}"
found=$("$node" -p 'process.versions.node' 2>/dev/null) || found=unknown
case "$found" in *[!0-9.]* | '') found=unknown ;; esac
at_least "$found" "$floor" ||
  refuse "{\"error\":\"node_unsupported\",\"effect\":\"no_effect\",\"required\":\">=$floor\",\"found\":\"$found\"}"

self=$(readlink -f -- "$0")
top=$(dirname -- "$(dirname -- "$self")")
exec "$node" "$top/dist/main.js" "$@"
