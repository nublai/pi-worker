#!/usr/bin/env bash
# Live journey on a throwaway exe.dev VM (plan section 8, AGENTS.md rule 8):
#   harness/run.sh <journey> [--keep-vm]
# Creates a tester VM, sends the exact committed HEAD as a git bundle (no GitHub credential on the VM), runs
# harness/vm/remote-setup.sh (runtimes, build, default and kernel suites) and the journey there, copies the run
# directory back to docs/evidence/<milestone>/<run>/, writes checks.json bound to commit and tree (privacy scanned),
# and deletes the VM even when a step fails. A failed run is kept and labelled `fail`, never counted.
set -euo pipefail
journey=${1:?journey, for example p0-hello}
keep=${2:-}
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
[ -f "harness/journeys/$journey/journey.sh" ] || { echo "run: no journey $journey" >&2; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "run: commit first; the VM gets HEAD only" >&2; exit 2; }

commit=$(git rev-parse HEAD)
tree=$(git rev-parse 'HEAD^{tree}')
milestone=${journey%%-*}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
run="$stamp-${commit:0:7}"
vm="piw-$journey-$(date -u +%m%d%H%M)"
out="$repo/docs/evidence/$milestone/$run"
mkdir -p "$out"
work=$(mktemp -d)
bundle="$work/head.bundle"
remote_run="piw-run/$run"
status=fail
step=start
# A fresh VM has a new host key: accept it on first use into a run-local known_hosts, never the operator's.
export PIW_SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$work/known_hosts"
vssh() { ssh $PIW_SSH_OPTS "$vm.exe.xyz" "$@"; }

finish() {
  set +e
  vssh "tar -C piw-run -cf - $run" 2>/dev/null | tar -C "$out/.." -xf - 2>/dev/null
  note=$([ "$status" = pass ] || echo "failed at: $step")
  node harness/lib/evidence.mjs "$out" "$commit" "$tree" "$vm" "$status" ${note:+"$note"} >/dev/null || echo "run: evidence record refused (privacy scan)" >&2
  if [ "$keep" = --keep-vm ]; then echo "run: kept $vm.exe.xyz"; else harness/vm/teardown.sh "$vm"; fi
  rm -rf "$work"
  echo "run: $journey $status; evidence in ${out#"$repo/"}"
}
trap finish EXIT

git bundle create "$bundle" HEAD >/dev/null 2>&1
step=create
harness/vm/create.sh "$vm" "pi-worker-$journey"
step=bundle
vssh 'cat > piw.bundle' <"$bundle"
vssh "rm -rf piw && git clone -q piw.bundle piw && git -C piw checkout -q $commit && mkdir -p $remote_run"
step=setup
vssh "PIW_RUN_DIR=\$HOME/$remote_run piw/harness/vm/remote-setup.sh"
step=journey
vssh "PIW_RUN_DIR=\$HOME/$remote_run piw/harness/journeys/$journey/journey.sh"
status=pass
