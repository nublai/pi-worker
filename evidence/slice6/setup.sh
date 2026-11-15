#!/bin/bash
# Authored slice-6 setup. Run only on the existing a0-worker VM.
set -euo pipefail
[ "$(hostname)" = a0-worker ]
umask 077
export PATH=/home/exedev/.local/node/bin:/home/exedev/.local/bin:/usr/bin:/bin
export TMPDIR=/tmp/a0s6/tmp npm_config_cache=/tmp/a0s6/npm-cache
R=/tmp/a0s6/run1
mkdir -p "$TMPDIR" "$R/state" "$R/profile/extensions" "$R/profile/npm" "$R/bin" /tmp/a0s6/out
[ ! -d /tmp/a0s6/supervisor ]
git clone /tmp/a0s6/base.bundle /tmp/a0s6/supervisor
git -C /tmp/a0s6/supervisor checkout --detach 409bd889289fa3601977411747e0aaccf9a73332
(cd /tmp/a0s6/supervisor; npm ci --ignore-scripts > /tmp/a0s6/install.log 2>&1; npm run build > /tmp/a0s6/build.log 2>&1)
git clone /tmp/a0s6/base.bundle "$R/workspace"
git -C "$R/workspace" switch -c fix/issue-1 409bd889289fa3601977411747e0aaccf9a73332
git -C "$R/workspace" config user.name 'A0 worker'
git -C "$R/workspace" config user.email a0@example.invalid
# VM-local provider only. No GitHub credentials or host auth are transferred.
for file in auth.json models-store.json exe-dev-llm-integration.json; do
  if [ -f "/home/exedev/.pi/agent/$file" ]; then cp "/home/exedev/.pi/agent/$file" "$R/profile/$file"; chmod 600 "$R/profile/$file"; fi
done
cp -a /home/exedev/.pi/agent/extensions/exe-dev "$R/profile/extensions/"
cp -a /tmp/a0s4fix/installed/node_modules "$R/profile/npm/"
cp -a /home/exedev/.pi/agent/npm/node_modules/pi-herdr-pstack "$R/profile/npm/node_modules/"
printf '{"packages":[],"enableSkillCommands":true}\n' > "$R/profile/settings.json"
# No terminal fallback: record and refuse any terminal executable.
for command in herdr hc herdr-core; do
  printf '#!/bin/sh\nprintf "%%s\\n" "%s" >> "%s/terminal-calls"\nexit 97\n' "$command" "$R" > "$R/bin/$command"
  chmod 700 "$R/bin/$command"
done
# Kernel preflight of the existing profile's Git limitation, not a weaker sandbox.
git -C "$R/workspace" worktree add --detach --lock --reason 'slice6 sandbox preflight retained' "$R/sandbox-preflight" HEAD
set +e
bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session --cap-drop ALL --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --bind "$R/sandbox-preflight" "$R/sandbox-preflight" --chdir "$R/sandbox-preflight" -- /usr/bin/git status --porcelain > "$R/sandbox-preflight.log" 2>&1
code=$?
set -e
[ "$code" -ne 0 ]
grep -q 'not a git repository' "$R/sandbox-preflight.log"
printf '{"exit_code":%s,"git_admin_directory_outside_root":true,"decision":"cgroup-only for both Git children; sandbox unchanged"}\n' "$code" > "$R/sandbox-preflight.json"
# Isolated grant issued locally by the owner configuration; token never printed.
node --input-type=module -e 'import {GrantStore} from "/tmp/a0s6/supervisor/dist/grants.js";new GrantStore("/tmp/a0s6/run1/state").register("slice6-orchestrator",{worker_ids:[],cwd_roots:["/tmp/a0s6/run1"]},["hello","workers.create","workers.get","workers.list","workers.stop","sessions.prompt","events.subscribe","history.page","receipts.get","children.report"],"orchestrator")'
# Install no global resources and publish no TCP endpoint.
export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
systemd-run --user --unit=a0-s6-supervisor --collect --service-type=exec \
  --setenv=PATH="$R/bin:$PATH" --setenv=TMPDIR="$TMPDIR" --setenv=npm_config_cache="$npm_config_cache" \
  --setenv=A0_STATE_DIR="$R/state" --setenv=A0_PI=/home/exedev/.local/bin/pi \
  --setenv=PI_CODING_AGENT_DIR="$R/profile" --setenv=PI_WORKER_BACKEND=1 \
  --setenv=PI_WORKER_SOCKET="$R/state/worker.sock" --setenv=PI_WORKER_GRANT_FILE="$R/state/grants/orchestrator.json" \
  --setenv=PI_WORKER_WORKTREE_ROOT="$R/worktrees" --setenv=PI_WORKER_TERMINAL_TRAP="$R/terminal-calls" \
  /home/exedev/.local/node/bin/node /tmp/a0s6/supervisor/dist/main.js
