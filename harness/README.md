# Live-journey harness

Journeys run on throwaway exe.dev tester VMs (AGENTS.md rule 8, plan section 8), never on ms-a2 or hetzner.

```sh
harness/run.sh p0-hello            # create VM, set up, run, collect evidence, delete VM
harness/run.sh p0-hello --keep-vm  # keep the VM for debugging (delete it with harness/vm/teardown.sh)
```

| Path | What |
| --- | --- |
| `run.sh` | Orchestrator on the operator host: needs a clean tracked tree, sends HEAD as a git bundle, always tears the VM down. |
| `vm/create.sh`, `vm/teardown.sh` | `ssh exe.dev new` / `ssh exe.dev rm` (the `exe-dev-test-vm` skill). No tailnet join before P5. |
| `vm/remote-setup.sh` | On the VM: bubblewrap, linger, user namespaces; Node from `.node-version` (SHASUMS256 signature and hash checked) and Go 1.24.13 (go.dev hash checked) user-locally; `npm ci --ignore-scripts`, build, the default suite, the Go client suite and `harness/ci/kernel.sh`; writes `platform.json`. |
| `journeys/<name>/journey.sh` | On the VM: the journey; writes `journey.json` with named checks. |
| `lib/evidence.mjs` | `checks.json` bound to commit and tree, platform, checks, cleanup proof, attention record, privacy scan. |
| `lib/privacy-scan.mjs` | Fails on credential-like text; reports file, line and pattern name, never the match. |
| `ci/kernel.sh` | The kernel tier (see `ci/README.md`). |

Evidence lands in `docs/evidence/<milestone>/<UTC stamp>-<commit>/`. A failed attempt keeps its directory with
`status: fail` and `counted: false`.

## Journeys

- `p0-hello`: the daemon runs as a systemd user service with `Delegate=yes`; the TypeScript and Go clients each get
  `hello` (same supervisor epoch and limits) and a `501 no_effect`; the socket is 0600 in a 0700 directory; after stop
  there is no socket, no `piw-*` unit and no service cgroup.
