#!/usr/bin/env bash
# p4-install, run ON the tester VM after host-setup.sh (docs/plan/install.md), as the VM's ordinary user:
#   journey.sh <tarball> <run-dir>
# install from the release tarball (its own CLI bootstraps it), doctor all green, install again (idempotent), another
# version refused, hello, a grant registered and one granted read, an ungranted method refused, logs, uninstall
# (state and versions kept), install again (the grant still works), uninstall --purge (nothing left).
# Writes <run-dir>/journey.json (named checks) and <run-dir>/transcript.log (commands and their output; bearers only
# ever live in their 0600 files outside the run directory). Exits non-zero on any failed check.
set -uo pipefail
tarball=$(readlink -f "${1:?tarball}")
run=${2:?run dir}
mkdir -p "$run"
transcript="$run/transcript.log"
: >"$transcript"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export PATH="$HOME/.local/bin:$PATH"
name=$(basename "$tarball")
version=${name#pi-worker-}
version=${version%-linux-*}
uid=$(id -u)
data="$HOME/.local/share/pi-worker"
state="$HOME/.local/state/pi-worker"
unit_file="$HOME/.config/systemd/user/pi-worker.service"
socket="$XDG_RUNTIME_DIR/pi-worker/b2.sock"
unit_cg="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice/pi-worker.service"
bridge_grant="$HOME/p4-bridge.grant.json"
boot=$(mktemp -d)
trap 'rm -rf "$boot" "$bridge_grant"' EXIT

declare -A checks
check() { # check <name> <true|false>
  checks[$1]=$2
  echo "check $1: $2" >>"$transcript"
}
# say <command...>: logs the command and its output to the transcript; the output is also in $said, the status in $rc.
say() {
  echo "\$ $*" >>"$transcript"
  said=$("$@" 2>&1)
  rc=$?
  printf '%s\n[exit %s]\n' "$said" "$rc" >>"$transcript"
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s.trim().split("\n").at(-1));const r=new Function("v","return ("+process.argv[1]+")")(v);process.stdout.write(String(r))})' "$1"; }
is() { [ "$1" = "$2" ] && echo true || echo false; }
gone() { [ ! -e "$1" ] && [ ! -L "$1" ] && echo true || echo false; }

echo "# p4-install on $(uname -n): $name" >>"$transcript"
say sha256sum -c "$tarball.sha256" --status
say tar -xzf "$tarball" -C "$boot"
cli="$boot/pi-worker-$version/bin/pi-worker"

# 1. Install from the tarball's own CLI; one JSON line.
say "$cli" install --from "$tarball"
install_out=$said
check install_ok "$(is "$rc:$(printf '%s' "$install_out" | json 'v.version + "|" + v.socket + "|" + v.unit')" "0:$version|$socket|pi-worker.service")"

# 2. Doctor: every check green.
say pi-worker doctor --json
check doctor_all_green "$(is "$rc:$(printf '%s' "$said" | json 'v.ok && v.checks.length === 7 && v.checks.every(c => c.ok)')" 0:true)"
say pi-worker doctor

# 3. The same version again: idempotent, same line.
say "$cli" install --from "$tarball"
check install_idempotent "$(is "$rc:$said" "0:$install_out")"

# 4. Another version while one is installed: refused before anything is written.
other="$boot/pi-worker-9.9.9-linux-$(printf '%s' "$name" | sed 's/.*-linux-\(.*\)\.tar\.gz/\1/').tar.gz"
cp "$tarball" "$other"
(cd "$boot" && sha256sum "$(basename "$other")" >"$other.sha256")
say pi-worker install --from "$other"
check upgrade_refused "$(is "$rc:$(printf '%s' "$said" | json 'v.error + "|" + v.installed + "|" + v.requested + "|" + v.effect')" "1:pi_worker_upgrade_unavailable|$version|9.9.9|no_effect")"
check upgrade_left_nothing "$(gone "$data/versions/9.9.9")"

