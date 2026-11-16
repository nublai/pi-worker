#!/usr/bin/env bash
# Kernel tier (plan P0-8): runs the security tests inside a delegated systemd user service (Delegate=yes) with
# PIW_TEST_KERNEL=1. Inside the unit a fixed shell moves itself into the service's `runner` leaf (writing 0 to its
# cgroup.procs; systemd-run would rewrite $$), so the service cgroup holds no process and the tests may enable
# controllers for the domains they create.
#
# Needs: Linux with cgroup v2, a running systemd user manager (linger), bubblewrap, unprivileged user namespaces
# (Ubuntu 24.04: kernel.apparmor_restrict_unprivileged_userns=0 or a bwrap AppArmor profile), and `npm run build`.
# Fails, naming the reason, on a missing prerequisite, any failing, skipped or todo test, zero tests, or a piw-*
# unit left behind. Prints the platform (kernel, bwrap, systemd, controllers) first.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

say() { echo "kernel: $*"; echo "$*" >>"$summary"; }
fail() {
  say "FAIL: $*"
  exit 1
}

# Prerequisites, each named when missing.
[ "$(uname -s)" = Linux ] || fail "not Linux"
[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = cgroup2fs ] || fail "cgroup v2 is not mounted at /sys/fs/cgroup"
systemctl --user show-environment >/dev/null 2>&1 ||
  fail "no systemd user manager for $(id -un) (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR); run: loginctl enable-linger $(id -un)"
command -v bwrap >/dev/null || fail "bubblewrap is not installed"
command -v node >/dev/null || fail "node is not on PATH"
compgen -G 'packages/worker/dist/test/security/*.test.js' >/dev/null || fail "no built security tests; run npm run build"

uid=$(id -u)
manager_cg="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service"
say "platform: kernel $(uname -r); $(bwrap --version); $(systemctl --version | head -1)"
say "platform: user manager controllers: $(cat "$manager_cg/cgroup.controllers" 2>/dev/null || echo unreadable)"
say "platform: kernel.apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"

unit="piw-kernel-$(date +%s)-$$"
log=$(mktemp)
trap 'rm -f "$log"' EXIT
say "unit: $unit (Delegate=yes)"
set +e
systemd-run --user --pipe --wait --collect --quiet --unit="$unit" -p Delegate=yes \
  --working-directory="$repo" --setenv=PATH="$PATH" --setenv=HOME="$HOME" --setenv=TMPDIR="${TMPDIR:-/tmp}" \
  --setenv=PIW_TEST_KERNEL=1 \
  /bin/sh -c 'cg=/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)
    mkdir "$cg/runner" && echo 0 > "$cg/runner/cgroup.procs" || { echo "kernel: cannot enter $cg/runner" >&2; exit 125; }
    export PIW_CGROUP_ROOT="$cg"
    exec node tools/node-test.mjs "packages/worker/dist/test/security/**/*.test.js"' 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

left=$(systemctl --user list-units --all --plain --no-legend 'piw-*' | awk '{print $1}')
if [ -n "$left" ]; then
  # shellcheck disable=SC2086
  systemctl --user stop $left || true
  fail "piw-* units left behind: $left"
fi

count() { sed -n "s/^ℹ $1 \([0-9]*\)$/\1/p" "$log" | tail -1; }
pass=$(count pass)
skipped=$(count skipped)
todo=$(count todo)
[ "$status" = 0 ] || fail "kernel suite exited $status"
[ -n "$pass" ] && [ "$pass" -gt 0 ] || fail "no kernel test ran"
[ "${skipped:-x}" = 0 ] && [ "${todo:-x}" = 0 ] || fail "kernel tier requires 0 skips and 0 todo (skipped=$skipped todo=$todo)"
say "PASS: $pass tests, 0 skips, 0 piw-* units left"
