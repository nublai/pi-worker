# Live-journey harness

Journeys run on throwaway exe.dev tester VMs (AGENTS.md rule 8, plan section 8), never on ms-a2 or hetzner.

```sh
harness/run.sh p0-hello            # create VM, set up, run, collect evidence, delete VM
harness/run.sh p0-hello --keep-vm  # keep the VM for debugging (delete it with harness/vm/teardown.sh)
```

| Path | What |
| --- | --- |
| `run.sh` | Orchestrator on the operator host: needs a clean tracked tree, sends HEAD as a git bundle, tears down only a VM this run created (unique random-suffix name; `vm/create.sh` records creation before waiting for SSH), and a failed teardown fails the run and is recorded as `vm_teardown: failed`. |
| `vm/create.sh`, `vm/teardown.sh` | `ssh exe.dev new` / `ssh exe.dev rm` (the `exe-dev-test-vm` skill). No tailnet join before P5. |
| `vm/remote-setup.sh` | On the VM: bubblewrap, linger, user namespaces; Node from `.node-version` (SHASUMS256 signature and hash checked) and Go 1.24.13 (go.dev hash checked) user-locally; `npm ci --ignore-scripts`, build, the default suite, the Go client suite and `harness/ci/kernel.sh`; writes `platform.json`. |
| `journeys/<name>/journey.sh` | On the VM: the journey; writes `journey.json` with named checks. |
| `lib/evidence.mjs` | `checks.json` bound to commit and tree, platform, checks, cleanup proof, attention record, privacy scan. |
| `lib/privacy-scan.mjs` | Fails on credential-like text; reports file, line and pattern name, never the match. |
| `test/run.test.mjs` | No-network tests of the VM lifecycle with an `ssh` stub (`npm run test:harness`). |
| `test/kernel-units.test.mjs` | Tests of `ci/units.sh` with a `systemctl` stub: an unloading or not-loaded unit is gone, a unit still loaded at the bound is reported (`npm run test:harness`). |
| `ci/kernel.sh` | The kernel tier (see `ci/README.md`). |
| `ci/units.sh` | Sourced by `kernel.sh`: the leftover `piw-*` unit check, polled with a bound so a unit systemd is still unloading is not a leftover. |

Evidence lands in `docs/evidence/<milestone>/<UTC stamp>-<commit>/`. A failed attempt keeps its directory with
`status: fail` and `counted: false`.

## Journeys

- `p0-hello`: the daemon runs as a systemd user service with `Delegate=yes`; the TypeScript and Go clients each get
  `hello` (same supervisor epoch and limits) and a `501 no_effect`; the socket is 0600 in a 0700 directory; after stop
  there is no socket, no `piw-*` unit and no service cgroup.
- `p1-chat`: the P1 daemon as a user service with pi's scripted faux provider in a private agent directory; every
  step goes through the `pi-worker` CLI (`packages/cli`): grant register, hello, create, prompt, history, a dialog
  answered over B2, an image staged, sent and read back, an extension command, interrupt with a queued follow-up,
  new and resume, typed refusals, stop, grant revoke and the refused call after it; then the same cleanup checks as
  `p0-hello` and no pi child left.
