#!/usr/bin/env bash
# Create a throwaway exe.dev tester VM and wait for SSH (the exe-dev-test-vm skill). No tailnet join: P0 to P4
# journeys need none (the worker has no network listener).
#   harness/vm/create.sh <vm-name> <comment>
set -euo pipefail
ssh_opts=${PIW_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=accept-new}
vm=${1:?vm name}
comment=${2:-pi-worker-journey}
case "$vm$comment" in *[[:space:]]*) echo "create: name and comment must have no spaces" >&2; exit 2 ;; esac
ssh exe.dev new --name="$vm" --comment="$comment" --no-email --json >/dev/null
# Record that this run created the VM before waiting for it: a readiness failure must still be torn down.
[ -z "${PIW_CREATED_FILE:-}" ] || : >"$PIW_CREATED_FILE"
for _ in $(seq 1 "${PIW_READY_TRIES:-60}"); do
  if ssh $ssh_opts -o ConnectTimeout=8 "$vm.exe.xyz" true 2>/dev/null; then
    echo "create: $vm.exe.xyz is up"
    exit 0
  fi
  sleep "${PIW_READY_SLEEP:-5}"
done
echo "create: $vm.exe.xyz did not answer SSH" >&2
exit 1
