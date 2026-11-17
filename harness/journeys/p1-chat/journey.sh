#!/usr/bin/env bash
# p1-chat, run ON the test VM after harness/vm/remote-setup.sh: the P1 daemon runs as a systemd user service with
# Delegate=yes and an agent directory whose only extension is pi's scripted faux provider (no credentials, no
# network); chat.mjs then drives every step through the `pi-worker` CLI (packages/cli): grant register, hello, create,
# prompt, history, a dialog, an image, interrupt, stop, grant revoke and the refused call after it. The service then
# stops and leaves no socket, no piw-* unit, no cgroup and no pi process behind. Writes $PIW_RUN_DIR/journey.json
# (checks, exit codes, typed error names; no message text, answers or bearer); exits non-zero on any failed check.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
run=${PIW_RUN_DIR:?PIW_RUN_DIR}
tools="$HOME/.local/piw-tools"
node_dir=$(ls -d "$tools"/node-v"$(cat "$repo/.node-version")"-linux-* | head -1)
export PATH="$node_dir/bin:$PATH" XDG_RUNTIME_DIR="/run/user/$(id -u)"
cd "$repo"

unit=piw-p1-chat
socket="$XDG_RUNTIME_DIR/pi-worker-p1/b2.sock"
base="$HOME/.local/state/pi-worker-p1-chat"
state="$base/state"
agent="$base/agent"
work="$base/work"
scratch="$base/scratch"
uid=$(id -u)
cgroup="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice/$unit.service"
cli="$repo/packages/cli/dist/src/main.js"

# The bearer lives outside the evidence directory ($run) and is deleted when the journey ends, as is everything else.
grant_file="$base/p1-chat.grant.json"
rm -rf "$base"
mkdir -p -m 0700 "$base" "$agent/extensions" "$work" "$scratch"
trap 'rm -rf "$base"' EXIT
cp harness/journeys/p1-chat/faux.ts "$agent/extensions/faux.ts"

systemd-run --user --unit="$unit" -p Delegate=yes -p Type=exec --collect \
  --setenv=PIW_SOCKET="$socket" --setenv=PIW_STATE_DIR="$state" --setenv=PI_CODING_AGENT_DIR="$agent" \
  "$node_dir/bin/node" "$repo/packages/worker/dist/src/main.js" >/dev/null
for _ in $(seq 1 100); do [ -S "$socket" ] && break; sleep 0.1; done
[ -S "$socket" ] || { journalctl --user -u "$unit" --no-pager | tail -20 >&2; echo "journey: no socket" >&2; exit 1; }

service_active=$(systemctl --user is-active "$unit")
delegate=$(systemctl --user show -p Delegate --value "$unit")
cgroup_present=$([ -d "$cgroup" ] && echo true || echo false)
chat_rc=0
PIW_SOCKET="$socket" PIW_STATE_DIR="$state" PIW_GRANT_FILE="$grant_file" \
  node harness/journeys/p1-chat/chat.mjs "$cli" "$work" "$scratch" "$run/chat.json" || chat_rc=$?

systemctl --user stop "$unit"
for _ in $(seq 1 50); do systemctl --user is-active --quiet "$unit" || break; sleep 0.1; done
left_units=$(systemctl --user list-units --all --plain --no-legend 'piw-*' | awk '{print $1}' | paste -sd, -)
socket_left=$([ -e "$socket" ] && echo true || echo false)
cgroup_left=$([ -d "$cgroup" ] && echo true || echo false)
pi_left=$(pgrep -u "$uid" -f "$repo/packages/worker/dist/src/sdk-child" >/dev/null && echo true || echo false)

node - "$run/journey.json" "$run/chat.json" <<EOF
const fs = require('node:fs');
const [file, chatFile] = process.argv.slice(2);
const chat = fs.existsSync(chatFile) ? JSON.parse(fs.readFileSync(chatFile, 'utf8')) : { pass: false, checks: {}, facts: {}, steps: [] };
fs.rmSync(chatFile, { force: true });
const checks = {
  service_active: '$service_active' === 'active',
  service_delegated: '$delegate' === 'yes',
  service_cgroup_present: $cgroup_present,
  chat_exit_0: $chat_rc === 0,
  ...chat.checks,
  no_piw_units_left: '$left_units' === '',
  socket_removed: !$socket_left,
  cgroup_removed: !$cgroup_left,
  no_pi_child_left: !$pi_left,
};
const result = { journey: 'p1-chat', pass: Object.values(checks).every(Boolean), checks, facts: chat.facts, steps: chat.steps };
fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ journey: result.journey, pass: result.pass, failed: Object.keys(checks).filter(k => !checks[k]) }));
process.exit(result.pass ? 0 : 1);
EOF
