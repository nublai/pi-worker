#!/bin/bash
# Authored continuation boundary: provision once, register once, then start.
set -euo pipefail
[ "$(hostname)" = a0-worker ]
umask 077
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:/usr/bin:/bin"
export TMPDIR=/tmp/a0s7/tmp npm_config_cache=/tmp/a0s7/npm-cache
R="$A0_S7_RUN"
[ "$(git -C "$R/workspace" rev-parse HEAD)" = "$A0_S7_COMMIT" ]
node --input-type=module -e 'import {GrantStore} from "/tmp/a0s7/runtime/dist/grants.js";new GrantStore(process.env.A0_S7_RUN+"/state").register("slice7-owner",{worker_ids:[],cwd_roots:[process.env.A0_S7_RUN+"/workspace"]},["hello","workers.create","workers.get","workers.list","workers.stop","sessions.prompt","events.subscribe","history.page","receipts.get","children.report"],"orchestrator")'
export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
systemd-run --user --unit=a0-s7-supervisor --collect --service-type=exec \
  --setenv=PATH="$PATH" --setenv=TMPDIR="$TMPDIR" --setenv=npm_config_cache="$npm_config_cache" \
  --setenv=A0_STATE_DIR="$R/state" --setenv=A0_PI="$HOME/.local/bin/pi" \
  /home/exedev/.local/node/bin/node /tmp/a0s7/runtime/dist/main.js
