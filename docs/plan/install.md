# pi-worker install: release artifact and host install (P4-A)

The interface Shep's host installer (Shep P5-10) codes against. Root fixed it in the P4-A brief; a change to any
numbered section below needs root's sign-off. Upgrade and rollback come in P4 proper: until then a different version
while one is installed is refused (`pi_worker_upgrade_unavailable`).

Linux only (x64, arm64), one install per Linux user, no root at any step. Everything below runs as that user.

## 1. Artifact

Two release assets per architecture:

- `pi-worker-<version>-linux-<arch>.tar.gz`, `<arch>` one of `x64`, `arm64`;
- `pi-worker-<version>-linux-<arch>.tar.gz.sha256`: one line, `<64 hex>  pi-worker-<version>-linux-<arch>.tar.gz`
  (`sha256sum` format).

The tarball has exactly one top directory:

```text
pi-worker-<version>/
  bin/pi-worker      POSIX sh wrapper: refuses a missing or too old node, then execs node on dist/main.js
  dist/              the compiled CLI (entry dist/main.js)
  node_modules/      production dependencies only, from package-lock.json (npm ci --omit=dev --ignore-scripts);
                     @nublai/pi-worker (the daemon) and @nublai/pi-worker-client are compiled copies
  package.json       {"name", "version", "private", "type": "module", "engines": {"node"}}
  release.json       {"version", "commit", "node_engine", "b2_protocol": {"major", "minor"}}
```

- `version` is the release's semver without the `v` (`0.4.0`); `commit` is the 40-hex commit it was built from;
  `node_engine` is the Node floor, `>=X.Y.Z` (today `>=26.12.1`); `b2_protocol` is the B2 protocol `hello` reports.
- Node is **not** bundled: the host needs `node` >= the floor on `PATH`. The wrapper checks it before anything runs
  and refuses with one JSON line on stderr, exit 1:
  `{"error":"node_missing","effect":"no_effect","required":">=26.12.1"}` or
  `{"error":"node_unsupported","effect":"no_effect","required":">=26.12.1","found":"22.19.0"}`.
- Native modules: the production dependency `@earendil-works/pi-tui` ships prebuilt `.node` binaries for several
  platforms (Linux x64 and arm64, macOS, Windows) in its own `native/` directory, and every one of them is in both
  tarballs. npm selects no arch-specific optional dependency today, so the x64 and arm64 tarballs have the same
  contents and differ only in name.
- Built by one script, `harness/release/build.sh <x64|arm64>` (output in `harness/release/out/`, overridable with
  `PIW_RELEASE_OUT`). `.github/workflows/release.yml` runs it for both arches on a `v*` tag and attaches the four
  assets to that tag's GitHub release in `nublai/pi-worker`; CI runs it for x64 on every push and PR and keeps the
  result as a workflow artifact.

## 2. Distribution (Shep's side)

- `nublai/pi-worker` stays private. Shep's release pipeline copies the two assets of a **pinned** pi-worker version
  (per arch) into its own public `nublai/app` release.
- Shep's installer downloads only from its own release directory, checks the tarball against the `.sha256` before
  unpacking anything, and keeps both files side by side for `install --from` (which checks again).

## 3. `pi-worker install --from <tarball> [--wait-ms N]`

The first install has no `pi-worker` on the host yet, so it runs the tarball's own CLI:

```sh
tmp=$(mktemp -d)
tar -xzf pi-worker-<version>-linux-<arch>.tar.gz -C "$tmp"
"$tmp/pi-worker-<version>/bin/pi-worker" install --from "$PWD/pi-worker-<version>-linux-<arch>.tar.gz"
rm -rf "$tmp"
```

What it does, in order (refusals first, before anything is written):

1. Refuses a name other than `pi-worker-<version>-linux-<arch>.tar.gz` (`pi_worker_tarball_name`) or an arch other
   than the host's (`pi_worker_arch_mismatch`).
2. Verifies the tarball against `<tarball>.sha256` next to it: `pi_worker_checksum_missing` or
   `pi_worker_checksum_mismatch`.
3. Reads the installed version from `~/.local/share/pi-worker/current`. Another version installed:
   `pi_worker_upgrade_unavailable` with `installed` and `requested`. The same version: carries on (idempotent).
