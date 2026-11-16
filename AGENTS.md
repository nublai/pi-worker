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
   security assertions are never weakened.
3. **OpenAPI is the source.** Edit `api/b2.openapi.yaml`, run `npm run generate`, commit the generated files, and
   add a wire fixture for every new or changed operation. Generated files are only ever produced by the generator.
   Request and response validation stay on in production.
4. **Runtimes.** The daemon runs on Node 26. `@nublai/pi-worker-client` keeps pi's Node floor (22.19). The Go client
   builds with Go 1.24 and the standard library only.
5. **No blind replay.** A mutation is sent once. After its dispatch record, a failure is `outcome_unknown` and
   fences the session, unless the code throws `ProvenNoEffect` with evidence that nothing happened. Clients classify
   before-write failures as `no_effect` and after-write failures as `unknown`, then read the receipt. A disconnect is
   never a cancel.
6. **Security review.** A change to `b2/` auth or the parent channel, `grants/`, `containment/`, `sandbox/` or
   `owner-git/` merges only after Claude and Grok reviews, both from a model family other than the author's, and
   with a reversion for each guard it adds that fails by assertion.
7. **Owner Git** in any checkout a sandboxed agent could write goes through `owner-git` (`safeGit`, `safeGitRun`).
8. **Live journeys run on throwaway exe.dev VMs** (the `exe-dev-test-vm` skill), never on ms-a2 or hetzner until the
   plan says so. Linux only.
9. **Verification evidence.** A PR body lists each command run with its result, names the commit and tree it ran
   on, and states the kernel suite result (0 skips) when rule 6 applies. An agent's completion message is input to
   verification, never evidence. Evidence files carry no secrets, answer text or transcripts; run the privacy scan
   in `harness/lib` before committing them. Failed attempts stay recorded and labelled.

## Commands

`package.json` scripts are the source; the ones with non-obvious conditions:

- `npm run check`: everything CI runs except the kernel tier.
- `harness/ci/kernel.sh`: kernel tests (cgroup v2, bwrap). It runs the suite inside a delegated user service
  (`systemd-run --user -p Delegate=yes`) with `PIW_TEST_KERNEL=1`; outside one, kernel tests skip.
- `PIW_CRASH_AT=<label>` SIGKILLs the supervisor right after that fsync; `PIW_TRACE_FSYNC=1` lists labels. Use them
  only on test state.
