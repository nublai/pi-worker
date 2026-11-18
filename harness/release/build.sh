#!/usr/bin/env bash
# Builds the release artifact (docs/plan/install.md section 1) from the committed HEAD:
#   harness/release/build.sh <x64|arm64>
# writes pi-worker-<version>-linux-<arch>.tar.gz and its .sha256 to $PIW_RELEASE_OUT (default harness/release/out).
# Version: $PIW_RELEASE_VERSION (the release workflow passes the tag without its v), else an exact v* tag on HEAD,
# else 0.0.0-dev.<short commit>. Steps, in a scratch copy of HEAD (git archive): npm ci --ignore-scripts and build;
# then npm ci --omit=dev --ignore-scripts for the target arch (lockfile-pinned production dependencies only); then the
# tree is assembled, packed reproducibly (sorted, numeric owner 0, commit time) and, on a matching host arch, the
# packed wrapper is run once (--help) as a smoke check. Needs git, node and npm (the repo's .node-version), tar, gzip.
set -euo pipefail
arch=${1:-}
case "$arch" in x64 | arm64) ;; *) echo "build: usage: build.sh <x64|arm64>" >&2; exit 2 ;; esac
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
out=${PIW_RELEASE_OUT:-$repo/harness/release/out}
commit=$(git rev-parse HEAD)
[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "build: warning: tracked changes are not in the artifact; it is built from HEAD $commit" >&2

version=${PIW_RELEASE_VERSION:-}
if [ -z "$version" ]; then
  tag=$(git tag --points-at HEAD --list 'v*' | head -1)
  version=${tag#v}
fi
[ -n "$version" ] || version="0.0.0-dev.$(git rev-parse --short=12 HEAD)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "build: version $version is not X.Y.Z[-pre]" >&2; exit 2; }
engine=$(node -p 'require("./package.json").engines.node')
[[ "$engine" =~ ^\>=[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "build: engines.node $engine is not >=X.Y.Z" >&2; exit 2; }
case "$arch" in x64) cpu=x64 ;; arm64) cpu=arm64 ;; esac

name="pi-worker-$version-linux-$arch"
top="pi-worker-$version"
work=$(mktemp -d "${TMPDIR:-/tmp}/piw-release.XXXXXX")
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
src="$work/src"
stage="$work/stage/$top"
mkdir -p "$src" "$stage/bin"

echo "build: $name from $commit"
git archive --format=tar HEAD | tar -x -C "$src"
(
  cd "$src"
  npm ci --ignore-scripts --no-audit --no-fund >"$work/npm-ci.log" 2>&1 || { cat "$work/npm-ci.log" >&2; exit 1; }
  npm run build -w @nublai/pi-worker-client -w @nublai/pi-worker -w @nublai/pi-worker-cli >"$work/build.log" 2>&1 || { cat "$work/build.log" >&2; exit 1; }
  rm -rf node_modules packages/*/node_modules
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu="$cpu" >"$work/npm-ci-prod.log" 2>&1 || { cat "$work/npm-ci-prod.log" >&2; exit 1; }
)

protocol=$(cd "$src/packages/worker" && node --input-type=module -e 'const { PROTOCOL } = await import("./dist/src/b2/hello.js"); process.stdout.write(JSON.stringify(PROTOCOL))')

# Production node_modules; the workspace links become compiled copies (package.json and dist/src only).
cp -a "$src/node_modules" "$stage/node_modules"
for pkg in client-ts:pi-worker-client worker:pi-worker; do
  dir=${pkg%%:*} npm_name=${pkg#*:}
  dest="$stage/node_modules/@nublai/$npm_name"
  rm -rf "$dest"
  mkdir -p "$dest/dist"
  cp -a "$src/packages/$dir/package.json" "$dest/"
  cp -a "$src/packages/$dir/dist/src" "$dest/dist/src"
  [ ! -d "$src/packages/$dir/node_modules" ] || cp -a "$src/packages/$dir/node_modules" "$dest/node_modules"
done
rm -rf "$stage/node_modules/@nublai/pi-worker-cli"
[ ! -d "$src/packages/cli/node_modules" ] || { echo "build: packages/cli has nested node_modules; resolve them into the top level" >&2; exit 1; }
# The CLI is the top-level dist (dist/main.js); its imports resolve through the top-level node_modules.
cp -a "$src/packages/cli/dist/src" "$stage/dist"
find "$stage/dist" "$stage/node_modules/@nublai" -name '*.map' -delete
# hello reports the worker package's version: the release's.
VERSION="$version" ENGINE="$engine" COMMIT="$commit" PROTOCOL="$protocol" STAGE="$stage" node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const { VERSION, ENGINE, COMMIT, PROTOCOL, STAGE } = process.env;
for (const pkg of ["pi-worker", "pi-worker-client"]) {
  const file = `${STAGE}/node_modules/@nublai/${pkg}/package.json`;
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = VERSION;
  if (json.dependencies?.["@nublai/pi-worker-client"]) json.dependencies["@nublai/pi-worker-client"] = VERSION;
  delete json.devDependencies;
  delete json.scripts;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
const write = (name, value) => writeFileSync(`${STAGE}/${name}`, JSON.stringify(value, null, 2) + "\n");
write("package.json", { name: "pi-worker", version: VERSION, private: true, license: "MIT", type: "module", engines: { node: ENGINE } });
write("release.json", { version: VERSION, commit: COMMIT, node_engine: ENGINE, b2_protocol: JSON.parse(PROTOCOL) });
'
sed "s/@NODE_FLOOR@/${engine#>=}/" "$repo/harness/release/pi-worker.sh" >"$stage/bin/pi-worker"
chmod 0755 "$stage/bin/pi-worker"
cp "$src/LICENSE" "$stage/LICENSE"

mkdir -p "$out"
mtime=$(git show -s --format=%ct HEAD)
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$mtime" --mode='u+rwX,go+rX,go-w' -C "$work/stage" -cf - "$top" | gzip -9n >"$out/$name.tar.gz"
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")

host=$(uname -m)
if { [ "$arch" = x64 ] && [ "$host" = x86_64 ]; } || { [ "$arch" = arm64 ] && [ "$host" = aarch64 ]; }; then
  check="$work/check"
  mkdir -p "$check"
  tar -xzf "$out/$name.tar.gz" -C "$check"
  "$check/$top/bin/pi-worker" --help >/dev/null || { echo "build: the packed bin/pi-worker --help failed" >&2; exit 1; }
  "$check/$top/bin/pi-worker" grant --help >/dev/null
  node --input-type=module -e "await import('$check/$top/node_modules/@nublai/pi-worker/dist/src/service.js')"
fi
echo "build: $out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1)); sha256 $(cut -d' ' -f1 "$out/$name.tar.gz.sha256")"