4. Refuses `~/.local/bin/pi-worker` when it exists and is not a symlink into `~/.local/share/pi-worker`
   (`pi_worker_bin_conflict`), and a home, node, state or socket path a unit file cannot hold literally or that is
   not canonical (`pi_worker_unsafe_path` with `which`: only letters, digits and `._/@+-`, absolute, no empty, `.` or
   `..` component, no trailing `/`), or a state directory that is `/`, HOME or a directory holding HOME.
5. Reads the tarball without writing anything: every member is under `pi-worker-<version>/`, none is absolute or
   has a `.` or `..` component, and its `release.json` names that version (else `pi_worker_tarball_invalid`); a host
   node older than its `node_engine` refuses `pi_worker_node_unsupported`. All of these are exit 1, nothing written.
6. Unpacks to `~/.local/share/pi-worker/versions/<version>/` (through a staging directory, renamed into place; an
   existing directory of that version is kept, and its own `node_engine` is checked). This is the first write. The
   unpacked tree must hold only directories, regular files with one link, and symlinks that resolve inside it, and
   `bin/pi-worker` must be an executable regular file (not a directory, not a link); anything else (a link out of
   the version directory, a hard link, a device, FIFO or socket, or that entry) refuses `pi_worker_tarball_invalid` with **exit 3** (`effect: unknown`): the
   staging directory is removed, but `versions/` may have been created.
7. Points `~/.local/share/pi-worker/current` at `versions/<version>` atomically (a new symlink renamed over the old).
8. Links `~/.local/bin/pi-worker` to `~/.local/share/pi-worker/current/bin/pi-worker`.
9. Writes `~/.config/systemd/user/pi-worker.service` (section 3.1).
10. Registers the local doctor grant (`hello` only) once, bearer in `~/.local/share/pi-worker/doctor.grant.json`
    (0600), which `doctor` and the readiness wait use.
11. `systemctl --user daemon-reload`, then `systemctl --user enable --now pi-worker.service` (and `restart` when the
    unit file changed while it ran).
12. Waits (default 60 s, `--wait-ms`) until `hello` answers on the socket with this version.
13. Prints one JSON line on stdout:

    ```json
    {"version":"0.4.0","socket":"/run/user/1000/pi-worker/b2.sock","unit":"pi-worker.service","restarted":false}
    ```

    `restarted` is `true` exactly when step 11 ran `systemctl --user restart`: the same version was installed
    again, the unit file install writes differed from the one on disk (or was new to an active unit), and the unit
    was `active` before `enable --now`. A restart stops the daemon and every worker with it. It is `false` on a first
    install (the unit is only started), when the unit file is unchanged, and when the unit was not active (it is just
    started). Upgrade policy comes in P4 proper.

Never calls `sudo`. With user lingering off the install still works (the unit runs while the user has a session), and
`doctor` reports `linger` failed; enabling it (`loginctl enable-linger <user>`) is the host installer's job.

Failures print one JSON object on stderr like every CLI command: `{"error": <typed name>, "effect", ...}`. **Parse
the last stderr line**: the wrapper sets `NODE_NO_WARNINGS=1` (and the unit has `Environment=NODE_NO_WARNINGS=1`), so
Node prints no warning ahead of or after it, and the CLI writes the error as the last thing it prints. Real errors are
not warnings and still print. (`logs` passes `journalctl`'s own stderr and exit status through; `doctor` reports its
failure on stdout and exit 1.) Exit 1
(`effect: no_effect`) is a refusal before anything was written. Exit 3 (`effect: unknown`) is a failure after
something was written (`pi_worker_tarball_invalid` from step 6, `pi_worker_systemctl_failed` with the `step`,
`pi_worker_not_ready`): run `install` again with the same tarball (idempotent) or `uninstall`.

### 3.1 The unit

```ini
[Unit]
Description=pi-worker supervisor (nubl)
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
ExecStart=<home>/.local/share/pi-worker/current/bin/pi-worker daemon
Delegate=yes
Restart=on-failure
RestartSec=2
TimeoutStopSec=30
UMask=0077
Environment=PATH=<dir of the node that ran install>:/usr/local/bin:/usr/bin:/bin
Environment=PIW_STATE_DIR=<state dir>
Environment=PIW_SOCKET=<socket>
Environment=NODE_NO_WARNINGS=1
StandardOutput=null
StandardError=journal

[Install]
WantedBy=default.target
```

