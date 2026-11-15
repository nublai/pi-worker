# A0 Gate 1 rerun: model-driven job on the fixed code

**Result: FAILED. Do not freeze Gate 1 on `4474a9a` yet.** Both full suites pass on the VM. The real job did not: on the fixed runtime, the supervisor refused both sandboxed child launches with `profile_copy_too_many_entries`. The real staged Pi profile has 18,801 entries, but the security-round staging copy (`copyTreeAt`) allows at most 10,000. The pstack fan-out to two children therefore cannot happen with the profile slice 7 used. Following the task rules, I stopped and am reporting the defect instead of fixing it. No runtime code was changed.

- Runtime subject: **`4474a9a8eecda33ba5d0af2c0259554dd56fb431`**, tree **`cabd514c0962de15324a4e2b1f15767a44ee3666`** (`prototype/a0`, the slice 7 merge).
- Branch: `a0/gate1-rerun`. Only harness scripts, evidence and this report were added. Nothing was pushed or merged.
- Evidence: [`evidence/gate1-rerun/`](evidence/gate1-rerun/), with [checks.json](evidence/gate1-rerun/checks.json) and [failure-audit.json](evidence/gate1-rerun/vm/failure-audit.json).

## Versions (a0-worker VM)

| Component | Version |
| --- | --- |
| Node | **v26.13.0**, user-local at `~/.local/node26`, from the official linux-x64 tarball. Its SHA-256 matched `SHASUMS256.txt` (GPG signature not checked). The existing `~/.local/node` 22.21.1 and system packages were not touched. |
| npm | 11.20.0 |
| Pi (runtime dependency and `~/.local/bin/pi`) | 1.5.2 |
| pi-herdr-agents / pstack (staged profile) | 3.11.0 / 1.0.0. The four experimental host source hashes are identical to slice 7's `platform.json`. |
| bubblewrap / Git / kernel | 0.9.0 / 2.43.0 / 6.12.115 |
| Provider/model | `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking `off` (the existing VM provider) |

The supervisor and every SDK host ran under Node 26.13.0: the unit's command is `~/.local/node26/bin/node`, and the sandbox `PATH` mounted `~/.local/node26/bin`. No GitHub credential was sent to the VM. The final audit's credential-boundary check passed: no standard credential files, no GitHub token environment variables, no Git credential helper, and no token pattern in the staged store.

## Checks and results

| Check | Result |
| --- | --- |
| `npm test` on VM at `4474a9a` | **Pass: 239 tests, 226 pass, 13 kernel skips, 0 failures** |
| Full suite in delegated user service `a0-g1-suite-kernel`, `A0_TEST_BWRAP=1` plus cgroup | **Pass: 239/239, 0 skips** |
| `npm run check:generated` on VM | Pass; checkout stayed clean |
| VM source audit ([vm-final-audit.json](evidence/gate1-rerun/vm/vm-final-audit.json)) | Subject `4474a9a`/`cabd514`, 72 source files hashed, no `a0-*` units |
| Sandboxed SDK parent started, with Git pin equal to the owner's setup pin | Pass |
| Parent denied its grant and journal (`PARENT_GRANT_AND_STATE_DENIED` check in the prompt) | Ran; the strict audit was not run (see below) |
| Parent read the pstack skill and playbook | 2 reads |
| **Fan-out to two sandboxed git-worktree children** | **FAILED.** Two `subagent` calls, both thinking `off`, both refused: the receipts show `rejected / refused / no_effect / profile_copy_too_many_entries`. There were 0 result deliveries. |
| Clients disconnected, then reconnected | Pass: 408.5 s gap, snapshot `resync_reason: gap`, same parent epoch, 46 parent tool calls during the gap, Pi not restarted |
| Owner Git through `src/git-safe.ts` on the real job workspace | Pass. The pin-checked `safeGit` read the log, diff, refs and trees. The changed set was only `README.md` and `evidence/gate1-job/verify.mjs`. |
| Fresh-checkout owner verification of the artifact, evidence record, acceptance | **Not run.** The job failed its required shape, so there is no subject to accept. |
| Terminal trap | Absent during the job. The file appeared only when the three post-cleanup positive controls ran (each exited 97). |
| Privacy scan of the export | Pass: 17 files, known private values compared in memory, pattern scan run ([privacy.json](evidence/gate1-rerun/vm/privacy.json)) |
| Cleanup | Parent stopped through B2 (`termination_observed`, cgroup removed). Orchestrator grant revoked. Only `a0-g1-supervisor` and its keeper `a0-a838fd122b09beb979f6` were stopped. Final `a0-*` user units: **0**. |

## The defects, with evidence

**D1 (blocking): the staging entry budget is smaller than the real profile.**
- `src/pinned-fs.ts:79`: `if (++budget.entries > 10000) throw new Refusal('profile_copy_too_many_entries')`.
- The parent's `.a0-agent` has **18,801** entries, and slice 7's `run2` profile has the same count. Almost all of them are the `npm/node_modules` tree that the experimental host and pstack need.
- `supervisor.ts:468` calls `copyTreeAt(source, dest)` with the default budget for every channel child. So every sandboxed child launch with this profile refuses.
- The suites missed this because no test stages a profile anywhere near this size.
- Consequence: Gate 1 row 1 (real parent, pstack, two retained-worktree children) has **no model-driven evidence on the fixed runtime**.

**D2: a staging refusal after dispatch is labelled `no_effect` after real writes.**
- Each child root holds **10,000 partially copied entries** under `.a0-agent`.
- Yet the receipt moved from `accepted/dispatch_recorded/unknown` to `rejected/refused/no_effect`. The parent was **not fenced** (`fence: null`).
- Cause: `Refusal` defaults to `effect: 'no_effect'`, and `receipts.ts` maps that to `rejected` even after `dispatch()`.
- This contradicts A0-SLICE7's B2 claim, "A staging failure after dispatch reports `unknown` and fences the parent." The claim holds only for non-`Refusal` errors.

**D3: refused child rows linger as live workers.**
- Both refused children remain in `workers.list` as `status: starting`, `cleanup: not_started`, `pid: null`, even after the parent stopped ([stop.json](evidence/gate1-rerun/vm/stop.json)).

**Model behaviour after the refusals (an observation, not a runtime defect).**
- The tool result said `rejected/no_effect; retained, never retried`.
- The parent then did both leaves' work itself. It edited files in the two pre-created child worktrees, committed `g1-note/task` (`f161aa8`) and `g1-check/task` (`f4a3c25`), and cherry-picked them onto `job/gate1`.
- It then added a third commit fixing the checker: `1e689e8`, tree `4945e51`.
- The sandbox allowed this, because the child worktrees lie inside the parent root. It is not the two-writer fan-out the job requires, and the strict audit would fail on it (0 deliveries, 3 parent commits).

## Attention

| Measure | Value |
| --- | --- |
| Authorization interventions | 1 prompt, 0 answers, 0 acceptances = **1** |
| Owner write actions | **4**: create, prompt, failure-stop, cleanup ([attention.jsonl](evidence/gate1-rerun/vm/attention.jsonl)) |
| Verified changes / PRs | 0 / 0 |
| Founder live touches | 0 |

Active human attention was not measured. The elapsed time from prompt to failure-stop was 23.2 minutes, but that is wall time, not attention.

## Deviations from slice 7's run

1. **Paths and names.** Scratch was `/tmp/a0g1/`. Units were `a0-g1-*`. Branches were `job/gate1`, `g1-note/task` and `g1-check/task`. The marker was `A0_GATE1_JOB_COMPLETE`.
2. **Job text.** This run added a README limits bullet saying that owner Git runs on a private snapshot of launch-pinned metadata, plus a checker at `evidence/gate1-job/verify.mjs`.
3. **Prompt wording.** The prompt says thinking is "the literal string 'off'". Both attempts used `off`; the four alias refusals seen in slice 7 did not recur.
4. **Setup fetch.** `vm-setup.sh` fetches `refs/heads/prototype/a0`, because the bundle has no `HEAD`.
5. **Node version.** The VM ran Node 26.13.0; slice 7 ran 22.21.1.
6. **Steps not run.** After the failure, the harness's `audit`, `freeze`, `verify` and `finish` steps were not run.
7. **Replacement scripts.** `failure-audit.mjs` exports only counts and codes; it reads no model text except the two `subagent` tool-result strings quoted above. `failure-stop.mjs` stops the parent through B2.
8. **Privacy scan.** `privacy-scan.mjs` binds to the runtime subject (there is no verification record) and also scans the channel grant.

## Failures, listed plainly

- The model-driven job failed (D1). The `live.mjs wait` step exited 1 at its 900 s deadline, with no automatic cancel or retry ([wait.log](evidence/gate1-rerun/vm/wait.log)).
- No owner fresh-checkout verification, evidence record or acceptance exists for this run.

## Recommendation

1. **Fix D1:** size the staging budget to real profiles, or stage a minimal profile. Add a regression with a profile of 20,000 or more entries.
2. **Fix D2:** a staging failure after dispatch should report `unknown` and fence the parent, as documented.
3. **Fix D3:** finalize refused worker rows.
4. Then rerun this exact harness. It is ready in `evidence/gate1-rerun/`. Gate 1 row 1 and item 12's staging claim should not be called covered on `4474a9a` until that rerun passes.

Retained on the VM for inspection: `/tmp/a0g1/run/` (journal, private sessions, workspace with the three refs, child roots holding partial profiles), `/tmp/a0g1/runtime`, and `~/.local/node26`.
