#!/usr/bin/env bash
# Delete a throwaway exe.dev tester VM. A VM that joined the tailnet logs out first (exe-dev-test-vm skill); P0
# journeys never join, so this only removes the VM.
#   harness/vm/teardown.sh <vm-name>
set -euo pipefail
ssh_opts=${PIW_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=accept-new}
vm=${1:?vm name}
if ssh $ssh_opts -o ConnectTimeout=8 "$vm.exe.xyz" 'command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1' 2>/dev/null; then
  ssh $ssh_opts "$vm.exe.xyz" 'sudo tailscale logout' || true
fi
ssh exe.dev rm "$vm"
echo "teardown: $vm removed"