# 5. The unit: Delegate=yes, active, the supervisor in its leaf; socket 0600 in a 0700 directory.
say systemctl --user show pi-worker.service -p Delegate -p ActiveState -p MainPID -p ControlGroup
props=$said
check unit_delegated "$(printf '%s' "$props" | grep -qx 'Delegate=yes' && echo true || echo false)"
check unit_active "$(printf '%s' "$props" | grep -qx 'ActiveState=active' && echo true || echo false)"
main_pid=$(printf '%s' "$props" | sed -n 's/^MainPID=//p')
say cat "/proc/$main_pid/cgroup"
check supervisor_in_leaf "$(is "$said" "0::${unit_cg#/sys/fs/cgroup}/supervisor")"
say ls "$unit_cg"
check socket_0600 "$(is "$(stat -c %a "$socket")" 600)"
check socket_dir_0700 "$(is "$(stat -c %a "$(dirname "$socket")")" 700)"

# 6. hello, a grant, one granted read, an ungranted method refused.
say pi-worker --grant-file "$data/doctor.grant.json" hello
check hello "$(is "$rc:$(printf '%s' "$said" | json 'v.protocol.major + "|" + v.worker_version')" "0:0|$version")"
rm -f "$bridge_grant"
say pi-worker grant register --caller p4-journey --out "$bridge_grant" --method hello --method workers.list
check grant_registered "$(is "$rc:$(printf '%s' "$said" | json 'v.caller')" 0:p4-journey)"
say pi-worker --grant-file "$bridge_grant" workers.list
check granted_read "$(is "$rc:$(printf '%s' "$said" | json 'Array.isArray(v.workers)')" 0:true)"
say pi-worker --grant-file "$bridge_grant" sessions.list
check ungranted_refused "$(is "$rc:$(printf '%s' "$said" | json 'v.effect')" 1:no_effect)"

# 7. Logs: the supervisor's typed events.
say pi-worker logs
check logs_listening "$(printf '%s' "$said" | grep -q '"event":"listening"' && echo true || echo false)"

# 8. Uninstall: unit and links gone, state and versions kept.
say pi-worker uninstall
check uninstall_ok "$(is "$rc:$said" '0:{"uninstalled":true,"purged":false}')"
say systemctl --user is-active pi-worker.service
check uninstall_unit_stopped "$(is "$said" inactive)"
check uninstall_unit_file_gone "$(gone "$unit_file")"
check uninstall_bin_gone "$(gone "$HOME/.local/bin/pi-worker")"
check uninstall_current_gone "$(gone "$data/current")"
check uninstall_versions_kept "$([ -f "$data/versions/$version/release.json" ] && echo true || echo false)"
check uninstall_state_kept "$([ -d "$state/grants" ] && echo true || echo false)"
check uninstall_cgroup_gone "$(gone "$unit_cg")"

# 9. Install again: the kept state's grant still works.
say "$cli" install --from "$tarball"
check reinstall_ok "$(is "$rc:$said" "0:$install_out")"
say pi-worker doctor --json
check reinstall_doctor_green "$(is "$rc" 0)"
say pi-worker --grant-file "$bridge_grant" workers.list
check reinstall_grant_kept "$(is "$rc" 0)"

# 10. Uninstall --purge: nothing left.
say pi-worker uninstall --purge
check purge_ok "$(is "$rc:$said" '0:{"uninstalled":true,"purged":true}')"
for path in "$data" "$state" "$unit_file" "$HOME/.local/bin/pi-worker" "$(dirname "$socket")" "$unit_cg"; do
  say ls -la "$path"
done
check purge_data_gone "$(gone "$data")"
check purge_state_gone "$(gone "$state")"
check purge_unit_file_gone "$(gone "$unit_file")"
check purge_bin_gone "$(gone "$HOME/.local/bin/pi-worker")"
check socket_removed "$(gone "$(dirname "$socket")")"
check cgroup_removed "$(gone "$unit_cg")"
say systemctl --user list-units --all --plain --no-legend 'pi-worker*' 'piw-*'
check no_piw_units_left "$(is "$said" '')"
say pgrep -u "$uid" -f "pi-worker/versions/"
check no_process_left "$(is "$rc" 1)"

{
  for k in "${!checks[@]}"; do printf '%s\t%s\n' "$k" "${checks[$k]}"; done
} | node -e '
const fs = require("node:fs");
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  const checks = Object.fromEntries(s.trim().split("\n").map(l => l.split("\t")).map(([k, v]) => [k, v === "true"]).sort());
  const result = { journey: "p4-install", version: process.argv[2], pass: Object.values(checks).every(Boolean), checks };
  fs.writeFileSync(process.argv[1], JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ journey: result.journey, pass: result.pass, failed: Object.keys(checks).filter(k => !checks[k]) }));
  process.exit(result.pass ? 0 : 1);
});' "$run/journey.json" "$version"
