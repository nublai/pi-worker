#!/bin/bash
# Task-owned kernel suite runner, invoked under a transient delegated user service.
set -euo pipefail
cd "$A0_G1_REPO"
export A0_TEST_CGROUP_DIR="/sys/fs/cgroup$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)"
export A0_TEST_BWRAP=1
npm test
