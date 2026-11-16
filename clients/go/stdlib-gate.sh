#!/bin/sh
# The Go client must depend on the standard library only (Shep's bridge keeps its two dependencies).
# Fails if any non-standard package outside this module is reachable, including from tests.
set -eu
cd "$(dirname "$0")"
module=$(go list -m)
test -z "$(sed -n '/^require/p' go.mod)" || { echo "go.mod must have no require directives" >&2; exit 1; }
external=$(
  { go list -deps -f '{{if not .Standard}}{{.ImportPath}}{{end}}' ./...
    go list -deps -test -tags integration -f '{{if not .Standard}}{{.ImportPath}}{{end}}' ./...; } |
    sed 's/ \[.*\]$//' | grep -v "^$module\(/\|\.test\|$\)" | sort -u || true
)
if [ -n "$external" ]; then
  echo "non-standard dependencies:" >&2
  echo "$external" >&2
  exit 1
fi
echo "stdlib only: $module"
