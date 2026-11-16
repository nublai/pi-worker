# Kernel tier

`kernel.sh` runs `packages/worker/dist/test/security/**` inside a delegated systemd user service
(`systemd-run --user --pipe --wait -p Delegate=yes`) with `PIW_TEST_KERNEL=1`, after a fixed shell moves itself into
the service's `runner` leaf and exports `PIW_CGROUP_ROOT`. Outside that unit the kernel tests skip; with
`PIW_TEST_KERNEL=1` a missing facility fails, never skips. `kernel.sh` fails on any skip, any todo, zero tests or a
leftover `piw-*` unit, and prints the platform (kernel, bwrap, systemd, delegated controllers, the AppArmor user
namespace setting) before the tests.

```sh
npm run build && harness/ci/kernel.sh
```

Host needs: cgroup v2, a running user manager (`loginctl enable-linger $USER`), bubblewrap, and unprivileged user
namespaces (`kernel.apparmor_restrict_unprivileged_userns=0` on Ubuntu 24.04, or a bwrap AppArmor profile).

## Where it runs

**Primary: GitHub-hosted `ubuntu-24.04`** (`.github/workflows/kernel.yml`). The job installs bubblewrap, sets the
AppArmor user-namespace sysctl to 0 for the throwaway runner, enables linger for the runner user, then runs
`kernel.sh`. **P0-8 result (2026-11-16): the hosted runner runs the tier.** `kernel.yml` run 43811794698 on
`cd8f492`: kernel 7.0.0-1017-azure, bubblewrap 0.9.0, systemd 255, user manager controllers `cpu memory pids`; both
smoke tests pass, 0 skips, 0 units left. The same suite passed on an exe.dev VM (kernel 6.12.115, Ubuntu 24.04.5) in
the `p0-hello` run under `docs/evidence/p0/`.

**Fallback (decision D4), if the hosted runner stops providing any of the above:** an ephemeral self-hosted runner on
an exe.dev tester VM (the `exe-dev-test-vm` and `setup-github-runner` skills), labelled for `kernel.yml` only, with a
registration token held outside the repository. It adds a machine and a runner credential, so it needs the founder's
go before it is set up; until then `kernel.sh` runs by hand on a throwaway exe.dev VM (`harness/run.sh` setup) and its
output is attached to the PR as evidence.
