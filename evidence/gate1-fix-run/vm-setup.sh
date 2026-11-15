#!/bin/bash
# Task-owned setup (gate1 fix-round rerun; gate1-rerun harness with /tmp/a0g1b and a0-g1b-* names), only the existing a0-worker; no source-supplied installer.
set -euo pipefail
[ "$(hostname)" = a0-worker ]
umask 077
export PATH="$HOME/.local/node26/bin:$HOME/.local/bin:/usr/bin:/bin"
export TMPDIR=/tmp/a0g1b/tmp npm_config_cache=/tmp/a0g1b/npm-cache
R="${A0_G1_RUN:-/tmp/a0g1b/run}"
mkdir -p "$TMPDIR" "$R/state"
if [ ! -e /tmp/a0g1b/runtime ]; then
  git clone /tmp/a0g1b/runtime.bundle /tmp/a0g1b/runtime
else
  git -C /tmp/a0g1b/runtime fetch /tmp/a0g1b/runtime.bundle refs/heads/a0/gate1-rerun
fi
git -C /tmp/a0g1b/runtime checkout --detach "$A0_G1_COMMIT"
(cd /tmp/a0g1b/runtime; npm ci --ignore-scripts > /tmp/a0g1b/install.log 2>&1; npm run build > /tmp/a0g1b/build.log 2>&1)
git clone /tmp/a0g1b/runtime.bundle "$R/workspace"
git -C "$R/workspace" switch -c job/gate1 "$A0_G1_COMMIT"
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
export A0_G1_RUN="$R"
node --input-type=module -e 'import {GrantStore} from "/tmp/a0g1b/runtime/dist/grants.js";new GrantStore(process.env.A0_G1_RUN+"/state").register("gate1-owner",{worker_ids:[],cwd_roots:[process.env.A0_G1_RUN+"/workspace"]},["hello","workers.create","workers.get","workers.list","workers.stop","sessions.prompt","events.subscribe","history.page","receipts.get","children.report"],"orchestrator")'
export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
systemd-run --user --unit=a0-g1b-supervisor --collect --service-type=exec \
  --setenv=PATH="$PATH" --setenv=TMPDIR="$TMPDIR" --setenv=npm_config_cache="$npm_config_cache" \
  --setenv=A0_STATE_DIR="$R/state" --setenv=A0_PI="$HOME/.local/bin/pi" \
  /home/exedev/.local/node26/bin/node /tmp/a0g1b/runtime/dist/main.js
