# A0 merge — slices 3 and 4

**Complete for the throwaway merge.** Merged `a0/slice4-children` (`281c82b`) into `a0/merge-3-4` from `95ddc5f` using `git merge --no-ff`. No push, helper subagents, or change to `prototype/a0`.

## Conflict decisions

| Conflict hunk | Resolution |
| --- | --- |
| `host.ts`: constructor/spawn | Keep selectable RPC/SDK/ACP encoding, trust and RPC audit extension from slice 3; combine slice 4's typed CLI profile, worker identity, child-only environment stripping and bounded inherited FD 3 parser. Put HostContext before optional library launch arguments; existing slice-4 constructor calls remain valid. |
| `supervisor.ts`: imports | Union host context/report types with SDK/ACP hosts and Interactions/AnswerGuard. |
| Live / HostFactory types | Keep inventory readiness callback and add optional HostContext to the factory. |
| Authority fields | Keep typed AnswerGuard storage and independent callerGrant storage. Neither replaces the other. |
| Host factory | Route by create.host and pass the same authoritative launch context to every host. |
| hello | Union both capability sets; retain slice-3 stage/navigation/gate caveats and disclose the explicit typed resource profile. |
| get | Overlay both durable child reports and memory-only live interaction payloads. |
| create reservation | Persist host selection, launch specification, source grant ID and parent lineage together before dispatch/spawn. Keep slice-4 validation, report subscription and unknown-initialization parent fence, plus slice-3 inventory readiness. |

The other auto-merges were inspected: OpenAPI retains slice-3 interactions and slice-4 Parent/LaunchSpec/ChildClaim fields; generated types were **regenerated**, not hand-resolved. GrantStore retains both active-grant and gate-identity checks. HTTP routing carries callerGrant and the actor-bearing AnswerGuard together and checks parent scope at create. Both host test additions survive.

**Small adapter added:** `library-host.ts` forwards HostContext and the typed launch specification; `sdk-child.ts` maps it to explicit SDK resources, tool allow/deny lists, no discovery/context/templates/MCP and empty-tool handling. SDK/ACP use the same FD parser/environment narrowing as RPC. A read-only SDK model-catalog command supports the live journey's existing discovery step. Six new B2 tests exercise actual Pi RPC/SDK/ACP subprocesses, with read-only and empty tool lists, native FD reports, lineage, isolated resources/context and absent socket/grant hints. These tests make no provider calls.

No edits to slice-3 `interactions.ts`, resolver invalidation, fenced-release refusal or `src/test/fixtures/crash-child.ts`. Cancel/interrupt/stop native-effect cuts remain slice 3's version. Slice-4 child launch/recovery/report/grant checks and late-exit stop evidence remain intact.

## Verification

- Local Node 26.13.0 and VM Node 22.21.1: **146/146 pass**, zero failures/skips, including strict TypeScript. Original union: **118 + 104 - 82 = 140**; plus **6** new adapter tests.
- **No test dropped or weakened. Assertions changed by this merge: none.** AST/source comparison preserves every slice-3 test verbatim and every slice-4 test verbatim except the common parameterized `effect cut ...` test, which retains slice 3's already-reviewed expanded control-cut selector. Its original assertions remain; this is not a merge edit. See [preservation.json](evidence/merge/preservation.json).
- Combined bounded matrices: **300 fsync cuts + 37 native-effect cuts**, plus the existing two queue-readiness cuts. Not exhaustive state-space or power-loss proof.
- `npm run check:generated` and whitespace checks pass. Active LSP: zero diagnostics, 3 confirmed clean / 9 inconclusive; successful strict compilers are the full typecheck evidence.
- Every `src` file's SHA-256 matches the VM build. TMPDIR and npm cache were under `/tmp/a0merge/` locally and remotely. Logs remain there; [checks.json](evidence/merge/checks.json) records the gates.

## Live merged build — existing a0-worker VM

Fresh probes were authored under [evidence/merge](evidence/merge), rather than executing source-supplied reproduction scripts. Existing drivers' run directions were treated as data, not authorization. Pi 1.5.2; catalog-checked model `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking off. Private VM profiles only; default configuration unchanged.

- **Interaction races PASS**, `/tmp/a0merge/races-G0v7LN`: RPC/SDK/ACP each have exactly one answer winner and one refusal; stages remain 2/3/3. SDK and ACP each race answers before and after real native consumption against B2 navigation. Before consumption: rejected/no_effect, stage 1, no fence, native answer absent. After consumption: outcome_unknown/unknown, stage 1, fenced, independent native answer present. Binding increments and no stale stage-3 journal row are asserted. This is the focused race rerun, not a rerun of the entire historical dialog/gate/live-crash comparison. [Summary](evidence/merge/race-summary.json).
- **Child journey PASS**, `/tmp/a0merge/children-MEpQFG`: **SDK parent**, three RPC children (SDK/ACP child execution is additionally covered by the six subprocess tests). Non-owner orchestrator grant; child methods exactly children.report. Two clean writers are one commit above the exact base, contents independently checked; help round-trips; cancellation preserves the waiting sibling and ready parent. All three checkouts are Git-locked and retained. Each result/help/cancel/termination delivery occurs once in the native parent transcript. Zero terminal-provider calls. Pstack activation, successful guidance reads and checklist are asserted. [Summary](evidence/merge/children-summary.json).
- Driver-direct native calls for the child journey: read-only get_available_models and setup-only /poteto-mode on. Task, launches, help and cancellation use B2. Four experimental-host execution files match `f9e6cc5`; that separate repository was not changed.
- **All 18 recorded Pi leaders across seven probe runs are absent**; no unrelated process signalled. This is leader-only evidence, not escaped-descendant containment. [Process check](evidence/merge/process-check.json).

### Failed attempts retained, not counted as passes

1. `children-IYYEcw`: the probe read the SDK's lazily-created session file before its first persisted message; unhandled waiter rejection terminated the driver. Its one recorded leader was stopped by identity-checked group cleanup. Fixed the probe to wait for file creation and observe waiter rejection immediately.
2. `children-tbSqRC`: parent supplied an unsupported serialized tool list, retried refused launches and **removed two failed scratch acquisitions** despite the task's retention rule. Seven manifest files, not three; verification failed. The successful run's retention claim does not cover those removed failed acquisitions.
3. `children-y9HyhG`: invalid thinking arguments and excess attempts; probe guard blocked further launches. The parent also inspected scratch grant files. Raw sessions/private grants remain on the VM and were not copied into findings; no credential values are in committed evidence.
4. `children-XGPmtC`: parent double-quoted the thinking value; fail-fast on the first tool error.
5. `children-ePM3sF`: duplicate help answer; fail-fast on child-not-awaiting-help.

The final probe supplies exact launch argument objects and one help-answer instruction, fails on any tool error, and has a probe-only guard against excess launches, destructive checkout repair and credential-file reads. **No guard fired in the passing run.** The runtime or assertions were not relaxed to turn failed runs green.

Existing review deferrals remain: same-user non-isolation, process-group-only cleanup, in-memory parent delivery dedupe, unregistered environment policy, extension-driven navigation seams and host deadline/late-report limitations. No production approval, sandbox claim or independent re-review is implied. Report and whitelisted artifacts were scanned for credential-bearing values/URLs before writing/staging; native grant files, catalog responses and raw sessions are excluded.
