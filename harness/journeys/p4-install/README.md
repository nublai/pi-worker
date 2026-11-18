# p4-install

The release artifact on a fresh exe.dev tester VM, with no repository there (docs/plan/install.md):

```sh
harness/journeys/p4-install/run.sh            # build, create VM, set up, run, collect evidence, delete VM
harness/journeys/p4-install/run.sh --keep-vm  # keep the VM (delete it with harness/vm/teardown.sh)
```

| File | Where | What |
| --- | --- | --- |
| `run.sh` | operator host | Builds the x64 tarball from the committed HEAD (`harness/release/build.sh`), creates the VM, copies the tarball, its `.sha256` and the two scripts, runs them, copies `docs/evidence/p4/<run>/` back, writes `checks.json` (`harness/lib/evidence.mjs`) and deletes the VM even on failure. |
| `host-setup.sh` | VM, sudo | Host prerequisites a host installer provides once: bubblewrap, unprivileged user namespaces, linger, Node from `.node-version` into `/usr/local` (signature and hash checked). Writes `platform.json`. |
| `journey.sh` | VM, user | Install from the tarball's own CLI, doctor all green, install again (idempotent), another version refused, the unit delegated with the supervisor in its leaf, socket 0600/0700, hello, a grant and one granted read, an ungranted method refused, logs, uninstall (state and versions kept), install again (grant still works), `uninstall --purge` (nothing left: data, state, unit, link, socket directory, cgroup, units, processes). Every `pi-worker` command runs with neither `XDG_RUNTIME_DIR` nor `PIW_SOCKET` set, as Shep's installer may (install.md section 7; B2 calls get `--socket` from install's output); only the script's own `systemctl` probes get `XDG_RUNTIME_DIR`. Writes `journey.json` and `transcript.log`. |
