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
bundle=$(mktemp --suffix=.bundle)
remote_run="piw-run/$run"
status=fail

finish() {
  set +e
  ssh -o BatchMode=yes "$vm.exe.xyz" "tar -C piw-run -cf - $run" 2>/dev/null | tar -C "$out/.." -xf - 2>/dev/null
  node harness/lib/evidence.mjs "$out" "$commit" "$tree" "$vm" "$status" >/dev/null || echo "run: evidence record refused (privacy scan)" >&2
  if [ "$keep" = --keep-vm ]; then echo "run: kept $vm.exe.xyz"; else harness/vm/teardown.sh "$vm"; fi
  rm -f "$bundle"
  echo "run: $journey $status; evidence in ${out#"$repo/"}"
}
trap finish EXIT

git bundle create "$bundle" HEAD >/dev/null 2>&1
harness/vm/create.sh "$vm" "pi-worker-$journey"
ssh "$vm.exe.xyz" 'cat > piw.bundle' <"$bundle"
ssh "$vm.exe.xyz" "rm -rf piw && git clone -q piw.bundle piw && git -C piw checkout -q $commit && mkdir -p $remote_run"
ssh "$vm.exe.xyz" "PIW_RUN_DIR=\$HOME/$remote_run piw/harness/vm/remote-setup.sh"
ssh "$vm.exe.xyz" "PIW_RUN_DIR=\$HOME/$remote_run piw/harness/journeys/$journey/journey.sh"
status=pass
