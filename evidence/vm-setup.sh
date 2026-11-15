set -eu
mkdir -p /tmp/a0 "$HOME/.local/bin" "$HOME/.local/node"
cd /tmp/a0
curl -fsSLO https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v22.21.1/SHASUMS256.txt
grep ' node-v22.21.1-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
tar -xJf node-v22.21.1-linux-x64.tar.xz -C "$HOME/.local/node" --strip-components=1
ln -sf "$HOME/.local/node/bin/node" "$HOME/.local/bin/node"
ln -sf "$HOME/.local/node/bin/npm" "$HOME/.local/bin/npm"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
node --version
# Preserve the image's standalone launcher; do not overwrite its provider extension.
if [ -L "$HOME/.local/bin/pi" ]; then mv "$HOME/.local/bin/pi" /tmp/a0/image-pi-symlink; fi
npm i -g @earendil-works/pi-coding-agent@1.5.2
ln -sf "$HOME/.local/node/bin/pi" "$HOME/.local/bin/pi"
pi --version
pi install npm:pi-herdr-agents@3.11.0
pi install npm:pi-herdr-pstack@1.0.0
find "$HOME/.pi/agent" -maxdepth 3 -name '*exe-dev*' -o -name '*integration*'
