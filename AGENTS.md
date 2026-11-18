# pi-worker

pi-worker is nubl's headless pi execution component: one supervisor per Linux user that runs pi sessions in their
own processes and answers a typed API (B2) over a private Unix socket. Shep's bridge and Maestro are its callers.
Vocabulary (worker, supervisor, session, binding, fence, receipt, interaction, grant) follows nubl's `GLOSSARY.md`.

Read before changing behaviour:

- **Contract:** nubl `.pi/plan/worker-contract.md`, revision 8. Sections 0, 0.1 and 0.2 are frozen.
- **Plan:** [docs/plan/production.md](docs/plan/production.md) for milestones, the A0 port map and PR completion
  criteria; [docs/plan/b2-for-shep.md](docs/plan/b2-for-shep.md) when a change touches a method Shep uses.
- **A0** (`prototype/a0`, `ee66117`) is evidence. Port a module only with its tests, per the plan's port map.

## Rules

1. **The frozen contract wins.** `api/fixtures/transitions.json` rows and invariants 1 to 8 change only through a
   new contract revision approved by the founder. When a frozen test fails, fix the code.
2. **Conformance first.** A behaviour change starts with a test that is red on the base revision, then the fix.
   Ported tests keep every assertion; record each port in `packages/worker/test/PORTED.md`. Conformance and
   security assertions are never weakened. A PR's gate uses only methods that exist at that PR (the plan's Deps
   column): a ported case lands in the first PR where everything it calls exists, never as a `skip`, and a frozen
   row leaves `todo` only in the PR the plan names for it (section 5.1).
3. **OpenAPI is the source.** Edit `api/b2.openapi.yaml`, run `npm run generate`, commit the generated files, and
   add a wire fixture for every new or changed operation. Generated files are only ever produced by the generator.
   Request and response validation stay on in production. Every operation declares its body and response modes
   and a non-JSON body its byte limit; the 256 KiB cap is for JSON bodies only. Tool and generator versions are
   exact pins (plan section 4.4); a bump is its own PR with the regenerated files.
4. **Runtimes.** The daemon runs on Node 26. `@nublai/pi-worker-client` keeps pi's Node floor (22.19). The Go client
   builds with Go 1.24 and the standard library only; its models are generated with the Go 1.26.11 toolchain in
   `tools/go`. Go steps run with `GOTOOLCHAIN=local`.
5. **No blind replay.** A mutation is sent once. After its dispatch record, a failure is `outcome_unknown` and
   fences the session, unless the code throws `ProvenNoEffect` with evidence that nothing happened. Clients classify
   before-write failures as `no_effect` and after-write failures as `unknown`, then read the receipt. A disconnect is
   never a cancel.
6. **Security review.** A change to `b2/` auth or the parent channel, `grants/`, the child launch spec or FD
   report, `containment/`, `sandbox/` or `owner-git/` merges only after Claude and Grok reviews, both from a model
   family other than the author's, and with a reversion for each guard it adds that fails by assertion.
7. **Owner Git** in any checkout a sandboxed agent could write goes through `owner-git`'s typed functions (`gitStatus`, `gitDiff`, ...); it has no raw argv entry.
8. **Live journeys run on throwaway exe.dev VMs** (the `exe-dev-test-vm` skill), never on ms-a2 or hetzner until the
   plan says so. Linux only.
9. **Verification evidence.** A PR body lists each command run with its result, names the commit and tree it ran
   on, and states the kernel suite result (0 skips) when rule 6 applies. An agent's completion message is input to
   verification, never evidence. Evidence files carry no secrets, answer text or transcripts; run the privacy scan
   in `harness/lib` before committing them. Failed attempts stay recorded and labelled.

## Verification

CI (`ci.yml`) runs on pushes to `main`, on PRs (opened, synchronize, reopened, labeled), nightly (03:17 UTC) and on
demand; a push to another branch runs nothing until its PR exists. `check`, `crash`, `go-client`, `client-node22`
and `release-artifact` run on every such event; `kernel` runs on its path filter, nightly and on demand.

Reversions (one matrix shard per group) are the slow tier, so they are selected:

- Nightly, `workflow_dispatch` and a PR labelled **`full-reversions`**: every group.
- Any other PR: only the groups `--changed origin/<base>` selects. A change to the runner, the manifest, the
  toolchain or a package manifest selects every group; a file no reversion patches selects none.
- A push to `main`: the groups changed since the previous head (every group for a new ref, a rewind or a force
  push: the previous head must exist and be an ancestor of the new one).
- With no group selected the shards are skipped and `reversions-gate` reports that as a pass. Adding a label other
  than `full-reversions` runs nothing.

The changed-group selection is only a fast first signal. It matches the files a reversion diff patches (a rename
counts as old plus new path); it does not follow imports and ignores test-only edits (a changed test file selects
nothing), so it can miss a reversion that an edit weakened. The full set on the exact head is therefore mandatory
before merge, never optional.

**Merge rule:** a PR merges only after a run with the full set green on its exact head. When it is ready to merge,
add the `full-reversions` label (pushing again needs a run again; the label stays and every later push runs the
full set).

- **Builders** run `npm run check` and the affected reversion groups (`--changed origin/main`) locally, and cite
  the CI run on the exact head for `crash`, the remaining reversions (the full set, once labelled) and `kernel`. Do not rerun them by hand.
- **Reviewers** cite the CI run on the exact head SHA, and run only their own probes and targeted tests. A red or
  missing run on that head is a finding.
- A change that CI cannot cover (live journeys, rule 8) is still run and recorded as rule 9 says.

## Commands

`package.json` scripts are the source; the ones with non-obvious conditions:

- `npm run check`: everything CI runs except the kernel tier, the crash tier and the reversions.
- `npm run test:crash`: the crash-recovery tests. CI runs it on every PR and push to main.
- `node harness/lib/reversions.mjs --changed origin/main`: only the reversion groups whose patched files your
  branch touches (commit first; the runner needs a clean tree). `--group <name>` runs one group, `--list` names
  them, `--changed <base> --list` prints only the selected names (what CI uses; runs nothing), `--all` runs every
  group. Each prints caught/total and fails on any diff not caught by a named assertion.
- `harness/ci/kernel.sh`: kernel tests (cgroup v2, bwrap). It runs the suite inside a delegated user service
  (`systemd-run --user -p Delegate=yes`) with `PIW_TEST_KERNEL=1`; outside one, kernel tests skip.
- `PIW_CRASH_AT=<label>` SIGKILLs the supervisor right after that fsync; `PIW_TRACE_FSYNC=1` lists labels. Use them
  only on test state.