- **Delegation**, as the kernel tier (`harness/ci/kernel.sh`) uses it: `Delegate=yes`, and `pi-worker daemon` first
  moves itself into the unit cgroup's `supervisor` leaf, then uses the unit cgroup as its delegation
  (`PIW_CGROUP_ROOT`), so each worker's cleanup domain is a sibling of that leaf. `daemon` refuses to start anywhere but the
  cgroup of a `pi-worker.service` unit it can write (`no_service_delegation`). Stopping the unit kills every worker with it.
- **Paths are pinned** at install: the state directory and socket are what the installing user's environment resolves
  (state `PIW_STATE_DIR`, else `$XDG_STATE_HOME/pi-worker`, else `~/.local/state/pi-worker`; socket `PIW_SOCKET`,
  else `$XDG_RUNTIME_DIR/pi-worker/b2.sock`, `XDG_RUNTIME_DIR` defaulting to `/run/user/<uid>`), so the daemon and
  later `grant` commands agree.
- **The pin is the rule for local state commands.** While the unit file is installed, the local `grant` commands
  (`register`, `revoke`, `list`) use the unit's `PIW_STATE_DIR`, whatever the caller's shell sets, so a grant is
  registered where the daemon reads it. A caller whose environment names a different state directory (`PIW_STATE_DIR`,
  else `XDG_STATE_HOME/pi-worker`, compared as an absolute path, so a trailing `/` does not matter and a relative one never matches)
  is refused `pi_worker_state_mismatch` (exit 1, `effect: no_effect`, with `pinned` and `requested`) before the grant
  command runs: nothing is read, created or written, no bearer file. A caller that names none, or the pinned one,
  is served from the pin. A pin that is not canonical (section 3 step 4; only a hand-edited unit has one) is refused
  `pi_worker_unsafe_path` with `which: state`. With no unit file installed (never installed, or uninstalled), or one
  without a `PIW_STATE_DIR` line, the caller's own environment resolves the state directory as the daemon would.
  `doctor`, `version` and `logs` never read or write the state directory (`doctor` and `version` use the pinned
  socket, section 4); `uninstall --purge` removes the pinned state directory (section 6), whatever the caller's
  environment names; only `install` sets the pin.
- **Logs:** the supervisor writes only typed JSON events to stderr (journal) and nothing to stdout; pi's own output
  stays inside the supervisor. No prompt or answer text is logged.

### 3.2 `pi-worker version [--json]`

Prints one JSON line (`--json` is accepted; the output is always this line) and works without the daemon:

```json
{"version":"0.4.0","commit":"<40 hex>","b2_protocol":{"major":0,"minor":1},"daemon_version":"0.4.0"}
```

`version`, `commit` and `b2_protocol` are the `release.json` of the installed `current`. `daemon_version` is the
`worker_version` the daemon's `hello` answers (with the doctor grant, on the pinned socket, 3 s), or `null` when it
does not answer. Nothing installed refuses `pi_worker_not_installed` (exit 1, `effect: no_effect`, nothing on
stdout); a `current` whose `release.json` is missing or lacks those fields refuses `pi_worker_release_unreadable`.

## 4. `pi-worker doctor [--json]`

Checks, each with a stable id, in this order:

