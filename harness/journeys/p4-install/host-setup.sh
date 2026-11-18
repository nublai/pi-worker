#!/usr/bin/env bash
# p4-install host prerequisites, run ON a fresh exe.dev tester VM before the journey (docs/plan/install.md section 7):
# what a host installer provides once, as root, before `pi-worker install`. Never part of install itself.
#   host-setup.sh <node-version> <run-dir>
# - bubblewrap, and unprivileged user namespaces (Ubuntu 24.04's AppArmor restriction off);
# - linger for this user, so the user manager (and the unit) outlives SSH sessions;
# - Node <node-version> in /usr/local from the official tarball: SHASUMS256.txt checked against its GPG signature
#   (Node release keys), then the tarball against SHASUMS256.txt.
# Writes <run-dir>/platform.json. Reads no credential.
set -euo pipefail
node_version=${1:?node version}
run=${2:?run dir}
mkdir -p "$run"
case "$(uname -m)" in x86_64) narch=x64 ;; aarch64) narch=arm64 ;; *) echo "setup: unsupported $(uname -m)" >&2; exit 1 ;; esac
step() { echo "setup: $*"; }

step "packages: bubblewrap, gpgv, curl, xz-utils"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap gpgv curl xz-utils >/dev/null
if sysctl -n kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then
  sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0
fi
step "linger for $(id -un)"
sudo loginctl enable-linger "$(id -un)"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
for _ in $(seq 1 100); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 0.1; done

if [ "$(node -p process.versions.node 2>/dev/null || true)" != "$node_version" ]; then
  step "Node $node_version into /usr/local (signature, then hash)"
  tmp=$(mktemp -d)
  base="https://nodejs.org/dist/v$node_version"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  curl -fsSL -o "$tmp/SHASUMS256.txt.sig" "$base/SHASUMS256.txt.sig"
  curl -fsSL -o "$tmp/pubring.kbx" https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx
  gpgv --keyring "$tmp/pubring.kbx" "$tmp/SHASUMS256.txt.sig" "$tmp/SHASUMS256.txt" 2>"$tmp/gpgv.log" ||
    { cat "$tmp/gpgv.log" >&2; echo "setup: SHASUMS256.txt signature check failed" >&2; exit 1; }
  tarball="node-v$node_version-linux-$narch.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "$base/$tarball"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -)
  sudo tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi

cg_root="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service"
node - "$run/platform.json" <<EOF
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  kernel: '$(uname -r)',
  os: $(. /etc/os-release && printf '%s' "\"$PRETTY_NAME\""),
  arch: '$(uname -m)',
  node: process.version,
  node_path: process.execPath,
  bwrap: '$(bwrap --version | awk '{print $2}')',
  systemd: '$(systemctl --version | head -1 | awk '{print $2}')',
  user_manager_controllers: '$(cat "$cg_root/cgroup.controllers" 2>/dev/null)',
  apparmor_restrict_unprivileged_userns: '$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)',
}, null, 2) + '\n');
EOF
step done
