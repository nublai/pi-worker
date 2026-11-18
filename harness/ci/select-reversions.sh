#!/usr/bin/env bash
# Which reversion groups ci.yml's reversion-groups job runs. Prints `groups=<JSON array>` and `mode=<text>` lines
# for $GITHUB_OUTPUT. Inputs (environment): EVENT (github.event_name), BASE_REF (PR base branch), BEFORE (a push's
# previous head), FULL_LABEL (`true` when the PR carries full-reversions). Run from the repo root.
#   schedule, workflow_dispatch, or a PR labelled full-reversions: every group
#   other PR: the groups `--changed origin/<base> --list` selects
#   push: the groups changed since BEFORE, only when BEFORE is a commit and an ancestor of HEAD; otherwise every group
# Tested by harness/test/select-reversions.test.mjs.
set -euo pipefail
runner=${PIW_REVERSIONS_RUNNER:-harness/lib/reversions.mjs}
all() { node "$runner" --list; }
zero=0000000000000000000000000000000000000000
case "$EVENT" in
  pull_request)
    if [ "${FULL_LABEL:-}" = true ]; then
      mode='all (label full-reversions)'; names=$(all)
    else
      mode="changed vs $BASE_REF"; names=$(node "$runner" --changed "origin/$BASE_REF" --list)
    fi ;;
  push)
    if [ "${BEFORE:-$zero}" != "$zero" ] && git cat-file -e "$BEFORE^{commit}" 2>/dev/null &&
      git merge-base --is-ancestor "$BEFORE" HEAD 2>/dev/null; then
      mode='changed since the previous head'; names=$(node "$runner" --changed "$BEFORE" --list)
    else
      mode='all (new ref, rewind or force push)'; names=$(all)
    fi ;;
  *) mode="all ($EVENT)"; names=$(all) ;;
esac
echo "groups=$(printf '%s\n' "$names" | jq -Rnc '[inputs | select(length > 0)]')"
echo "mode=$mode"
