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
   `..` component, no trailing `/`), or a state directory that is `/`, HOME or a directory holding HOME. With a unit
   file installed, it decides the pin only after systemd has read the current unit file and drop-ins: when they
   changed since systemd read them (`NeedDaemonReload=yes`) it runs `systemctl --user daemon-reload` first (nothing
   else is changed by it; its failure is `pi_worker_systemctl_failed`, `step: daemon-reload`, exit 3), then resolves
   the pin as `grant` does (section 3.1, every refusal there applies, an owner override of `PIW_STATE_DIR` or
   `PIW_SOCKET` included: `pi_worker_unit_overridden`, exit 1, `no_effect`, nothing written). A state directory other
   than the one systemd runs the unit with is refused `pi_worker_state_mismatch` with `pinned` and `requested`, also when the installing
   shell names none and so resolves the default. With no pin (no unit file, or one systemd has not loaded, after an
   `uninstall` that kept the state), the doctor grant an earlier
   install left in `~/.local/share/pi-worker/doctor.grant.json` names that install's state: when its record is not
   in the requested state directory, the request is refused `pi_worker_state_mismatch` with `requested` and `detail`;
   the same directory completes the install (the doctor grant is kept). Install never moves a state directory; there
   is no migration. To change it, `uninstall --purge` (which deletes the state systemd runs the unit with and every
   grant in it, section 6), then install. (A grant record an interrupted `grant` command wrote without its bearer file
   leaves no such evidence.)
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
10. `systemctl --user daemon-reload`, then resolves the unit again as systemd now has it (section 3.1) and checks that
    it runs with the state directory and socket install wrote. A drop-in the owner kept or added since that sets
    `PIW_STATE_DIR` or `PIW_SOCKET` is refused `pi_worker_unit_overridden` (the variable named, never its value; exit 3,
    `effect: unknown`, because the unit file is written), before the doctor grant is registered and before the unit is
    enabled or restarted. Remove the override and run `install` again.
11. Registers the local doctor grant (`hello` only) once, bearer in `~/.local/share/pi-worker/doctor.grant.json`
    (0600), which `doctor` and the readiness wait use, then `systemctl --user enable --now pi-worker.service` (and
    `restart` when the unit file changed while it ran).
12. Waits (default 60 s, `--wait-ms`) until `hello` answers, on the socket systemd runs the unit with, with this version.
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
- **pi-worker owns `PIW_STATE_DIR` and `PIW_SOCKET`.** The owner may not override either, by a drop-in
  (`~/.config/systemd/user/pi-worker.service.d/*.conf`, or any other drop-in systemd loads for the unit), an
  `EnvironmentFile=` or an `UnsetEnvironment=` in one; the paths are pinned at install and only a new install, from
  the installing environment, changes the socket. The resolver refuses `pi_worker_unit_overridden` (`effect:
  no_effect`; `variable` names `PIW_STATE_DIR`, `PIW_SOCKET`, or both for an `EnvironmentFile=`; no value is ever in the
  error) whenever a drop-in file names either variable, the unit has an `EnvironmentFile=`, or the effective value of
  either is not the one pi-worker's own unit file sets. Other owner drop-ins (limits, other `Environment=` variables)
  are allowed and never touched.
