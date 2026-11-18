#!/usr/bin/env bash
# p4-install live journey on a fresh exe.dev tester VM (AGENTS.md rule 8), run from the operator host:
#   harness/journeys/p4-install/run.sh [--keep-vm]
# Unlike harness/run.sh this journey needs no repository on the VM: it builds the x64 release tarball from the exact
# committed HEAD here (harness/release/build.sh), creates the VM (harness/vm/create.sh), copies the tarball, its
# .sha256 and the two VM scripts, runs host-setup.sh (the host prerequisites: bubblewrap, user namespaces, linger, Node)
# and journey.sh, copies the run directory back to docs/evidence/p4/<run>/, writes checks.json bound to commit and tree
# (privacy scanned, harness/lib/evidence.mjs), and deletes the VM even when a step fails. A failed run is kept and
# labelled `fail`, never counted.
set -euo pipefail
keep=${1:-}
repo=$(cd "$(dirname "$0")/../../.." && pwd)
here="$repo/harness/journeys/p4-install"
cd "$repo"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "p4-install: commit first; the artifact is built from HEAD" >&2; exit 2; }
commit=$(git rev-parse HEAD)
tree=$(git rev-parse 'HEAD^{tree}')
stamp=$(date -u +%Y%m%dT%H%M%SZ)
run="$stamp-${commit:0:7}"
vm=${PIW_VM_NAME:-piw-p4-install-$(date -u +%m%d%H%M)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}
out="$repo/docs/evidence/p4/$run"
mkdir -p "$out"
work=$(mktemp -d)
remote="piw-p4"
status=fail
step=build
export PIW_CREATED_FILE="$work/vm-created"
export PIW_SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$work/known_hosts"
vssh() { ssh $PIW_SSH_OPTS "$vm.exe.xyz" "$@"; }

finish() {
  rc=$?
  set +e
  trap - EXIT
  vssh "tar -C $remote/run -cf - ." 2>/dev/null | tar -C "$out" -xf - 2>/dev/null
  if [ ! -e "$PIW_CREATED_FILE" ]; then
    teardown=not_created
  elif [ "$keep" = --keep-vm ]; then
    teardown=retained; echo "p4-install: kept $vm.exe.xyz"
  elif harness/vm/teardown.sh "$vm"; then
    teardown=deleted
  else
    teardown=failed; status=fail; step="$step; vm teardown failed"
    echo "p4-install: VM TEARDOWN FAILED: delete $vm manually (ssh exe.dev rm $vm)" >&2
  fi
  note=$([ "$status" = pass ] || echo "failed at: $step")
  PIW_VM_TEARDOWN=$teardown node harness/lib/evidence.mjs "$out" "$commit" "$tree" "$vm" "$status" ${note:+"$note"} >/dev/null
  ev=$?
  [ $ev -eq 0 ] || echo "p4-install: evidence record refused or failed" >&2
  rm -rf "$work"
  echo "p4-install: $status; vm $teardown; evidence in ${out#"$repo/"}"
  if [ $rc -ne 0 ]; then exit $rc; fi
  if [ "$teardown" = failed ] || [ $ev -ne 0 ]; then exit 1; fi
  exit 0
}
trap finish EXIT

PIW_RELEASE_OUT="$work/release" harness/release/build.sh x64
tarball=$(ls "$work"/release/pi-worker-*-linux-x64.tar.gz)
name=$(basename "$tarball")
step=create
harness/vm/create.sh "$vm" pi-worker-p4-install
step=copy
vssh "rm -rf $remote && mkdir -p $remote/run"
for file in "$tarball" "$tarball.sha256" "$here/host-setup.sh" "$here/journey.sh"; do
  vssh "cat > $remote/$(basename "$file")" <"$file"
done
step=setup
vssh "bash $remote/host-setup.sh $(cat .node-version) \$HOME/$remote/run > $remote/run/setup.log 2>&1" ||
  { vssh "tail -30 $remote/run/setup.log" >&2; exit 1; }
step=journey
vssh "bash $remote/journey.sh $remote/$name \$HOME/$remote/run"
status=pass
