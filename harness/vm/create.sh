#!/usr/bin/env bash
# Create a throwaway exe.dev tester VM and wait for SSH (the exe-dev-test-vm skill). No tailnet join: P0 to P4
# journeys need none (the worker has no network listener).
#   harness/vm/create.sh <vm-name> <comment>
set -euo pipefail
vm=${1:?vm name}
comment=${2:-pi-worker-journey}
case "$vm$comment" in *[[:space:]]*) echo "create: name and comment must have no spaces" >&2; exit 2 ;; esac
ssh exe.dev new --name="$vm" --comment="$comment" --no-email --json >/dev/null
for _ in $(seq 1 60); do
  if ssh -o ConnectTimeout=8 -o BatchMode=yes "$vm.exe.xyz" true 2>/dev/null; then
    echo "create: $vm.exe.xyz is up"
    exit 0
  fi
  sleep 5
done
echo "create: $vm.exe.xyz did not answer SSH" >&2
exit 1