- **The pin is the rule for local state commands.** While the unit file `~/.config/systemd/user/pi-worker.service`
  exists, the local `grant` commands (`register`, `revoke`, `list`) use the `PIW_STATE_DIR` systemd runs the unit
  with, whatever the caller's shell sets, so a grant is registered where the daemon reads it. The CLI never parses
  the unit file. One resolver asks the user manager (`systemctl --user show pi-worker.service --property=LoadState
  --property=NeedDaemonReload --property=EnvironmentFiles --property=DropInPaths --property=Environment
  --property=UnsetEnvironment`), reads the drop-ins it lists and the unit file's own `Environment=PIW_STATE_DIR=` and
  `Environment=PIW_SOCKET=` lines, and returns the state directory and socket the unit runs with (always the ones the
  unit file sets), or a refusal. `grant`, `install`
  (section 3 step 4), `uninstall --purge` (section 6), `doctor` and `version` all use it. A caller whose environment names a different state directory
  (`PIW_STATE_DIR`, else `XDG_STATE_HOME/pi-worker`, compared as an absolute path, so a trailing `/` does not matter
  and a relative one never matches) is refused `pi_worker_state_mismatch` (exit 1, `effect: no_effect`, with `pinned`
  and `requested`) before the grant command runs: nothing is read, created or written, no bearer file. A caller that
  names none, or the pinned one, is served from the pin. Every doubt refuses before the grant command runs, never
  falling back to the caller's environment or the default: a HOME that is set but not canonical (a trailing `/`, a
  `.` or `..` component; `pi_worker_unsafe_path` with `which: HOME`, as every host command refuses it), systemd that
  cannot be asked (`pi_worker_systemctl_failed`, `step: show`, `effect: no_effect`), unit files changed since systemd
  read them (`NeedDaemonReload=yes`: an unread drop-in or an edited unit; `pi_worker_unit_reload_pending`, exit 1,
  `effect: no_effect`: run `systemctl --user daemon-reload`; only `install` reloads by itself), and, as
  `pi_worker_unsafe_path` with `which: state`, a unit systemd has not loaded (`LoadState=not-found`) or could not load
  (any state but `loaded`), no `PIW_STATE_DIR` in the
  unit's environment (none set, reset by an empty `Environment=`, or a value with a space or newline, which systemctl
  prints quoted or as `[unprintable]`), several, or one that is not canonical (section 3 step 4). An
  `UnsetEnvironment=` naming `PIW_STATE_DIR` or `PIW_SOCKET` (systemd removes it from the environment last, so
  `Environment` no longer says what the daemon gets) in the unit file refuses `pi_worker_unsafe_path` with `which: state`
  or `which: socket`, and so does `PIW_SOCKET` missing, repeated or not canonical, `which: socket`; in a drop-in it is an
  override (above). A loaded value that differs from the unit file's line, an `EnvironmentFile=` or a drop-in naming
  either variable refuses `pi_worker_unit_overridden`.
  With no unit file (never installed, or uninstalled), or no HOME to find one under, the caller's own environment
  resolves the state directory as the daemon would (without HOME that needs `PIW_STATE_DIR` or `XDG_STATE_HOME`).
  `doctor`, `version` and `logs` never read or write the state directory. `doctor` and `version` hello the socket the
  resolver returns (section 4), or with no unit file the one the caller's environment resolves; when it refuses they
  hello nothing rather than guess: `doctor` fails `socket_reachable` and `hello` with the refusal in `detail`,
  `version` prints `daemon_version: null`. `uninstall --purge` removes the state directory and socket the resolver
  returns (section 6), whatever the caller's environment names; only `install` sets the pin.
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
installed again, and the state, grants included, carries over, into the same state directory only: section 3 step 4).
`uninstall` without `--purge` touches no state or socket, so it does not resolve them. `--purge` also removes only
what install and the daemon created: `~/.local/share/pi-worker/versions` and the doctor grant (then
`~/.local/share/pi-worker` itself when nothing else is in it), the state directory and the socket's `pi-worker`
directory (a socket configured elsewhere loses only its file). With a unit file installed, those are what systemd
runs the unit with (the resolver of section 3.1, which are the ones the unit file sets): when the resolver
refuses (systemd cannot be asked, `NeedDaemonReload=yes`, `UnsetEnvironment=`, an override of either variable, no single
canonical value) or systemd has not loaded the unit, purge refuses with that error (exit 1, `no_effect`) before
anything is stopped or removed. With no unit file they are what the caller's environment resolves. Owner drop-ins in
`~/.config/systemd/user/pi-worker.service.d/` are never removed; one that sets `PIW_STATE_DIR` or `PIW_SOCKET` still
applies to a later install, which then refuses it (`pi_worker_unit_overridden`, section 3 steps 4 and 10). Before anything is stopped or
removed purge checks every target, and refuses
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
  nothing written): unset it or pass the pinned one. A HOME that is not canonical, a user manager that cannot be
  asked, or a unit whose state directory systemd cannot report as one canonical path is refused too (section 3.1);
  nothing is registered anywhere else. `PIW_STATE_DIR` and `PIW_SOCKET` are pi-worker's: a drop-in, `EnvironmentFile=`
  or `UnsetEnvironment=` on either is refused `pi_worker_unit_overridden` (section 3.1), so the shell, the unit file and
  the daemon always agree. The daemon rereads grants on every request, so no restart is needed.
  `grant revoke <id>` withdraws it, `grant list` lists the pinned registry.
- Re-running `install` keeps the installed state directory: an install from a shell that resolves another one, the
  default included, is refused `pi_worker_state_mismatch` before anything is written or restarted (section 3 step 4),
  also when repairing an install that stopped part way or reinstalling after `uninstall`. Run it with the installing
  `PIW_STATE_DIR`/`XDG_STATE_HOME`. A `grant` command refused `pi_worker_unit_reload_pending` needs
  `systemctl --user daemon-reload` first (or a re-run of `install`, which reloads itself).
  Like `install`, the local `grant` commands need neither `XDG_RUNTIME_DIR` nor `PIW_SOCKET` (the runtime directory
  defaults to `/run/user/<uid>`); B2 calls such as `hello` take the socket from `--socket`, `PIW_SOCKET` or
  `XDG_RUNTIME_DIR`.
- The bridge connects to `socket` with the bearer from `$bridge_grant_file` (`PIW_GRANT_FILE`, or the Go client's
  grant file option). The socket is 0600 in a 0700 directory; for a bridge running as another user, the unit would
  need `PIW_SOCKET_GROUP` (not in this release).
- Host prerequisites the installer provides before step 1: Node >= `node_engine` on `PATH`, `bubblewrap`,
  unprivileged user namespaces (Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0` or a bwrap AppArmor
  profile), a systemd user manager with cgroup v2, and `loginctl enable-linger <user>` (these need root once).