| id | passes when |
| --- | --- |
| `node_version` | the node running doctor meets the installed release's `node_engine` |
| `bwrap_usable` | `bwrap` on `PATH` runs a command in a new user and pid namespace |
| `cgroup_delegation` | cgroup v2 is mounted, the unit has `Delegate=yes`, and its cgroup (or, while it is stopped, the user manager's) offers `memory` and `pids` with `cgroup.kill` |
| `unit_active` | `systemctl --user is-active pi-worker.service` is `active` |
| `socket_reachable` | the pinned socket accepts a connection |
| `hello` | `hello` answers with the doctor grant (detail: worker version and protocol) |
| `linger` | `loginctl show-user <user> --property=Linger` is `yes` |

Exit 0 only when every check passes, else 1. Text output is one line per check; `--json` prints
`{"ok": bool, "checks": [{"id", "ok", "detail"}]}`.

## 5. `pi-worker logs [-f]`

Runs `journalctl --user -u pi-worker.service --no-pager` (`-f` follows) and exits with its status.

## 6. `pi-worker uninstall [--purge]`

Stops and disables the unit, removes the unit file (then `daemon-reload`), `~/.local/bin/pi-worker` and
`~/.local/share/pi-worker/current`. Keeps the state directory and `versions/` (so the same or another version can be
installed again, and the state, grants included, carries over). `--purge` also removes only what install and the
daemon created: `~/.local/share/pi-worker/versions` and the doctor grant (then `~/.local/share/pi-worker` itself when
nothing else is in it), the pinned state directory, and the socket's `pi-worker` directory (a socket configured
elsewhere loses only its file). Before anything is stopped or removed it checks every one of them, and refuses
`pi_worker_unsafe_path` (exit 1, `which`: `state`, `socket` or `data`, nothing removed) when a pinned path is not
canonical (section 3 step 4), the state or socket directory is `/`, HOME or holds HOME, or a path that exists is not
a real directory (the socket: a socket) owned by the user: a symlink is never followed or removed in its place.
The state directory, when it exists, is removed whole only when it is pi-worker's: it holds pi-worker's marker (a
`journal.jsonl` whose start record names an installation id, or `grants/<id>.json` for this install's doctor grant)
and, at its top, nothing but what the daemon and `grant` write: `journal.jsonl`, `journal.jsonl.compact`,
`journal.lock` and `journal.lock-journal` (the lock's SQLite journal while the supervisor runs) as files, `grants/`,
`sessions/`, `attachments/` and `git-snapshots/` as directories. Otherwise, an empty directory included, it refuses
`pi_worker_unsafe_path` with `which: state`; neither the path nor its owner counts as evidence. A state left by a
partial install with neither marker is the owner's to remove by hand.
Prints `{"uninstalled": true, "purged": bool}`. Running it with nothing installed succeeds.

## 7. What Shep's installer runs after install

```sh
# 1. Install (section 3); stdout is one JSON line. Read the socket from it.
out=$("$tmp/pi-worker-$v/bin/pi-worker" install --from "$dir/pi-worker-$v-linux-$arch.tar.gz")
socket=$(printf '%s' "$out" | jq -r .socket)     # default /run/user/<uid>/pi-worker/b2.sock

# 2. Register the bridge's grant with the existing local grant command (never over HTTP). The bearer goes only to
#    --out, a new 0600 file; stdout carries {grant_id, caller, bearer_file}, never the bearer.
~/.local/bin/pi-worker grant register --caller shep-bridge --out "$bridge_grant_file" \
  --method '*' --worker '*' --cwd-root "$projects_root" --answers-for-person

# 3. Check the host, and fail the install loudly on anything but exit 0.
~/.local/bin/pi-worker doctor --json
```

- Run `grant register` as the same user as `install`. It needs no state environment: it uses the state directory the
  installed unit pins (section 3.1), so a shell without the installing `PIW_STATE_DIR`/`XDG_STATE_HOME` still reaches
  the daemon's grants. A shell that sets a different one is refused `pi_worker_state_mismatch` (exit 1, `no_effect`,
  nothing written): unset it or pass the pinned one. The daemon rereads grants on every request, so no restart is
  needed. `grant revoke <id>` withdraws it, `grant list` lists the pinned registry.
  Like `install`, the local `grant` commands need neither `XDG_RUNTIME_DIR` nor `PIW_SOCKET` (the runtime directory
  defaults to `/run/user/<uid>`); B2 calls such as `hello` take the socket from `--socket`, `PIW_SOCKET` or
  `XDG_RUNTIME_DIR`.
- The bridge connects to `socket` with the bearer from `$bridge_grant_file` (`PIW_GRANT_FILE`, or the Go client's
  grant file option). The socket is 0600 in a 0700 directory; for a bridge running as another user, the unit would
  need `PIW_SOCKET_GROUP` (not in this release).
- Host prerequisites the installer provides before step 1: Node >= `node_engine` on `PATH`, `bubblewrap`,
  unprivileged user namespaces (Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0` or a bwrap AppArmor
  profile), a systemd user manager with cgroup v2, and `loginctl enable-linger <user>` (these need root once).
