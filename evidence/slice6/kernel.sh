#!/bin/bash
# Authored verification runner. Only test-owned user services/cgroups.
set -euo pipefail
export PATH=/home/exedev/.local/node/bin:/usr/bin:/bin
export TMPDIR=/tmp/a0s6/tmp npm_config_cache=/tmp/a0s6/verify-cache
A0_TEST_CGROUP_DIR="/sys/fs/cgroup$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)"
export A0_TEST_CGROUP_DIR
export A0_TEST_BWRAP=1
cd "${A0_VERIFY_HEAD:-/tmp/a0s6/verify/head}"
npm test
