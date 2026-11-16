#!/usr/bin/env bash
# Runs ON the test VM, from the repository cloned out of the git bundle (harness/run.sh does that). Installs the
# exact runtimes user-locally, builds, runs the default and kernel suites, and writes $PIW_RUN_DIR/platform.json.
# Every download is checked: Node against SHASUMS256.txt and that file's GPG signature (Node release keys), Go
# against the SHA-256 that go.dev publishes. Nothing here reads a credential.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
run=${PIW_RUN_DIR:?PIW_RUN_DIR}
mkdir -p "$run"
tools="$HOME/.local/piw-tools"
mkdir -p "$tools"
node_version=$(cat "$repo/.node-version")
go_version=1.24.13 # the Go client's CI floor (plan 4.4)
arch=$(uname -m)
case "$arch" in x86_64) narch=x64 garch=amd64 ;; aarch64) narch=arm64 garch=arm64 ;; *) echo "setup: unsupported $arch" >&2; exit 1 ;; esac
step() { echo "setup: $*"; }

step "host packages (bubblewrap, gpgv, build tools)"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap gpgv curl xz-utils git build-essential >/dev/null
if sysctl -n kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then
  sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0
fi
sudo loginctl enable-linger "$(id -un)"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
for _ in $(seq 1 100); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 0.1; done

node_dir="$tools/node-v$node_version-linux-$narch"
if [ ! -x "$node_dir/bin/node" ]; then
  step "Node $node_version (SHASUMS256.txt, its signature, then the tarball hash)"
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
  tar -xJf "$tmp/$tarball" -C "$tools"
  rm -rf "$tmp"
fi
go_dir="$tools/go$go_version"
if [ ! -x "$go_dir/bin/go" ]; then
  step "Go $go_version (SHA-256 from go.dev)"
  tmp=$(mktemp -d)
  tarball="go$go_version.linux-$garch.tar.gz"
  want=$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' |
    "$node_dir/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s).flatMap(r=>r.files).find(f=>f.filename===process.argv[1]);process.stdout.write(f?f.sha256:"")})' "$tarball")
  [ -n "$want" ] || { echo "setup: go.dev lists no $tarball" >&2; exit 1; }
  curl -fsSL -o "$tmp/$tarball" "https://go.dev/dl/$tarball"
  echo "$want  $tmp/$tarball" | sha256sum -c --quiet -
  mkdir -p "$go_dir" && tar -xzf "$tmp/$tarball" -C "$go_dir" --strip-components=1
  rm -rf "$tmp"
fi
export PATH="$node_dir/bin:$go_dir/bin:$PATH" GOTOOLCHAIN=local
unset GOROOT

cd "$repo"
step "npm ci, build"
npm ci --ignore-scripts >"$run/npm-ci.log" 2>&1
npm run build >"$run/build.log" 2>&1
step "default suite (worker, client)"
npm test >"$run/default-suite.log" 2>&1
step "Go client on Go $go_version: vet, race tests, integration, stdlib gate"
(cd clients/go && go vet ./... && go test -race -count=1 ./... && go test -tags integration -count=1 ./... && ./stdlib-gate.sh) >"$run/go-suite.log" 2>&1
step "kernel suite"
harness/ci/kernel.sh >"$run/kernel-suite.log" 2>&1

cg_root="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service"
node - "$run/platform.json" <<EOF
const fs = require('node:fs');
const platform = {
  kernel: '$(uname -r)',
  os: $(. /etc/os-release && printf '%s' "\"$PRETTY_NAME\""),
  arch: '$arch',
  node: process.version,
  go: '$(go env GOVERSION)',
  git: '$(git --version | awk '{print $3}')',
  bwrap: '$(bwrap --version | awk '{print $2}')',
  systemd: '$(systemctl --version | head -1 | awk '{print $2}')',
  user_manager_controllers: '$(cat "$cg_root/cgroup.controllers" 2>/dev/null)',
  apparmor_restrict_unprivileged_userns: '$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)',
  pi: null,
};
fs.writeFileSync(process.argv[2], JSON.stringify(platform, null, 2) + '\n');
EOF
step "done"
