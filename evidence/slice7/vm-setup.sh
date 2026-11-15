#!/bin/bash
# Task-owned setup, only the existing a0-worker; no source-supplied installer.
set -euo pipefail
[ "$(hostname)" = a0-worker ]
umask 077
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:/usr/bin:/bin"
export TMPDIR=/tmp/a0s7/tmp npm_config_cache=/tmp/a0s7/npm-cache
R="${A0_S7_RUN:-/tmp/a0s7/run}"
mkdir -p "$TMPDIR" "$R/state"
if [ ! -e /tmp/a0s7/runtime ]; then
  git clone /tmp/a0s7/runtime.bundle /tmp/a0s7/runtime
else
  git -C /tmp/a0s7/runtime fetch /tmp/a0s7/runtime.bundle HEAD
fi
git -C /tmp/a0s7/runtime checkout --detach "$A0_S7_COMMIT"
(cd /tmp/a0s7/runtime; npm ci --ignore-scripts > /tmp/a0s7/install.log 2>&1; npm run build > /tmp/a0s7/build.log 2>&1)
git clone /tmp/a0s7/runtime.bundle "$R/workspace"
git -C "$R/workspace" switch -c job/slice7 "$A0_S7_COMMIT"
git -C "$R/workspace" config user.name 'A0 worker'
git -C "$R/workspace" config user.email a0@example.invalid
printf '\n.a0-agent/\n.a0-worker/\n.a0-worktrees/\n.a0-bin/\n.a0-terminal-calls\n' >> "$R/workspace/.git/info/exclude"
P="$R/workspace/.a0-agent"
mkdir -p "$P/extensions" "$P/npm" "$R/workspace/.a0-bin"
# One VM-local credential-bearing store. No host auth, GitHub credential or
# full host profile is copied. Values are never printed or exported.
cp "$HOME/.pi/agent/models-store.json" "$P/models-store.json"
cp "$HOME/.pi/agent/exe-dev-llm-integration.json" "$P/exe-dev-llm-integration.json"
chmod 400 "$P/models-store.json"
cp -a "$HOME/.pi/agent/extensions/exe-dev" "$P/extensions/"
cp -a /tmp/a0s4fix/installed/node_modules "$P/npm/"
cp -a "$HOME/.pi/agent/npm/node_modules/pi-herdr-pstack" "$P/npm/node_modules/"
printf '{"packages":[],"enableSkillCommands":true}\n' > "$P/settings.json"
# exe.dev's provider checks /exe.dev before registering. In this private probe
# copy only, remove that existence guard; do not mount the VM metadata directory.
python3 - "$P/extensions/exe-dev/index.ts" <<'PY'
import pathlib
import sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
anchor = 'if (!existsSync("/exe.dev")) return;'
if anchor not in s:
    anchor = "if (!existsSync('/exe.dev')) return;"
if s.count(anchor) != 1:
    raise SystemExit('provider existence guard differs; inspect source before adapting')
p.write_text(s.replace(anchor, '/* A0 isolated VM profile: hostname checked by setup. */'))
PY
for command in herdr hc herdr-core; do
  printf '#!/bin/sh\nprintf "%%s\\n" "%s" >> "%s/.a0-terminal-calls"\nexit 97\n' "$command" "$R/workspace" > "$R/workspace/.a0-bin/$command"
  chmod 700 "$R/workspace/.a0-bin/$command"
done
export A0_S7_RUN="$R"
node --input-type=module -e 'import {GrantStore} from "/tmp/a0s7/runtime/dist/grants.js";new GrantStore(process.env.A0_S7_RUN+"/state").register("slice7-owner",{worker_ids:[],cwd_roots:[process.env.A0_S7_RUN+"/workspace"]},["hello","workers.create","workers.get","workers.list","workers.stop","sessions.prompt","events.subscribe","history.page","receipts.get","children.report"],"orchestrator")'
export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
systemd-run --user --unit=a0-s7-supervisor --collect --service-type=exec \
  --setenv=PATH="$PATH" --setenv=TMPDIR="$TMPDIR" --setenv=npm_config_cache="$npm_config_cache" \
  --setenv=A0_STATE_DIR="$R/state" --setenv=A0_PI="$HOME/.local/bin/pi" \
  /home/exedev/.local/node/bin/node /tmp/a0s7/runtime/dist/main.js
