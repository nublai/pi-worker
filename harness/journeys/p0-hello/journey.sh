#!/usr/bin/env bash
# p0-hello, run ON the test VM after harness/vm/remote-setup.sh: the daemon runs as a systemd user service with
# Delegate=yes, both clients (TypeScript and Go) say hello and get a typed 409 no_effect, then the service stops and leaves
# no socket, no piw-* unit and no cgroup behind. Writes $PIW_RUN_DIR/journey.json; exits non-zero on any failed check.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
run=${PIW_RUN_DIR:?PIW_RUN_DIR}
tools="$HOME/.local/piw-tools"
node_dir=$(ls -d "$tools"/node-v"$(cat "$repo/.node-version")"-linux-* | head -1)
export PATH="$node_dir/bin:$tools/go1.24.13/bin:$PATH" GOTOOLCHAIN=local XDG_RUNTIME_DIR="/run/user/$(id -u)"
unset GOROOT
cd "$repo"

unit=piw-p0-hello
socket="$XDG_RUNTIME_DIR/pi-worker-p0/b2.sock"
state="$HOME/.local/state/pi-worker-p0"
uid=$(id -u)
cgroup="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice/$unit.service"

# Every B2 request needs a bearer grant (P1-9): register one by local file access before the daemon starts.
# The bearer stays out of the evidence directory ($run) and is deleted when the journey ends.
grant_file="$(dirname "$state")/p0-hello.grant.json"
rm -f "$grant_file"
trap 'rm -f "$grant_file"' EXIT
PIW_STATE_DIR="$state" "$node_dir/bin/node" "$repo/packages/worker/dist/src/grant.js" register --caller p0-hello --out "$grant_file" >/dev/null
export PIW_GRANT_FILE="$grant_file"

systemd-run --user --unit="$unit" -p Delegate=yes -p Type=exec --collect \
  --setenv=PIW_SOCKET="$socket" --setenv=PIW_STATE_DIR="$state" \
  "$node_dir/bin/node" "$repo/packages/worker/dist/src/main.js" >/dev/null
for _ in $(seq 1 100); do [ -S "$socket" ] && break; sleep 0.1; done
[ -S "$socket" ] || { journalctl --user -u "$unit" --no-pager | tail -20 >&2; echo "journey: no socket" >&2; exit 1; }

service_active=$(systemctl --user is-active "$unit")
delegate=$(systemctl --user show -p Delegate --value "$unit")
socket_mode=$(stat -c %a "$socket")
dir_mode=$(stat -c %a "$(dirname "$socket")")
cgroup_present=$([ -d "$cgroup" ] && echo true || echo false)
ts=$(node harness/journeys/p0-hello/ts-hello.mjs "$socket")
gohello=$(cd harness/journeys/p0-hello/go && go run . "$socket")

systemctl --user stop "$unit"
for _ in $(seq 1 50); do systemctl --user is-active --quiet "$unit" || break; sleep 0.1; done
left_units=$(systemctl --user list-units --all --plain --no-legend 'piw-*' | awk '{print $1}' | paste -sd, -)
socket_left=$([ -e "$socket" ] && echo true || echo false)
cgroup_left=$([ -d "$cgroup" ] && echo true || echo false)

node - "$run/journey.json" "$ts" "$gohello" <<EOF
const fs = require('node:fs');
const [file, ts, go] = process.argv.slice(2);
const tsr = JSON.parse(ts), gor = JSON.parse(go);
const sorted = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
const checks = {
  service_active: '$service_active' === 'active',
  service_delegated: '$delegate' === 'yes',
  socket_0600: '$socket_mode' === '600',
  socket_dir_0700: '$dir_mode' === '700',
  service_cgroup_present: $cgroup_present,
  ts_hello: tsr.hello === 'ok' && tsr.protocol_major === 0,
  ts_refused_no_effect: tsr.prompt_status === 409 && tsr.prompt_effect === 'no_effect',
  go_hello: gor.hello === 'ok' && gor.protocol_major === 0,
  go_refused_no_effect: gor.prompt_status === 409 && gor.prompt_effect === 'no_effect',
  same_supervisor: tsr.supervisor_epoch === gor.supervisor_epoch && tsr.supervisor_epoch.length > 0,
  limits_agree: sorted(tsr.limits) === sorted(gor.limits),
  no_piw_units_left: '$left_units' === '',
  socket_removed: !$socket_left,
  cgroup_removed: !$cgroup_left,
};
const result = { journey: 'p0-hello', pass: Object.values(checks).every(Boolean), checks, ts: tsr, go: gor };
fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ journey: result.journey, pass: result.pass, failed: Object.keys(checks).filter(k => !checks[k]) }));
process.exit(result.pass ? 0 : 1);
EOF
