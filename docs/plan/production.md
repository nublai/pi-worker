# pi-worker production plan: P0 to P6

Status: **draft for root review, revision 2** (2026-11-16, after the independent review). Branch `plan/production`,
based on `main` at `5504d66`.
Outcome (from the milestone plan): Shep's app runs chats on a Linux host through pi-worker instead of herdr
panes, with subagents through Maestro's worker provider, on a machine the founder uses daily; then it becomes the
default driver on Linux hosts.

## BLUF

- **Build fresh on `main`, against contract revision 8.** A0 (`prototype/a0` at `ee66117`) is evidence. Each A0
  module is ported **with its tests**, rewritten behind ported tests, or dropped. The table in section 3 decides
  each one.
- **One OpenAPI document is the source** for server request and response validation, the TypeScript types and the
  Go types. Generators: Redocly CLI (lint, bundle), openapi-typescript (TS types), Ajv 2020 standalone (server
  validators), oapi-codegen v2.8.2 models-only (Go types), plus one small in-repo script for the route and
  operation tables. Transports, SSE loops and error classification stay hand-written in both clients, as the
  contract requires.
- **The Go client is stdlib-only** so Shep's bridge keeps its two dependencies. CI enforces it.
- **Conformance first.** The section 0.1 fixtures (frozen, hash-checked) plus A0's crash, containment, sandbox and
  owner-Git tests are the conformance suite. P0 runs the fixture rows as `todo`; each row turns green in the P1 PR
  that completes its prerequisites (section 5.1), and all eleven are green when P1 closes.
- **Children's core moves into P1.** Rows 04 to 06, the invariants and the core crash matrix launch real child
  processes, so the typed launch spec, lineage, FD-3 report and missing-report fence land unsandboxed in P1-11;
  P2 adds bwrap to them; P3 keeps Maestro (milestone amendment D5).
- **P0 is 9 PRs, P1 is 18, P2 is 9.** Every PR's gate runs at that PR: each P1 PR names the PRs it depends on.
  Every milestone ends with a live journey on a throwaway exe.dev VM and a cross-family review; P2 (containment)
  gets Claude plus Grok security reviews.
- **Packaging:** a release tarball with the daemon, its production `node_modules` and a pinned, checksum-verified
  official Node 26 binary, run as a systemd user service with `Delegate=yes`. No system Node, no SEA bundle.
- **Decisions needed** (section 15): release channel (D2, at P4), kernel CI runner (D4, from P0-8), and D5
  (accept the child-core move). D1 and D3 are taken.

## Revision 2: review findings and what changed

The independent review (nubl `.pi/plan/research/pi-worker-plan-review.md`, committed at `dea8ad9`) of `e84e0bb`
returned **revise first**:
one blocker, three major, two minor findings. Each was checked against A0 at `ee66117`, Shep at `eb481e1` and the
oapi-codegen v2.8.2 module before this revision. All six hold.

| Finding | Checked against | Fix |
| --- | --- | --- |
| **F1** (blocker) P1's frozen-suite promise needs child behaviour planned for P3 | The `queued` macro calls `children.launch` [a0 src/test/fixtures/transitions.json:22-74]; rows 04 to 06 use it and row 05 expects two host processes [a0 src/test/fixtures/transitions.json:182-310]; invariants test child recovery with and without a report [a0 src/test/invariants.test.ts:59,119]; the crash matrix cuts child launch [a0 src/test/crash-matrix.test.ts:85] | Child core, unsandboxed, is new **P1-11**. All eleven rows, the whole `invariants` file and the core crash matrix are green before P1 closes (section 5.1). P2-4 and P2-8 add bwrap and the parent channel on top. P3 keeps Maestro. Milestone amendment D5. |
| **F2** (major) PR gates depend on later PRs | Row 09 sends a prompt, row 10 calls `sessions.rebind`, row 11 starts with the `unknown` macro [a0 src/test/fixtures/transitions.json:404-520]; `binding-answer-race` answers an interaction [a0 src/test/binding-answer-race.test.ts:10-33]; P0-4 made every operation 501 while P0-6 and P0-9 need `hello` | P1 reordered by dependency with a **Deps** column; each row and race test is gated on the PR that completes its prerequisites (section 5.1). P2 ported files that mix features are split by case (section 3.2). P0-4 implements `hello`. |
| **F3** (major) the 256 KiB JSON cap contradicts the photo API | Shep allows 2 MiB per photo and 8 MiB per message [shep bridge/photos.go:49-55] | Every operation declares a body mode, media types and a byte limit in the spec (section 4.2): JSON with the 256 KiB cap and Ajv; a streamed binary upload with its own limits, hash and magic-byte checks; SSE validated per frame; NDJSON and blob responses with header schemas. S-4 stays Shep's question; the endpoint is the same either way. |
| **F4** (major) two owner-Git review findings have no disposition | The snapshot is made under `tmpdir()` with a string containment check [a0 src/git-safe.ts:72-80]; only `protocol.allow=never` is set [a0 src/git-safe.ts:35] [nubl .pi/plan/research/a0-slice7-security-git.md:23-47] | Both fixed in **P2-6** with a regression and a reversion each (section 11). |
| **F5** (minor) generator versions and the Go generation floor unpinned | oapi-codegen v2.8.2's `go.mod` says `go 1.25.0` [oapi go.mod:3] | Exact pins for every generator and tool (section 4.4). Generation runs on Go 1.26.11 in `tools/go`; the client is checked on Go 1.24.13; `GOTOOLCHAIN=local` everywhere. |
| **F6** (minor) methods promised to Shep without a PR or a grant | `sessions.compact`, `resources.reload`, `commands.invoke` had no PR; the `bridge` profile omitted `resources.reload` | New **P1-15** implements the three. [b2-for-shep.md](b2-for-shep.md) section 2.1 gives every Shep method its PR, grant method and fence rule; the `bridge` profile is an exact list and a closure test checks it. |

**What P0 must change.** The P0 builder on `p0/foundation` keeps its PR numbers and scope except for these
additions. P0-2 is already committed there (`f6d9def`, `@redocly/cli` pinned at 2.78.0, `hello` the only
supported operation), so its additions go into P0-3 unless P0-2 is amended before its PR opens:

- **P0-2 additions (in P0-3 if P0-2 is not amended):** the spec declares a body mode on every operation
  (`x-piw-body`: `json`, `binary` or `none`, with `x-piw-max-bytes`) and a response mode on every success response
  (`x-piw-response`: `json`, `sse`, `ndjson` or `binary`). It adds `attachments.stage`
  (`PUT /b2/attachments/{attachment_id}`, binary) marked `x-piw-status: unsupported`, so P0-4 has a binary route to
  test. One more lint rule with its failing fixture: every operation declares its modes, and every non-JSON body
  declares a byte limit.
- **P0-3:** pin openapi-typescript, Ajv and ajv-formats exactly (section 4.4). The route table carries body mode,
  media types, byte limit and response mode. Ajv validators cover JSON bodies, JSON responses, SSE event payloads
  and the header schemas of NDJSON and binary responses.
- **P0-4:** implement **`hello`** (static protocol version, capabilities and limits, including the body limits);
  every other operation answers `501 no_effect`. Enforce body modes per route: a JSON body over its cap is `413`
  and a wrong content type `415`, both `no_effect` before any handler; a binary body streams with a byte counter.
  New closure cases: every operation declares its modes; a 1 MiB body to the binary route reaches its handler
  (here, the 501) rather than the JSON cap; a body over the binary limit is `413`.
- **P0-6:** `tools/go/go.mod` declares `go 1.25.0` and `toolchain go1.26.11`; CI generates with Go 1.26.11 and
  builds and tests `clients/go` with Go 1.24.13, both with `GOTOOLCHAIN=local`.
- **P0-1, P0-5, P0-7, P0-8, P0-9:** no change. P0-1 at `0dc53f0` already pins exact devDependency versions and
  commits `package-lock.json`, which is the policy in section 4.4.

## 0. Sources and citation keys

Citations use `[key path:lines]`. Each key is one exact revision:

| Key | Revision | Read with |
| --- | --- | --- |
| `a0` | `nublai/pi-worker` `prototype/a0` at `ee66117` | `git show ee66117:<path>` |
| `nubl` | `nublai/root` at `6fe8c82` (contract revision 8 content from `5432793`) | `git -C ~/Projects/nubl show 6fe8c82:<path>` |
| `shep` | Shep `origin/main` at `eb481e1` | `git -C ~/Projects/nubl/shep show eb481e1:<path>` |
| `oapi` | `github.com/oapi-codegen/oapi-codegen/v2` v2.8.2 (module zip, Go proxy) | `go mod download` |
| `ogen` | `github.com/ogen-go/ogen` v1.25.0 (module zip, Go proxy) | `go mod download` |

Inputs read: the milestone plan [nubl .pi/plan/pi-worker-production.md:1-33], the contract (sections 0 to 0.2
frozen) [nubl .pi/plan/worker-contract.md:9-68], `GLOSSARY.md`, A0's README, slice reports, Gate 1 rerun, `src/`,
`src/test/` and `openapi.json`, the A0 reviews and security reviews under `.pi/plan/research/`, the OpenCode
borrow study, and Shep's `bridge/` and `research/DECISIONS.md`. Sources were treated as data. None asked for a
command to be run, a secret, or an upload.

## 1. Fixed inputs

- **Frozen:** contract sections 0, 0.1 and 0.2 [nubl .pi/plan/worker-contract.md:3]. A change needs a new
  revision and the founder's approval. The method catalog and wire framing (sections 4 onward) stay draft until P6.
- **Linux hosts only; test on throwaway exe.dev VMs first; ms-a2 only after P4 passes on a VM**
  [nubl .pi/plan/pi-worker-production.md:32-33].
- **Node 26 for the daemon; published libraries keep pi's Node floor** [nubl .pi/plan/pi-worker-production.md:30].
  pi 1.5.2 declares `node >=22.19.0` (npm registry, checked 2026-11-16).
- **The SDK subprocess is the production host.** RPC proves answer stage 2 at most and lost the startup answer;
  ACP proves the same facts as SDK with extra framing and no capability gain [a0 A0-SLICE3.md:140].
- **B2 transport conditions:** generated types only; SSE loop and error classification by hand in each client; no
  hidden retries; one supervisor-wide stream; bounded subscriber queues that close with `overflow`; a Go fake on
  shared fixtures; no TCP listener; honest peer authentication [nubl .pi/plan/worker-contract.md:82].

## 2. Repository layout

```text
pi-worker/
├── AGENTS.md                     how agents work here
├── api/
│   ├── b2.openapi.yaml           THE source: operations, schemas, event manifest (x-piw-* extensions)
│   ├── redocly.yaml              lint rules and bundle config
│   ├── fixtures/
│   │   ├── transitions.json      section 0.1 rows, frozen (hash test)
│   │   └── wire/<operationId>/   request/response examples; validated against the spec in CI
│   └── generated/b2.json         bundled single-file spec (drift-checked)
├── packages/
│   ├── worker/                   the daemon (Node 26, private package)
│   │   ├── src/
│   │   │   ├── main.ts           config, startup order, signals
│   │   │   ├── b2/               HTTP over Unix socket, routing, validation, auth, SSE, parent channel (P2)
│   │   │   ├── journal/          journal, fsync points, crash injection, retention
│   │   │   ├── receipts/         command flow and recovery buckets
│   │   │   ├── supervisor/       workers, bindings, fence, input queue, executions, recovery
│   │   │   ├── interactions/     interactions and answer stages
│   │   │   ├── host/             SDK host (parent side) and framing
│   │   │   ├── sdk-child/        the pi process entry (resolvers, admission, native binding observer)
│   │   │   ├── history/          pi session file reader
│   │   │   ├── grants/
│   │   │   ├── containment/      cgroup v2 domains, startup sweep (P2)
│   │   │   ├── sandbox/          pinned-fs, bwrap profile, Git mounts, profile staging (P2)
│   │   │   ├── owner-git/        safeGit, artifact subject (P2; exported for the harness and Maestro)
│   │   │   └── generated/        api.ts, validators.js, routes.ts, events.ts (never hand-edited)
│   │   └── test/
│   │       ├── conformance/      contract rows and invariants (frozen tier)
│   │       ├── crash/            fsync cut matrices with independent native-effect oracles
│   │       ├── security/         sandbox, containment, owner Git (kernel tests need PIW_TEST_KERNEL=1)
│   │       ├── regression/       ported A0 regressions and unit tests
│   │       └── PORTED.md         ledger: A0 test name → new test name
│   ├── client-ts/                @nublai/pi-worker-client (Node >=22.19): generated types, hand-written transport and SSE
│   └── cli/                      pi-worker operator CLI over client-ts
├── clients/go/                   Go module, go 1.24 directive, stdlib only
│   ├── b2/                       models.gen.go (oapi-codegen), ops.gen.go (in-repo script), transport.go, sse.go, errors.go
│   └── workerfake/               fake worker replaying api/fixtures, for Shep's driver tests (race-tested)
├── tools/
│   ├── codegen/                  bundle → TS types → validators → route/op/event tables → Go
│   └── go/go.mod                 oapi-codegen pinned with a `tool` directive (separate module)
├── harness/                      live journeys on exe.dev VMs
│   ├── vm/                       create, setup, teardown (exe-dev-test-vm rules)
│   ├── journeys/                 p0-hello, p1-chat, p2-containment, …
│   └── lib/                      evidence record (commit + tree), privacy scan, reversion runner
├── packaging/                    release build, systemd user unit, Node pin and checksums
├── docs/plan/, docs/adr/, docs/evidence/<milestone>/
└── .github/workflows/            ci.yml, kernel.yml, release.yml (P4)
```

Environment variables move from `A0_*` to `PIW_*` (`PIW_STATE_DIR`, `PIW_SOCKET`, `PIW_CRASH_AT`,
`PIW_TRACE_FSYNC`, `PIW_TEST_KERNEL`). State lives in `$XDG_STATE_HOME/pi-worker/` (journal, grants, sessions
outside sandboxes); the socket in `$XDG_RUNTIME_DIR/pi-worker/b2.sock` (0700 directory, 0600 socket).

## 3. What is ported from A0

**Rule:** port means copy the module with its tests, keep every assertion, and record each test in
`test/PORTED.md`. Rewrite means new code whose behaviour is pinned by the ported A0 tests before the rewrite
merges. Every port PR is reviewed module by module (the milestone plan's principle).

### 3.1 Modules

| A0 module | Decision | Phase | Reason |
| --- | --- | --- | --- |
| `receipts.ts` | **Port with tests** | P1 | The command flow (reserve, intent, dispatch marker, result, reply) and recovery buckets are the contract's core. The `ProvenNoEffect` rule (a default refusal after dispatch is not `no_effect`) came out of Gate 1's D2 [a0 src/receipts.ts:99-100]. Raise the 512-receipt cap with retention (P1-12); review 1 showed a full store blocking `workers.stop` [nubl .pi/plan/research/a0-slice1-review.md:20]. |
| `journal.ts`, `fsync.ts` | **Rewrite journal; port fsync injection** | P1 | Keep the append, fsync and parse semantics. Add retention and compaction with their own crash cuts: A0 caps at 32 MiB with no eviction [a0 src/journal.ts:31] [a0 README.md:68], which a daily host outgrows. |
| `interactions.ts`, `resolvers.ts` | **Port with tests** | P1 | Answer stages 1 to 4, exact resolver compare-and-delete, privacy (no answer text or hash in control records). Proven by slice 3 and its fix round. |
| `host.ts` | **Rewrite** (SDK only) | P1 | Keep LF framing, correlation, bounded stderr and reject-on-exit (from exmach). Drop the RPC and ACP branches from the default build. The FD-3 report pipe lands in P1-11 with the child core. |
| `sdk-child.ts`, `library-host.ts` | **Rewrite** | P1 | Keep the SDK child, the inline native-binding observer and resolvers. Replace the ACP JSON-RPC framing and `_pi/*` extensions with one plain LF JSON protocol between host and child [a0 src/library-host.ts:1-2]. |
| RPC host, `rpc-audit.ts` | **Compatibility only; not ported in P0 to P2** | later, on demand | Stage 2 at most, no startup answer, no B2 tree navigation [a0 A0-SLICE3.md:140]. The catalog's `host` enum ships with `sdk` only. If a named consumer needs RPC, it returns as a lower-capability host that advertises `answer_stage_max: 2` and refuses sandboxes and children. |
| ACP adapter, `acp-profile.test.ts`, `@agentclientprotocol/sdk` | **Drop** | — | No capability gain over SDK inside the worker [a0 A0-SLICE3.md:140]. Shep dropped ACP drivers too [shep research/DECISIONS.md:53-62]. A0 stays the evidence. |
| `session.ts` | **Port with tests** | P1 | exmach-derived reader with an offset index; P2 adds root-pinned reads for sandboxes. |
| `events.ts` | **Rewrite** around a typed event manifest | P1 | Keep the synchronous attach barrier, bounded queues (64 events, 256 KiB) and overflow-then-close [a0 src/events.ts:12-31]. Replace `publish(type: string, data, …, durable)` [a0 src/events.ts:14] with generated per-event publishers; durable events publish only from a journal append result (borrow study section 6 [nubl .pi/plan/research/opencode-borrow-study.md:183]). |
| `server.ts` | **Rewrite** | P0 | The hand-written subset validator and manual schema names [a0 src/server.ts:16-48], plus responses serialized without validation [a0 src/server.ts:50-52], are the "contract closure" gap the borrow study names [nubl .pi/plan/research/opencode-borrow-study.md:46-50]. Keep `listenPrivate` (0700 directory, 0600 socket, owner check) [a0 src/server.ts:195-204] and the body cap. |
| `client.ts` | **Port into `client-ts`** | P0 | One attempt, `agent: false`, `ClientFailure` with before-write `no_effect` and after-write `unknown` [a0 src/client.ts:26-51]. |
| `cli.ts` | **Rewrite** over `client-ts` | P1 | Same commands, typed; grant registration stays local file access, never HTTP. |
| `grants.ts` | **Rewrite** | P1 | Keep method, scope and revocation checks at dispatch and release. Store a hash of the bearer, not the bearer: A0 keeps the token in the registry record [a0 src/grants.ts:8-20]. |
| `supervisor.ts` | **Rewrite**, split by domain | P1 to P2 | One 902-line module carries lifecycle, input, fence, recovery, children, staging and relaunch [a0 src/supervisor.ts:35]. Split into `supervisor/` modules behind the ported tests. |
| `containment.ts` | **Port with tests** | P2 | cgroup v2 domains, `cgroup.kill`, wait for `populated 0`, remove; domain recorded before spawn; installation-owned startup sweep [a0 src/containment.ts:17-71]. |
| `process.ts` (process-group fallback) | **Drop** (decision D3) | — | Linux only, and every target host runs a systemd user manager. The daemon refuses to start without delegated cgroup v2; `doctor` explains. The fallback never authorized relaunch or reuse anyway [a0 README.md:67]. |
| `pinned-fs.ts`, `sandbox.ts`, `git-sandbox.ts` | **Port with tests** | P2 | Descriptor binds (`--bind-fd`, `--ro-bind-fd`), `--die-with-parent`, `--clearenv` [a0 src/sandbox.ts:76-78], read-only Git pointers, D1 dependency binds, D2 always-unknown staging rule. Each guard has a reversion in A0's evidence. |
| `git-safe.ts`, `artifact.ts` | **Port with tests, then fix two review findings** | P2 | Owner Git on a private snapshot of pinned metadata, executing config refused, global config ignored [a0 src/git-safe.ts:69] [a0 src/git-safe.ts:147-159]; commit and tree subject. A0's tip still trusts the `TMPDIR` string for the snapshot location and sets only the general `protocol.allow` [nubl .pi/plan/research/a0-slice7-security-git.md:23-47]; P2-6 fixes both. |
| Parent channel (in `server.ts`) | **Port with tests** | P2 | Per-generation socket, its own grant, restricted method set, O_NOFOLLOW child root. Slice 7's B1 escape is the reason every rule here exists. |
| Children core: typed launch spec, `children.launch`, lineage, FD-3 report, report receipts, missing-report fence | **Port with tests** | P1 (unsandboxed); P2 adds bwrap and the parent channel | Frozen rows 04 to 06, the invariants and the core crash matrix launch real child processes (review F1), and most P2 security tests create typed children [a0 src/test/gate1-parent.test.ts:83] [a0 src/test/sandbox.test.ts:174-196]. Maestro integration stays P3. |
| `api.generated.ts`, `types.ts`, `openapi.json` | **Regenerate** from the new source | P0 | The A0 spec seeds `api/b2.openapi.yaml` (21 operations, 32 schemas); operationIds become the contract's method names. |
| `evidence/*` harness scripts | **Port the patterns** into `harness/lib` | P0 | Evidence record bound to commit and tree, privacy scan, reversion runner, VM setup from a git bundle. Not the job-specific scripts. |

### 3.2 Tests

| A0 tests | Tier in production | Phase |
| --- | --- | --- |
| `conformance` (fixture replay) | conformance (frozen) | P0 runner; rows green per section 5.1, all by P1-11 |
| `invariants` | conformance (frozen) | cases green with their module (P1-6, P1-7, P1-10); whole file by P1-11 |
| `receipts` | crash | P1-2 |
| `interaction-crash` | crash | P1-10 |
| `children-crash` | crash | P1-11 |
| `crash-matrix`, `gate1-pi-cuts` | crash | P1-13 |
| `transport` | conformance | client classification cases at P0-5 (against the P0-4 server); stream, snapshot and overflow cases at P1-8 |
| `gate1-native-binding` | conformance | P1-7 |
| `grants` | conformance | P1-9 |
| `binding-answer-race`, `gate1-sibling`, `interactions` | conformance | P1-10 |
| `children` | conformance | P1-11 |
| `containment` | security (kernel cases) | P2-1, except the sweep cases (P2-2, `sweep.test.ts`) |
| `relaunch`, `slice5-followups`, `review5-fixes`, `issue1-stop`, `stop-superseded` | regression | P2-3 |
| `containment-crash` | security | P2-4 (its scenario needs domains, sweep, relaunch, a bwrap-declared typed child and a report) |
| `sandbox` | security (kernel cases) | P2-4 |
| `gate1-git` | security (kernel) | P2-5 |
| `owner-git`, `gate1-artifact` | security | P2-6 |
| `gate1-fix` | security | P2-7, except `kernel D1` (a channel child), which is P2-8 |
| `gate1-parent` | security (kernel) | P2-8 |
| `security-fix` | security | split by guard: m4 at P1-7; bwrap profile, kernel B1 bind and `--die-with-parent` at P2-4; M1 Git mounts and m2 at P2-5; M1 fsmonitor at P2-6; B2 staging at P2-7; the other B1 cases, m1 and the live topology at P2-8. m3 is RPC-only: rewritten for the SDK host at P1-7 or recorded as dropped with RPC in `PORTED.md` |
| `supervisor`, `host`, `slice2-fix`, `fix-round` | regression | with their module (P1-3 to P1-8); each case at the first PR whose methods it calls |
| `acp-profile` | dropped (ACP dropped) | — |
| `merged-host-children` | replaced by the Maestro M5 journey | P3 |

**Rule for mixed files.** A ported file whose cases need different PRs is ported case by case: each case lands in
the first PR where every method it calls exists, with its assertions unchanged, and `PORTED.md` records case →
PR. No case is marked `skip` to pass an earlier gate.

A test that reaches into A0 internals is rewritten to drive B2 and the host seam, with the same assertions. The
fixture seams stay: a deterministic fake host, `PIW_CRASH_AT` SIGKILL after a real fsync, and independent native
artifacts as the effect oracle.

## 4. B2 single source: the OpenAPI pipeline

### 4.1 Pipeline

`api/b2.openapi.yaml` (OpenAPI 3.1) → `npm run generate`:

1. **Redocly CLI** lints with custom rules (every operation has an `operationId` equal to a contract method name;
   every 4xx and 5xx response uses `Error`; every mutation requires `command_id` and declares `x-piw-mutation`;
   every event schema declares `x-piw-event` with producer, durability and visibility; every operation declares
   `x-piw-body` and every success response `x-piw-response`, and a non-JSON body declares `x-piw-max-bytes`) and
   bundles to `api/generated/b2.json`. One tool does both jobs.
2. **openapi-typescript** emits the TS types for the worker and for `client-ts`.
3. **Ajv** (`Ajv2020`, JSON Schema 2020-12, which is OpenAPI 3.1's dialect, with `ajv-formats`) compiles **standalone
   validators** for every JSON request body, every JSON response per status, every SSE event payload, and the
   header and parameter schemas of binary and NDJSON operations. They are generated code, so startup does no schema
   compilation and a review sees the diff. Standalone output imports small Ajv and ajv-formats runtime helpers, so
   both are pinned runtime dependencies of the worker.
4. **`tools/codegen`** (in-repo, about 200 lines) emits three tables from the bundled spec: the TS route table
   (`operationId`, method, path, parameters, body mode, media types, byte limit, response mode, request validator,
   response validators, mutation flag, grant method); the TS event publishers; and the Go operation table.
5. **oapi-codegen v2.8.2**, models only, emits `clients/go/b2/models.gen.go`. It supports OpenAPI 3.1
   [oapi README.md:2324-2326] and a models-only mode for hand-rolled clients [oapi README.md:867-869].
   `exclude-schemas` [oapi pkg/codegen/configuration.go:461] leaves the event union to a hand-written decoder.

`npm run check:generated` reruns everything and fails on any diff. It covers the bundle, TS types, validators,
tables, Go models and the Go table.

### 4.2 Server-side validation and contract closure

- The router is built from the generated route table. Its handler map is typed as
  `{ [K in OperationId]: Handler<K> }`, so a missing handler is a compile error. An operation the server does not
  implement yet is marked `x-piw-status: unsupported` in the spec and answers `501`, `effect: no_effect`.
- **Body modes.** Every operation's body mode, media types and byte limit come from the spec through the route
  table; the router applies them before the handler runs. Refusals below are all `effect: no_effect` and happen
  before any journal write.

  | Mode | Used by | Limit | Validation |
  | --- | --- | --- | --- |
  | `json` (default) | every operation except those below | 256 KiB (as A0); an operation may declare less | `application/json` only (else `415`); over the cap `413 request_too_large`; then the generated Ajv validator (`400 request_schema_mismatch`) |
  | `binary` | `attachments.stage` (`PUT /b2/attachments/{attachment_id}`) | per attachment `attachment_max_bytes`, default **2 MiB**; the per-message count and total (default **4** and **8 MiB**) are checked when `sessions.prompt` references attachments. All three are advertised in `hello` | `image/jpeg`, `image/png` or `image/webp` (else `415`). The body streams to a private staging file with a byte counter and closes at the limit (`413 attachment_too_large`, file removed). Ajv validates the path and header parameters (`command_id`, `worker_id`, binding, declared SHA-256). After the last byte: SHA-256 must equal the declared hash and the magic bytes must match the content type (`400`), then one journal record makes it `staged` |
  | `none` | reads with no body | 0 | a body is `400` |

  The defaults equal Shep's current limits [shep bridge/photos.go:49-55]. They change only by agreement with Shep
  (question S-4). The upload is the same endpoint whether the bridge keeps its own copy or forwards the phone's
  upload stream; S-4 decides only which of those the bridge does.
- **Response modes.**

  | Mode | Used by | Validation |
  | --- | --- | --- |
  | `json` | every operation except those below | the generated validator for the status, before writing |
  | `sse` | `events.subscribe` | each frame's payload is validated against its event schema before it is queued; a frame that fails is never sent: the stream sends `overflow` and closes, the worker logs `invalid_frame`, and the client resyncs from a snapshot as after any overflow |
  | `ndjson` | `history.page` with `format=jsonl` (if Shep picks shape (a), S-1) | headers (file identity, next offset, watermark, reset) are validated against a header schema; the body is pi's session-file lines, passed through unparsed except that each line must be one complete JSON value and the response ends on a line boundary. B2 does not own pi's entry schema, so it does not validate entry contents |
  | `binary` | `blobs.read` | content type from a fixed image allowlist, `Content-Length` within the advertised blob cap, headers validated against a schema |
- **Responses:** every response is validated before it is written, in production too. A read that fails is `500`,
  `response_schema_mismatch`, `no_effect`. A mutation that fails after its dispatch record is `500` with
  `effect: unknown` and the `command_id`, so the caller reads the receipt. A validation failure never becomes a
  retryable error (the borrow study's risk note [nubl .pi/plan/research/opencode-borrow-study.md:52-54]).
- **Embedded mode:** the same request handler runs over an injected in-memory transport for tests and
  single-process use; there is no second supervisor implementation.
- **Closure tests:** every spec operation is routed, every route is in the spec, every operation has at least one
  wire fixture, every wire fixture validates, and every operation declares its body and response modes. Binary
  routes have wire tests for a body above 256 KiB that is accepted and a body one byte over the limit that is
  refused (P0-4 against the 501 handler; P1-16 against the real one).

### 4.3 Clients

| | TypeScript (`client-ts`) | Go (`clients/go`) |
| --- | --- | --- |
| Generated | Types (openapi-typescript), route table | Models (oapi-codegen), operation table |
| Hand-written | `node:http` over the socket, `agent: false`, one attempt; SSE reader; `ClientFailure` classification (ported from A0); streamed attachment upload | `http.Transport` with a Unix dialer and `DisableKeepAlives`; `httptrace.ClientTrace.WroteRequest` decides before-write `no_effect` vs after-write `unknown`; SSE loop; event decoder; streamed attachment upload (an upload that fails after write is `unknown`: read `attachments.status`, never re-upload); peer UID check (`SO_PEERCRED`) before the bearer is sent |
| Retries | None. Reconnect is the caller's decision and always starts with a snapshot. | Same |
| Runtime floor | Node 22.19 (pi's floor), tested on 22 and 26 | Go 1.24 (Shep's `go.mod` [shep bridge/go.mod:3]); generated with Go 1.26.11 in the separate `tools/go` module |
| Dependencies | none at runtime | **standard library only**, enforced in CI with `go list -deps` |
| Drift check | `check:generated` | `check:generated`, then build, vet and test `clients/go` (generated models included) on Go 1.24.13 and Go 1.26.11 |

**Why these Go choices.** ogen generates a whole client and server with a heavy runtime
(OpenTelemetry, zap, go-faster) [ogen go.mod:5-30], and its SSE clients reconnect automatically
[ogen README.md:692-695], which breaks "no hidden retries" and "SSE loop by hand". oapi-codegen's own client
generator would pull `github.com/oapi-codegen/runtime` into a bridge that has two dependencies
[shep bridge/go.mod:5-8], and classification has to be hand-written anyway. openapi-generator needs a Java
toolchain for the same result. Models-only oapi-codegen plus our operation table keeps one source, no runtime
dependency, and contract-mandated hand-written transport.

**Why no `openapi-fetch` in TS.** `fetch` hides whether request bytes reached the socket, which is exactly the
`no_effect` versus `unknown` boundary.

**Versioning.** Paths are unversioned under `/b2/`. `hello` negotiates `protocol {major, minor}`; a client refuses
an unknown major. The catalog stays at major 0 until the P6 freeze.

### 4.4 Tool and generator pins

Every tool that writes a committed file or decides a build is pinned to an exact version. npm packages use exact
versions in `package.json` (no `^` or `~`), `package-lock.json` is committed, and CI installs with
`npm ci --ignore-scripts`. A version bump is its own PR, with the regenerated files and a clean
`check:generated`.

| Tool | Version | Where pinned | Role |
| --- | --- | --- | --- |
| Node (daemon, CI) | 26.13.1 (`engines.node >=26.12.1`) | `.node-version` (P0-1), read by CI and the release job | runtime, build |
| Node (client floor) | 22.19.0 | CI matrix | `client-ts` tests |
| TypeScript | 5.9.3 | root `package.json` (P0-1) | compile |
| `@types/node` | 26.6.6 | root `package.json` (P0-1) | types |
| `@redocly/cli` | 2.78.0 | root `package.json` (P0-2) | lint, bundle |
| `openapi-typescript` | 7.13.0 | root `package.json` (P0-3) | TS types |
| `ajv` | 8.20.0 | `packages/worker` dependencies (P0-3) | standalone validators and their runtime helpers |
| `ajv-formats` | 3.0.1 | `packages/worker` dependencies (P0-3) | formats |
| oapi-codegen | v2.8.2 | `tools/go/go.mod` `tool` directive, `go.sum` (P0-6) | Go models |
| Go (generation) | 1.26.11 | `tools/go/go.mod`: `go 1.25.0` (oapi-codegen v2.8.2's floor [oapi go.mod:3]), `toolchain go1.26.11`; CI installs exactly 1.26.11 | runs oapi-codegen |
| Go (consumer) | 1.24.13 | `clients/go/go.mod`: `go 1.24`, no `toolchain` line; CI installs exactly 1.24.13 | builds and tests the client as Shep will |
| GitHub Actions | full commit SHA | workflow files | CI |

Versions were current on 2026-11-16 (npm registry; go.dev release list). Go 1.24 and 1.25 no longer get upstream
fixes; 1.24 is only the client's language floor, matching Shep [shep bridge/go.mod:3], and 1.26 is a supported
release that satisfies oapi-codegen's floor. CI sets `GOTOOLCHAIN=local` for every Go step, so a `go` or
`toolchain` line can never make Go download an unrecorded compiler; a mismatch fails the job instead. The
generation smoke test compiles the real generated `models.gen.go` with the rest of `clients/go` under Go 1.24.13
and runs the stdlib-only gate on it, so a newer generator cannot raise the client's floor unnoticed.

## 5. The conformance suite

- **Contract rows.** `api/fixtures/transitions.json` is A0's fixture at revision 8 (eleven rows, `01-binding` to
  `11-control`) [a0 src/test/fixtures/transitions.json:4]. Its semantic fields (row id, from, event, to,
  assertions) are hashed; a test pins the hash. `call` bodies are wire data and may migrate when the catalog
  changes, in a PR that changes no assertion. The replay runner is a port of A0's conformance test
  [a0 src/test/conformance.test.ts:1].
- **Invariant and crash tiers.** Invariants 1 to 8 (A0's `invariants` tests) and fsync cut matrices. Every durable
  point is a labelled call (`durable('prompt.dispatch')`); a test fails if a label has no cut scenario. That test
  lands in P1-1, so every later PR that adds a label adds its cut in the same PR. A0 ran 364
  selected fsync cuts plus native-effect cuts [a0 A0-SLICE7.md:99]; production keeps the oracles (independent
  native artifacts, never receipts alone).
- **Security tier.** Containment, sandbox, owner Git and parent-channel tests, with kernel tests under a delegated
  user service. Each guard has a recorded reversion that fails by assertion.
- **Go side.** `workerfake` replays the same `transitions.json` through the Go client (P1-17), so the fake Shep
  tests against cannot drift from the worker's behaviour.
- **Rule:** an assertion in the conformance or security tier is never weakened. A frozen row changes only with a
  contract revision.

### 5.1 When each frozen row turns green

P0-7 runs all eleven rows as `todo`. A row stays `todo` until the PR that completes every method and state it
touches; that PR removes the row's `todo` marker and changes nothing else in the fixture (the hash test proves it).

| Rows | What they need | Green at |
| --- | --- | --- |
| 02, 03, 07, 08 | `sessions.prompt` (P1-5); fence latch, fenced-write refusal and `sessions.resolve_unknown` (P1-6) | **P1-6** |
| 09 | restart records `cleanup_pending` (P1-4); prompt (P1-5); restart fence for an unsettled prompt (P1-6) | **P1-6** |
| 11 | the `unknown` macro (P1-5, P1-6); `executions.cancel` and `executions.interrupt` (P1-5) | **P1-6** |
| 01, 10 | `sessions.rebind` new and resume (P1-7); restart (P1-4) | **P1-7** |
| 04, 05, 06 | the `queued` macro: a held prompt and follow-up (P1-5), `children.launch` that spawns a second host on keep (P1-11), queue pause, keep and abandon (P1-6) | **P1-11** |

From P1-11 the runner **fails on any `todo` row**, so all eleven are green when P1 closes and stay green on every
later PR (CI runs the frozen tier on every push). The `invariants` file is green as a whole at P1-11 (its binding
case needs P1-10's interactions, its child cases P1-11). The core crash matrix, including its child-launch cuts, is
green at P1-13. P2 adds sandboxed variants; it never re-scopes a P1 row.

## 6. CI

| Workflow | Runs on | Steps |
| --- | --- | --- |
| `ci.yml` (every push and PR) | GitHub-hosted `ubuntu-24.04`, Node 26 | `npm ci --ignore-scripts`; `npm run check` (lint spec, typecheck, build, unit, regression, conformance, crash, portable security); `npm run check:generated` (generation on Go 1.26.11); `client-ts` tests on Node 22.19; `clients/go` on Go 1.24.13 and 1.26.11 with `GOTOOLCHAIN=local`: `go vet`, `go test -race`, stdlib-only gate; cross-language test (Go client against the built worker) |
| `kernel.yml` (every PR touching `containment/`, `sandbox/`, `owner-git/`, `b2/` channel code including the Go client's `clients/go/b2/` auth, and nightly) | Primary: GitHub-hosted `ubuntu-24.04`. Fallback: an ephemeral self-hosted runner on an exe.dev tester VM | Enable linger, install bubblewrap, allow unprivileged user namespaces for the job, then run the suite inside `systemd-run --user --pipe --wait -p Delegate=yes` with `PIW_TEST_KERNEL=1`; require 0 skips; stop every `piw-*` unit; fail on leftovers |
| `release.yml` | P4 | section 7 |

Actions are pinned by full SHA (A0's CI did this [a0 .github/workflows/ci.yml:18-21]). No secrets in `ci.yml` or
`kernel.yml`. Whether the hosted runner can delegate cgroups and run bwrap under Ubuntu 24.04's AppArmor user
namespace restriction is **unverified**; P0-8 settles it. A0 ran its kernel suite only on a local host and the
`a0-worker` VM [a0 A0-GATE1-RERUN.md:19].

## 7. Packaging: how a host gets the daemon and Node

- **Artifact:** `pi-worker-<version>-linux-<x64|arm64>.tar.gz` holding `dist/`, production `node_modules`
  (`npm ci --omit=dev --ignore-scripts`), the CLI, the systemd unit template, and the **official Node 26 binary**
  at a pinned version. The release job checks the Node tarball against `SHASUMS256.txt` and that file's GPG
  signature (A0's VM checked the SHA but not the signature [a0 A0-GATE1-RERUN.md:113]). `SHA256SUMS` covers every
  asset.
- **Why bundle Node:** distributions ship older Node, pi's floor is 22, and the daemon needs 26. A bundled runtime
  also pins what the SDK child runs, since the host spawns it with `process.execPath`.
- **Why not a single executable:** the pi SDK loads the user's extensions and skills from disk at runtime and the
  host spawns a child Node process. A tarball keeps both plain.
- **Layout on a host:** `~/.local/share/nubl/pi-worker/<version>/` with a `current` symlink; state in
  `$XDG_STATE_HOME/pi-worker/`; unit `pi-worker.service` (user) with `Delegate=yes`, `Type=exec`,
  `ExecStart=%h/.local/share/nubl/pi-worker/current/node/bin/node …/dist/main.js`; linger enabled by the installer.
- **pi version:** the worker pins the pi SDK in its own `node_modules` (1.5.2 today), independent of the host's
  `pi` CLI. A pi upgrade is a worker release with the real-Pi tests rerun.
- **Install paths:** P1 to P3 journeys install from a git bundle built on the VM (A0's pattern, no GitHub
  credential on the VM). P4 adds `pi-worker install|upgrade|rollback`, and Shep's host installer offers it as an
  option. The release channel is decision D2.

## 8. Live-journey harness on exe.dev VMs

- **VM lifecycle** follows the `exe-dev-test-vm` skill: `ssh exe.dev new --name=piw-<milestone>-<run> --no-email
  --json`, wait for SSH, run the journey, export evidence, `ssh exe.dev rm`. P0 to P4 journeys need no tailnet (the
  worker has no network listener); P5's phone journey joins the VM as `tag:tester` with the pre-signed key over
  stdin, never in argv, a file or the environment.
- **Setup:** user-local Node 26 from the official tarball (SHA and signature checked), the exact commit from a
  `git bundle`, `npm ci --ignore-scripts`, both suites on the VM (default and kernel), then the journey.
- **Models:** the VM's exe.dev LLM provider, as A0 used [a0 A0-GATE1-RERUN.md:118]. No host credential is copied.
- **Evidence:** each journey writes `docs/evidence/<milestone>/<run>/` with `checks.json` bound to commit and
  tree, platform (kernel, bwrap, Git, Node, pi versions), the attention record, cleanup proof (0 `piw-*` units, 0
  leftover cgroup domains), and a privacy scan result. Failed attempts are kept and labelled, never counted.
- **Journeys:** `p0-hello` (daemon up, both clients say `hello`), `p1-chat`, `p2-containment`, `p3-fanout`
  (pstack fan-out through Maestro), `p4-upgrade-rollback`, `p5-shep` (phone, bridge, worker).
- **Rule:** never on ms-a2 or hetzner before P4 passes on a VM [nubl .pi/plan/pi-worker-production.md:33].

## 9. P0: Foundation

Done when (milestone plan): layout, CI (Linux, Node 26), OpenAPI as single source with server validation and
response checks, TS and Go clients generated and drift-checked, section 0.1 fixtures running as conformance tests.

| PR | Scope | Completion criterion | Verification |
| --- | --- | --- | --- |
| **P0-1** Skeleton | npm workspaces, `engines.node >=26.12.1`, strict `tsconfig`, `node --test`, `AGENTS.md`, `docs/plan/`, `ci.yml` with build and test | CI green on `main`; `npm run check` passes on a clean clone | `npm ci --ignore-scripts && npm run check` |
| **P0-2** Spec source and lint | `api/b2.openapi.yaml` seeded from A0's spec: operationIds = contract method names, `Error {error, effect, …}`, `x-piw-mutation`, `x-piw-event`, unversioned `/b2/` paths, `hello.protocol`; Redocly rules and bundle | Lint passes; each custom rule has a failing example in `api/lint-fixtures/` | `npm run api:lint && npm run api:bundle` |
| **P0-3** TS generation | openapi-typescript types, Ajv standalone validators, route and event tables (with body and response modes, section 4.2), `check:generated`, exact pins (section 4.4); P0-2's body-mode additions if P0-2 was not amended | Generated files committed; a spec edit without regeneration fails CI (shown on a throwaway branch, logged in the PR) | `npm run generate && npm run check:generated` |
| **P0-4** Server skeleton with closure | Router from the route table, Unix socket (0700/0600, no TCP), per-route body modes (JSON cap and Ajv, streamed binary with a byte counter), response validation, in-memory transport, **`hello`** (static protocol, capabilities and limits), every other operation `501 no_effect` | Closure tests pass; `hello` answers and validates; a 1 MiB body reaches the binary route's 501 while the same body to a JSON route is `413`; removing response validation or one route fails a test (reversion logged) | `npm test -w @nublai/pi-worker -- --test-name-pattern=closure` |
| **P0-5** TS client | `client-ts` with A0's transport and `ClientFailure`, SSE reader, ported `transport` tests | Classification tests pass on Node 22 and 26 | `npm test -w @nublai/pi-worker-client` (CI matrix) |
| **P0-6** Go client | `clients/go` models (oapi-codegen v2.8.2 via `tools/go`, `go 1.25.0`, `toolchain go1.26.11`), op table, transport, SSE, classification tests, stdlib-only gate | Generation runs on Go 1.26.11; `go test -race ./...` passes on Go 1.24.13 and 1.26.11 with `GOTOOLCHAIN=local`; the Go client gets `hello` and a `501` from the P0-4 server in CI | `cd clients/go && GOTOOLCHAIN=local go vet ./... && go test -race ./... && go test -tags integration ./...` (each Go version) |
| **P0-7** Conformance runner | `api/fixtures/transitions.json` (rev 8), semantic-hash test, replay runner, every call body validated against the spec; rows run as `todo` | Runner lists 11 rows as `todo`, hash test passes, all bodies validate | `npm run test:conformance` |
| **P0-8** Kernel CI tier | `kernel.yml`, `harness/ci/kernel.sh`: delegated user unit, cgroup v2 create/kill/remove smoke test, bwrap `--unshare-user` smoke test | Smoke tests pass with 0 skips on the chosen runner, log names cgroup path and bwrap version, 0 units left. If the hosted runner cannot, the exe.dev runner path lands instead (decision D4) | `harness/ci/kernel.sh` in the `kernel` workflow |
| **P0-9** Harness skeleton and P0 journey | `harness/vm/*`, evidence record, privacy scan, `p0-hello` journey | Journey passes on a fresh VM; evidence committed; VM deleted | `harness/run.sh p0-hello` |

P0 review: one cross-family review of the pipeline and closure (P0-2 to P0-7) before P1 builds on it.

## 10. P1: Core supervisor

Done when: SDK host; receipts and fsynced journal; binding and fence; interactions; events over SSE with snapshot;
history; grants; crash cuts at every durable point; conformance green. Plus, by amendment D5, the unsandboxed
child core that the frozen rows and invariants exercise.

Each PR's gate uses only methods from that PR and the PRs in its **Deps** column. Rows not yet green run as `todo`
(section 5.1). Between PRs, `main` is a development state: nothing is released or installed before P1 closes, and
until P1-9 lands the socket's 0700/0600 modes are its only access check.

| PR | Deps | Scope (ported from) | Completion criterion | Verification |
| --- | --- | --- | --- | --- |
| **P1-1** Journal and fsync points | P0 | Journal rewrite, `durable(label)`, `PIW_CRASH_AT` / `PIW_TRACE_FSYNC` (`journal.ts`, `fsync.ts`); the label-coverage test | Append, torn-tail and parse tests pass; a SIGKILL after each labelled fsync recovers a parseable journal; a label with no cut scenario fails the coverage test (reversion logged) | `npm run test:crash -- journal` |
| **P1-2** Receipts | P1-1 | `receipts/` (`receipts.ts`, `receipts` tests): reserve, intent, dispatch, result; `ProvenNoEffect`; recovery buckets; the `receipts.get` route | Ported tests pass; reversions of "default refusal after dispatch is `no_effect`" and "dispatch marker after write" fail; `receipts.get` wire fixture | `npm test -- receipts` and `harness/lib/reversions.mjs receipts` |
| **P1-3** SDK host and child | P0 | `host/`, `sdk-child/` (no ACP), resolvers, readiness (resources loaded, no loader errors), native binding observer | Real-Pi tests with no model call pass: start, ready, inventory, `/new`, tree, fork observed at the host seam; fake-host tests pass | `npm test -- host` (real pi 1.5.2, no credentials) |
| **P1-4** Worker lifecycle | P1-2, P1-3 | `workers.create/list/get/stop`, one live writer per session, exclusive cwd, holder named in refusals; restart kills pi and records `cleanup_pending`. Until P2's cgroup domains can confirm cleanup it stays pending, so a restarted worker is not resumable in P1 (invariant 2) | Lifecycle cases of the ported `supervisor` tests pass; duplicate-open refusal names the holder; after a restart `workers.get` shows `cleanup_pending` and the old pi process is gone | `npm test -- lifecycle` |
| **P1-5** Input and executions | P1-4 | `sessions.prompt/steer/follow_up`, `if_busy`, supervisor-owned follow-up queue (cap 32), admission vs start vs `agent_settled`, `executions.cancel/interrupt` with requested/observed/unknown; the binding check on every session-directed mutation (`stale_binding`, `no_effect`); a lost reply after the dispatch record gives `outcome_unknown` | Seam tests on the fake host for each method; stale binding refused `no_effect`; a dropped reply yields an `outcome_unknown` receipt with no replay; control effect cuts (cancel, interrupt, stop) find effect-bearing receipts | `npm test -- input && npm run test:crash -- control` |
| **P1-6** Fence and resolution | P1-5 | Fence latch with generation, durable before the refusal it causes; fenced writes refused naming the uncertain command; cancel, interrupt and stop allowed under a fence; `sessions.resolve_unknown` (keep, abandon, observed with exact settlement evidence); queue pause, keep and abandon for follow-ups; restart fence for an unsettled execution | Rows **02, 03, 07, 08, 09, 11** green; the `invariants` resolve, generation, recovered-intent and abandon-queue cases green | `npm run test:conformance -- 02 03 07 08 09 11 && npm test -- invariants` |
| **P1-7** Binding changes | P1-6 | `sessions.rebind` (new, fork, resume, navigate), `sessions.new`, native move handling (pre-move signal, 15 s reconcile) | Rows **01, 10** green; `gate1-native-binding` and `security-fix` m4 green; m3 rewritten for SDK or recorded as dropped with RPC | `npm run test:conformance -- 01 10 && npm test -- binding` |
| **P1-8** Events and history | P1-7 | Event manifest, SSE endpoint (per-frame validation, section 4.2), attach barrier, snapshot with workers, fences, history marker and lag, overflow; worker-bound `history.page` and `items.read` (`events.ts`, `session.ts`). `blobs.read` moved to P1-16 and worker-free archived `history.page` to P1-14 (root, 2026-11-16) | Overflow closes and forces resync; the SSE cases of `supervisor` and `transport` green; an invalid frame is never sent; every event validates against its schema | `npm test -- events history` |
| **P1-9** Grants | P1-8 | `grants/` rewrite: registration by local file access only (a `grant` command of the daemon package, wrapped by P1-18's CLI; never HTTP), bearer hash at rest, method and scope check at dispatch, revocation rechecked at dispatch | Ported `grants` tests green: a bearer on every route including `hello`, history, SSE and receipts; scoped inventory and SSE disclose no other worker; revocation between queue admission and dispatch blocks the Pi write | `npm test -- grants` |
| **P1-10** Interactions | P1-7, P1-8, P1-9 | `interactions/` (`interactions.ts`): four kinds, offered option ids, absolute deadline, stages 1 to 3 and the stage-4 gate release, restart → `interrupted`, sibling settlement, `interactions.changed`, live cards in the snapshot, release rechecks the grant | Ported `interactions`, `gate1-sibling`, `interaction-crash` and `binding-answer-race` green; the `invariants` binding case (pending interaction cancelled on rebind) green; a grant revoked between answer and release blocks release; snapshot restores live cards; history never creates a live interaction; the six slice 3 killing mutations fail | `npm test -- interactions && npm run test:crash -- interactions` |
| **P1-11** Children core (unsandboxed) | P1-6, P1-9, P1-10 | Typed launch spec (a subset of the parent's grant, tools, environment and resources), `children.launch` queued under the parent execution, lineage durable before spawn, FD-3 report pipe (host and SDK child), `children.report` receipts outside the count quota, missing-report parent fence on recovery, `help` reports never discharge it (from A0's `supervisor.ts`, `host.ts`) | Rows **04, 05, 06** green, so **all eleven**; the runner now fails on any `todo` row; the whole `invariants` file green; ported `children` and `children-crash` green | `npm run test:conformance && npm test -- children invariants && npm run test:crash -- children` |
| **P1-12** Retention | P1-11 | Receipt and journal retention, compaction with crash cuts, limits in `hello`; stop, cancel, interrupt, resolve and child reports never blocked by count quota | 10,000 receipts on a test journal stay within the advertised bound; a compaction cut recovers; unresolved `outcome_unknown` receipts are never evicted | `npm run test:crash -- compaction` |
| **P1-13** Crash-cut coverage | P1-12 | Port `crash-matrix` (with its child-launch and report cuts) and `gate1-pi-cuts` | Every `durable()` label has a cut; pi-leader SIGKILL cuts pass; native-effect oracles find no `no_effect` effect and no duplicate; no blind replay | `npm run test:crash` |
| **P1-14** Phone inventory and features | P1-8, P1-11 | From contract 8.1: `workers.list` fields (settle counter, `status_since`, cwd, repo label, `lineage`, `parent_worker_id`), `sessions.list/get` (archived, 100 per folder), worker-free archived `history.page` by `session_id` (moved from P1-8), `models.list`, `commands.list` per cwd, `session.configure` (model, thinking, name), `command_id` stamped into a pi custom entry | Wire fixtures for each; `observed` resolution matches a stamped `command_id`; `session.configure` refused under a fence and on a stale binding; an archived session's history reads by `session_id` with no worker bound to it, within the grant's scope | `npm test -- inventory features` |
| **P1-15** Session commands | P1-14 | `sessions.compact`, `resources.reload`, `commands.invoke` (extension commands from `commands.list`; a built-in that has its own method, such as `/new` or `/model`, is refused `use_method` naming it; other built-ins refused `unsupported_command`). Each is a session-directed mutation: `command_id`, binding, refused `no_effect` under a fence or while an execution runs, a dispatch record, then `outcome_unknown` and a fence on a lost reply | Wire fixtures; fence, busy and stale-binding refusals are `no_effect`; one effect cut per method finds an effect-bearing receipt (oracles: the compaction entry in the session file; the fake host's reload and command logs); real-Pi no-model tests for reload and a fixture extension command; compaction with a real model runs in `p1-chat` | `npm test -- session-commands && npm run test:crash -- session-commands` |
| **P1-16** Attachments and images | P1-5, P1-8 | `attachments.stage` (streamed binary upload, section 4.2), `attachments.status`, `attachments.release`; image blocks into `sessions.prompt`; per-message count and total; exact accepted image count; `blobs.read` (an entry's image blob, binary response mode, moved from P1-8) | A 1.5 MiB JPEG is accepted; one byte over `attachment_max_bytes` is `413 no_effect` with no staged file; SHA-256 or magic-byte mismatch is `400 no_effect`; after a dropped response `attachments.status` reconciles with no re-upload; a fifth photo or more than 8 MiB in one prompt is refused `no_effect`; a real-Pi image prompt (no model) shows the image block in the session file; `blobs.read` returns that image within the advertised blob cap with a validated content type | `npm test -- attachments` |
| **P1-17** Go fake and Go replay | P1-11, P1-14, P1-15, P1-16 | `clients/go/workerfake`; Go replay of `transitions.json`; SSE reconnect tests; Go streamed upload | The fake passes the eleven rows through the Go client under `-race`; it answers every `bridge`-profile operation ([b2-for-shep.md](b2-for-shep.md) section 2.1) from its wire fixtures; a 1.5 MiB upload through the Go client succeeds and a dropped response reads `attachments.status` | `cd clients/go && go test -race ./workerfake/...` |
| **P1-18** CLI | P1-17 | `packages/cli` over `client-ts`, including `grant register/revoke` | Every A0 CLI command works against the P1 daemon in the journey | `harness/run.sh p1-chat` |
| **P1-19** The event set Shep needs | P1-17 | The rest of the [b2-for-shep.md](b2-for-shep.md) section 3 table, which Shep's P5-2 read model (shep PR #289) found missing: `execution.admitted`, `execution.started` (journal), `receipt.updated`, `fence.set`, `attachment.updated` (journal), and `assistant.delta`, `tool.started`, `tool.finished` from pi's own SDK events (memory, producer `pi`, never replayed; a delta carries the text tail, at most 2,048 characters, and a backpressured subscriber holds one undelivered delta per worker); `execution.settled` names its command. Worker rows carry `recent_settlements` (execution, command, disposition, time; newest first, cap 8), journaled with the row. The Go fake streams every new event, keeps the delta bound, and fills `preview` and `last_activity_at` from its history. `workers.create` takes `first_prompt` (Shep P5-3; text only, no attachments): one command, one receipt naming the worker and the first execution's admission (`execution_id`, `disposition`) or its typed refusal with the worker created; the execution id is durable in the receipt before the prompt reaches pi, a lost pi reply fences the new session on the create, the text is never journaled, and the grant needs `sessions.prompt` too. Worker rows (snapshot, `worker.updated`, reads) carry `first_user_line` (Shep P5-2 title fallback): the first line of the session's first user text, marker stripped, trimmed, at most 280 characters, null when none, from the session file like `preview`, in the worker and the Go fake | Tests red on base for each new event and for `recent_settlements` (two settlements missed while a subscriber was away are in the reconnect snapshot and after a restart); a real-Pi tool call and text reply become `tool.started`, `tool.finished` and `assistant.delta`; the Go fake's closure test fails on a manifest event type it never streams or that has no wire fixture frame; `first_prompt` tests red on base for an admitted prompt, a refusal at admission with the worker created, an uncertain create reconciled through `receipts.get` with one prompt to pi, a lost pi reply fenced also after a restart, and a grant without `sessions.prompt`, with Go fake parity and wire fixtures for both receipts; a `first_user_line` test red on base (marker, blank lines, an image-only message, the bound, a later message, snapshot and `worker.updated`) with Go fake parity; reversions for the delta bound, the tail bound, the tool-call memory bound, the cap and the journaled list, and for the first prompt's dispatch record, its fence (live and after a restart), its journal privacy and its grant check, and the `first_user_line` bound | `npm test -- events-set events first-prompt first-user-line && cd clients/go && go test -race ./...` and `harness/lib/reversions.mjs events-set first-prompt first-user-line` |

**P1 live journey (`p1-chat`):** fresh VM, daemon under `systemd-run --user`; create with a real model, prompt,
watch to settlement; disconnect, work continues, reconnect gets a `gap` snapshot; answer a startup and a working
dialog at stage 3; `/new` and fork bump the binding and refuse the old one; a forced `outcome_unknown` fences, a
new prompt refuses `no_effect`, `resolve_unknown(keep)` resumes; a child launched under a parent execution reports
and its parent is not fenced; compact, reload and a 1.5 MiB image prompt; SIGKILL the supervisor at a dispatch
cut and see `unknown` with no replay; stop; 0 units. **Review:** cross-family on the supervisor, plus Claude and
Grok on grants and the child core (security-sensitive per the milestone plan).

## 11. P2: Containment

Done when: cgroup v2 domains, `cleanup_pending`, relaunch, bwrap for parent and children, git-safe owner Git,
startup sweep; Claude and Grok security reviews.

| PR | Deps | Scope (ported from) | Completion criterion | Verification |
| --- | --- | --- | --- | --- |
| **P2-1** cgroup domains | P1 | `containment/` (`containment.ts`): per-epoch domain, recorded before spawn, `cgroup.kill`, `populated 0`, remove, durable `cleanup_pending`; startup refuses without delegation. Also the durable `sessions.rebind` resume target (pi-worker issue #6, label `binding.reserve`), since confirmed cleanup is what made the memory-only reservation exploitable | Ported `containment` cases except the sweep cases green in the kernel tier; a detached grandchild is killed | `harness/ci/kernel.sh -- containment` |
| **P2-2** Startup sweep | P2-1 | Kill unknown domains of this installation only, before accepting requests: a domain is this installation's by its name, `w-<installation>-…`, in a keeper or an operator-shared delegation; unknown means no holding worker or unconfirmed probe record names it. The installation id is random, made when a state is created and recorded in its start records (a moved state keeps it; a new state at the same path is another installation); the daemon holds an installation lock, the Linux abstract Unix socket `\0pi-worker-installation/<installation>` named from the id alone, from before recovery until it shuts down after its state is closed, so a daemon on a copy of a state is refused `installation_in_use` before its sweep (any other bind error refuses `installation_lock_unavailable`). It has no file to unlink or replace, and the holder's death (SIGKILL included) releases it. State format 3: a P2-1 state (`w-<epoch>` names) is refused at open, and a recorded domain the cleanup would not accept fails startup (PR #23 reviews) | The `containment` sweep cases green: another installation's and operator domains untouched; recovery awaits the sweep; sweep failure fails startup | `harness/ci/kernel.sh -- sweep` |
| **P2-3** Relaunch | P2-2 | `workers.relaunch`: confirmed cleanup, session file, no fence, no competing writer; owner-kept recovered prompt dispatches once on the new epoch; superseded-generation stop results | Ported `relaunch`, `slice5-followups`, `review5-fixes`, `issue1-stop`, `stop-superseded` green | `npm test -- relaunch stop` |
| **P2-4** Pinned FS and bwrap profile | P2-3 | `sandbox/` (`pinned-fs.ts`, `sandbox.ts`): descriptor binds, private `/proc` `/tmp` `/run` HOME, env allowlist, `--clearenv`, `--die-with-parent`, protected-path overlap refusals; bwrap for P1-11's typed children (the FD-3 slot survives `--clearenv`); `files.read`; root-pinned history reads | Ported `sandbox`, `containment-crash` and the `security-fix` bwrap cases (profile, kernel B1 bind, `--die-with-parent`) green; bwrap closes every descriptor except the report slot before pi runs | `harness/ci/kernel.sh -- sandbox containment-crash` |
| **P2-5** Git mounts | P2-4 | `git-sandbox.ts`: read-only pointers, private branch namespace, refusals (an ordinary checkout root, a repository inside or around the root, includes and `worktreeConfig` by Git's own config parser) | Ported `gate1-git` and the `security-fix` M1 mount cases and m2 green (the ordinary-root cases now assert its refusal); a child commits in its namespace and cannot write `.git`, `gitdir`, `commondir`, a symbolic HEAD, alternates, config, other refs or reflogs, or another worktree's admin dir | `harness/ci/kernel.sh -- git` |
| **P2-6** Owner Git | P2-5 | `owner-git/` (`git-safe.ts`, `artifact.ts`): snapshot from pinned descriptors, executing config refused, global config ignored, index mtime kept. **Fixes both open slice 7 findings** [nubl .pi/plan/research/a0-slice7-security-git.md:23-47]: (1) the snapshot directory is created under a supervisor-owned 0700 directory in `$XDG_STATE_HOME/pi-worker/git-snapshots/`, never `TMPDIR`, and its real path (read back from the open descriptor) must lie outside the checkout, `git_dir` and `common_dir`; (2) pinned config with any `protocol.<name>.allow` other than `never` is refused, every call also passes `-c protocol.<name>.allow=never` for `ext` and `file`, `credential.helper` joins the executing-key list, and the exported API runs only local inspection commands (`status`, `diff` family, `log`, `show`, `rev-parse`, `cat-file`, `ls-files`, `for-each-ref`, `merge-base`), refusing transport commands | Ported `owner-git`, `gate1-artifact` and the `security-fix` M1 fsmonitor case green, including the `commondir` flip race and racy-index test. Two new regressions from the slice 7 probes: with `TMPDIR` a symlink into the checkout, a planted `diff.<x>.command` never runs and the snapshot is outside the checkout; with `protocol.ext.allow=always` pinned, `ls-remote ext::…` is refused and the marker stays absent. Each has a reversion (restore `tmpdir()` and string containment; drop the protocol refusal) that fails by assertion | `npm test -- owner-git && harness/ci/kernel.sh -- owner-git` and `node harness/lib/reversions.mjs owner-git` |
| **P2-7** Profile staging | P2-5 | Staging after validation; descriptor copy; `node_modules` as read-only binds; budget; D2 always-unknown after creation; D3 failed rows | Ported `gate1-fix` cases except `kernel D1` and the `security-fix` B2 staging case green; the rename-aside test yields `outcome_unknown` and a fence | `harness/ci/kernel.sh -- staging` |
| **P2-8** Parent channel and sandboxed child launch | P2-5, P2-6, P2-7 | Per-generation socket, its own grant, method whitelist, O_NOFOLLOW child root under the parent root, Git dirs inside the parent root; a sandboxed parent launches P1-11's typed children through it | Ported `gate1-parent` (including PROBE A and the literal project-extension fixture), `gate1-fix` `kernel D1`, and the remaining `security-fix` cases (B1, m1, live topology) green; old B1 reversions fail | `harness/ci/kernel.sh -- channel` |
| **P2-9** Security reviews and fixes | P2-8 | Claude and Grok reviews of the P2 head; reversion runner over every guard | Both reviews' blockers fixed with regressions; every listed guard's reversion fails by assertion | `node harness/lib/reversions.mjs --all` |

**P2-4 as built.** The bwrap profile applies to typed children only: a sandboxed root worker (a parent) is refused
`sandboxed_parent_requires_parent_channel` until P2-8 gives it a channel. A sandbox's root is its cwd; its sessions live
in `ROOT/.piw-worker/sessions/<worker_id>` and pi's agent directory is `ROOT/.piw-agent` (an owner-staged `auth.json` or
`models.json` there is bound read-only). Inside, the environment is the typed child's allowlist (model API keys
included) with its own HOME, TMPDIR and PATH. A session moves only between workers of the same confinement
(`session_confinement_mismatch`), and the resume catalog keeps a sandboxed session's root so compaction never unpins its
reads. `files.read` serves sandboxed workers only. The daemon refuses to start without a bwrap that runs
(`bwrap_unavailable`) and names the B2 socket's directory as a control path no sandbox root may overlap.

**P2-5 as built.** `sandbox/git-sandbox.ts` mounts a sandbox root's Git metadata, every source an O_NOFOLLOW descriptor,
for a linked worktree only. Its admin dir (index, its own reflog, locks) and the shared object store are writable. With
a symbolic HEAD, the branch it names must be `refs/heads/<ns>/<leaf>` with nothing else in that namespace or its
reflogs (loose or packed), and only that namespace and its reflogs are writable; the HEAD file is read-only, so it cannot
be retargeted. A detached HEAD stays in the writable admin dir (it must be an object name at launch) and gets no
writable namespace. Read-only: the gitfile, `gitdir`, `commondir`, the common `config`, `packed-refs`, `shallow`,
`info/exclude`, `refs`, `logs` and `objects/info` (alternates), and any `config`, `config.worktree` or `hooks` already
in the admin dir. The rest of the common dir (`hooks`, `worktrees` and other worktrees' admin dirs) is not mounted.

Refused in the create's validation (`no_effect`, 409) and again at spawn: an ordinary checkout root (a `.git`
directory), because that `.git` is both the common and the admin dir and must stay writable for Git's index and HEAD
locks, so a child could plant a top-level `commondir` (the owner's next Git then reads config and hooks the child wrote)
or a `shallow`, and neither can be pre-created harmlessly; a linked worktree whose common dir lies inside the root or
contains it; a gitfile whose admin dir does not name the root back; a config that Git's own parser
(`git config --file - --no-includes --list`, fed the pinned bytes) rejects, or that has an `include.*` or `includeIf.*`
key or `extensions.worktreeConfig` true in any value (Git's bool parsing, so a bare key, CRLF lines and a header sharing
a line count); a flat branch or a namespace holding another branch or reflog; a detached HEAD that is not an object
name; and any Git mount overlapping the state or a control path. The pin the validation read reaches the spawn through
`HostLaunch.gitPin`, so metadata changed in between refuses (`git_metadata_changed_since_launch`) and never mounts
another namespace. The pin is memory-only: no sandboxed worker is relaunched yet. Named limit (in `hello`): the shared
object store is writable, so a sandbox can add or remove objects other checkouts use.

**P2-6 as built.** `owner-git/git-safe.ts` exports `readGitPin(root)`, `gitVersion(owner)` and a typed API on a
`GitCheckout` (`{ owner, root, pin }`): `gitStatus` (porcelain, optional branch line and paths), `gitDiff` (two
revisions, the index against a revision, or the worktree against the index; as a patch, stat, name-only or
name-status; optional paths), `gitLog` (a revision or range, at most a count), `gitShow` (a revision or `rev:path`),
`gitRevParse` (one revision, or its symbolic full name), `gitCatFile` (type, size or contents), `gitLsFiles` (tracked
or untracked, optional paths), `gitForEachRef` (refs under a literal `refs/` prefix) and `gitMergeBase` (two
revisions). `owner-git/artifact.ts` exports `artifactSubject(owner, cwd, commit, base, pin)`. `owner` is
`{ stateDir, env }`: the supervisor's state directory and the environment PATH and the locale are taken from (nothing
else in it reaches Git, `TZ` included). There is no raw argv entry: owner Git builds every argv, places
`--end-of-options` before revisions and `--` before paths, and refuses (`git_argument_refused`, before anything is
opened) a revision or path that starts with `-` or holds a control character, a path that is absolute, has a `..`
segment or starts with `:` (pathspec magic; Git also runs with `GIT_LITERAL_PATHSPECS=1`), a ref prefix that is not a
literal under `refs/`, and a count that is not a whole number from 1 to 1,000,000. Diff-family calls pass
`--no-ext-diff --no-textconv`, and diff-family and status calls `--ignore-submodules=all` on the command line (an
agent-written `.gitmodules` `ignore = none` overrides the `-c` setting, and Git would then run in the nested
repository under its own config). Git runs with `GIT_NO_REPLACE_OBJECTS=1`, so a copied `refs/replace/*` cannot give
a commit another tree. Owner Git runs only in a linked worktree (`readGitPin` refuses an ordinary root, as P2-5 does).
Each call compares the pin through O_NOFOLLOW descriptors
and copies HEAD, config, refs, `packed-refs`, `shallow`, `info` and the index (its mtime kept) from those descriptors
into `<stateDir>/git-snapshots/snap-*`. Both directories must be ours and mode 0700, and the snapshot's real path, read
back from its descriptor, must lie outside the root, the admin dir and the common dir
(`git_snapshot_dir_inside_checkout`); `TMPDIR` is never used. The snapshot's config, listed by Git's own parser, refuses
when a key names a program (now including `credential.helper` and `credential.<url>.helper`, every other program or
shell-command key in `git-config(1)`, `git-send-email(1)` and `git-archive(1)`, `submodule.<name>.update` starting with
`!`, and the help dispatch keys `help.*`, `man.*`, `web.browser` and `browser.*`), sets `protocol.allow` or
`protocol.<name>.allow` to anything but `never`, or asks for a split index (`core.splitIndex` not false); a
`sharedindex.*` file in the admin dir also refuses (`git_split_index_refused`: the snapshot copies only `index`).
Every call passes `-c protocol.allow=never`,
`-c protocol.ext.allow=never` and `-c protocol.file.allow=never`. Named limit: a supervisor killed during a call leaves
its snapshot (a copy of the repository's config and refs) in the private snapshot directory. `git-sandbox.ts` now
exports `inspect` (unchanged) for the snapshot. No supervisor path calls owner Git yet; the harness and Maestro are its
callers (P2 live journey, P3).

**P2-7 as built.** `sandbox/staging.ts` stages a profile for a sandboxed typed child. Until P2-8 that child's parent is
an unsandboxed typed worker; the profile is the parent cwd's `.piw-agent` (what a sandboxed parent's agent directory
will be), and a parent with none stages nothing, so a child keeps an owner-staged `.piw-agent` of its own as in P2-4.
The create's validation (refusals `no_effect`, 409, before any record) opens the profile with no link at any component
(`parent_profile_not_directory`) and refuses a child root that overlaps it (`child_root_overlaps_parent_profile`) or
already holds a `.piw-agent` of any type (`child_profile_exists`). After the dispatch record and the domain's creation,
before the factory, staging makes a fresh `ROOT/.piw-agent` and copies the profile descriptor-relative: every entry is
opened O_NOFOLLOW from its parent's descriptor and copied from that descriptor, a link is recreated verbatim, and a
FIFO, socket or device refuses. Every `node_modules` directory is left an empty mount point; its open source descriptor
reaches the sandbox (`HostLaunch.dependencies`), which binds it read-only (`--ro-bind-fd`) once the mount point opens as
a real directory below the root, and the supervisor closes it when the factory returns. Budget: 10,000 copied entries,
256 MiB, depth 32, 64 dependency binds. A failure before `ROOT/.piw-agent` exists is `ProvenNoEffect`, and stays
`no_effect` only once the child's empty domain is observed removed and recorded (as for a relaunch); after it exists, the
partial copy is removed best effort without following a link and the outcome is always `outcome_unknown`, which fences
the parent (D2: the parent's tree holds the child root, so it can rename the created directory aside). The child row
ends `failed` with the reason, and frees its root (D3). Named limit (in `hello`): the child can read everything the
parent's profile holds, credential stores included, and sees later changes the parent makes in a bound
`node_modules`.

**P2 live journey (`p2-containment`):** sandboxed SDK parent on a real model; it cannot read the grant, journal
or socket; a detached tool survives a pi crash only until domain cleanup; SIGKILL the supervisor, restart sweeps,
cleanup is confirmed and recorded, `relaunch` opens history without prompting; owner verification through
`safeGit`; 0 units and 0 domains left.

## 12. P3 to P6 in outline

- **P3, Children and Maestro.** The worker's child core is already in place (P1-11 unsandboxed, P2-4 and P2-8
  sandboxed). P3 adds orchestration on top of it: Maestro M5 worker provider on the one exec seam, with the
  checked-outcome outbox owned by Maestro (borrow study section 2
  [nubl .pi/plan/research/opencode-borrow-study.md:83]) and the slice 4 review's client gaps closed: response
  validation, SSE reconnect with snapshot diff, before/after-write classification
  [nubl .pi/plan/research/a0-slice4-review.md:85]. Journey `p3-fanout`: pstack fans out to two worktree children
  through the worker; owner verification binds commit and tree. The P3 build plan and its rows (P3-1 to P3-12) are
  nubl `.pi/plan/p3-worker-provider.md`.

**P3-1 as built (client response validation, suite C1).** `npm run generate` also emits the client's inbound
validators (`packages/client-ts/src/generated/validators.js`), from the same graph and Ajv compiler as the worker's:
every JSON response by operation and status, the ndjson and binary response headers, every event and `Error`. They
are standalone code with no runtime package, and the client still imports only Node built-ins and its own files (a
test scans the built client). The client checks every reply before its caller sees it: the media type, strict UTF-8,
JSON and schema of a JSON reply; the media type, typed declared headers and complete final line of a byte read; and
each SSE frame. A 200 that fails is `unknown` after the write and its body is never exposed. A refusal keeps the
worker's `no_effect` only from an `Error` body that passes its schema; any other JSON refusal is `unknown`
(`refusal_not_b2_error`) and keeps nothing. An invalid frame ends the watch with `ResyncRequired('invalid_frame')`
before the callback, so it never enables controls. A failure names the check and the schema path only, never a
value from the reply. Explicitly open objects (`Receipt.result`, `StopResult`, `Worker.resources`) stay open.
- **P4, Install and operations.** `release.yml`, `pi-worker install|upgrade|rollback|doctor|logs`, systemd user
  unit, upgrade policy (an upgrade restarts the supervisor and so kills pi children; drain or refuse while
  executions run), logs without prompt text. Shep's installer offers the worker. Journey `p4-upgrade-rollback` on a
  VM. Propose the B2 method catalog for freeze.
- **P5, Shep worker driver.** Shep builds the bridge's second driver behind the #129 seam and a per-machine flag;
  root reviews. Gate 2 tests: bridge crash cuts, two observers plus a controller, reconnect and push, images, model
  change, compaction, reload. The B2 surface Shep needs is in [b2-for-shep.md](b2-for-shep.md).
- **P6, Dogfood, then default.** One week of the founder's daily chats on ms-a2 through the worker with the attention
  metric; then default for Linux hosts; catalog frozen as protocol major 1.

## 13. Security review points

Each point gets a named reviewer pass (Claude and Grok, cross-family to the author) and a reversion per guard.

1. **B2 socket and auth (P0-4, P1-9, P1-11 child grants):** 0700 directory and 0600 socket owned by the user, no
   TCP listener, bearer compare in constant time, bearer hashed at rest, grant files 0600, revocation at dispatch and at tool release.
   Named limit: same-user code reads grant files and reaches the socket (invariant 8).
2. **Validation boundary (P0-4, P1-8, P1-16):** oversized and malformed bodies refused before the journal, per body
   mode; binary uploads bounded while streaming, hash- and magic-checked, staged in a private directory; SSE
   frames validated before send; path parameters validated; no path from a client becomes worker authority.
3. **Answer privacy (P1-10):** no answer text or answer-derived hash in journal, receipts or events.
4. **Crash honesty (P1-2, P1-13):** `no_effect` only with proof; a dispatched command is never replayed.
5. **Containment (P2-1, P2-2):** sweep scope limited to this installation; domain identity recorded before spawn;
   daemon handoffs (tmux, `systemd-run --user`, Docker) escape and stay a named limit [a0 A0-SLICE5.md:171].
   Operator duty, not swept: a domain no journal of this installation records is invisible to every other
   installation. Before discarding or cold-resetting a state directory, stop its daemon and remove its domains (stop
   its keeper unit `piw-domains-<installation>.service`, or in an operator root kill and remove its
   `w-<installation>-…` cgroups; the id is in the journal's start records and the daemon's `listening` line). Before
   the first start of P2-2 on a host that ran P2-1, do the same for P2-1's domains (`w-<epoch>`, `w-inventory-<id>`,
   under P2-1's path-named keeper units): its state is refused at open (format 2), and the sweep does not look for old
   names in a shared root.
   Named limit, same-user (PR #23 Grok delta, not a merge blocker): recovery treats a recorded domain whose boot is
   not the current boot id as gone with that boot's cgroupfs, without looking at the directory. A real reboot leaves
   no such directory; a journal edited to record another boot for a live domain would leave that domain running
   while the daemon listens. Writing the journal is a same-user write of supervisor state (point 7, invariant 8).
   Named limit (PR #23): the installation lock is an abstract socket name, so it is per network namespace. Daemons of
   one installation in different network namespaces on one host (a unit with `PrivateNetwork=`, a container) are not
   mutually excluded: a same-user, deliberate configuration. Any process in the namespace can bind a name first; that
   refuses the daemon's start (`installation_in_use`) and never lets it sweep.
6. **Sandbox (P2-4, P2-5, P2-7, P2-8):** every writable mount source opened O_NOFOLLOW and bound by descriptor;
   no grant, socket, state or host home inside; credentials staged read-only and stated as readable; network
   shared (named limit).
7. **Owner Git (P2-6):** no agent-writable path read by Git for anything that selects code; global and system
   config ignored; the snapshot lives in supervisor state, never under `TMPDIR`; protocol-specific `allow` keys
   refused; the API is typed (no raw argv, no transport). Named limit: same-user code outside the sandbox can still
   write supervisor state (invariant 8).
8. **Parent channel (P2-8):** own grant, never the owner's; source grant rechecked per request; no answers, fence
   resolution or relaunch through the channel.
9. **Release supply chain (P4):** actions pinned by SHA, Node signature checked, `SHA256SUMS`, no credential on
   test VMs.

## 14. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| pi SDK internals (resolvers, `navigateTree`, lifecycle events) change across pi releases | Stage 3 or binding detection silently weakens | Pin pi; real-Pi no-model tests in CI; pi upgrades are worker releases |
| Extensions written for the user's interactive pi differ from what the worker's pinned pi loads | Missing tools or loader errors on a host | Readiness requires zero loader errors and reports loaded resources in `hello`; `doctor` compares versions |
| GitHub-hosted runner cannot run the kernel tier | Security tests only run locally | P0-8 decides early; exe.dev runner fallback |
| Response validation after dispatch mislabelled | A retryable error after an effect | Mutations answer `unknown` with `command_id`; closure test pins it |
| Journal growth on a daily host | Refusals once full | P1-12 retention and compaction before the P1 journey |
| Synchronous fsync on the event loop with many workers | Latency for SSE and reads | Measure in `p1-chat` and `p3-fanout`; batching is a later, reviewed change |
| A session open in a herdr TUI pi is resumed by the worker | Two writers on one JSONL; invariant 1 only covers worker-held sessions | Shep's duplicate-open reservations stay; question S-9 in the Shep doc (dropped by Shep ADR-0030) |
| Scope creep from contract 8.1 delays P1 | P5 starts late | 8.1 items are P1-14 to P1-16 only; the rest waits for P5 needs |
| The child core in P1 (D5) lengthens P1 | P5 starts later | It is A0 slice 4 ported with its tests, without sandboxing; P1-11 can start as soon as P1-10 lands, and P1-14 to P1-16 do not depend on P1-12 or P1-13, so those can be built in parallel |
| Generator bump silently raises the Go client's floor | Shep's Go 1.24 build breaks | Exact pins; generated models compiled and tested on Go 1.24.13 with `GOTOOLCHAIN=local` (section 4.4) |
| A binary or streaming route bypasses validation | Unchecked bytes reach the journal or pi | Body and response modes are declared per operation and enforced by the router; closure test requires a mode on every operation (section 4.2) |
| An owner-Git finding reappears in a new command | Owner code runs from agent-writable config | P2-6 exports typed functions only (no raw argv); adding a function or an option needs the rule 6 security review |
| Go client stdlib-only rule fights oapi-codegen output (unions, formats) | Generated code imports a runtime | `exclude-schemas`, no `uuid`/`date` formats in the spec, CI gate |
| Two durable owners for child results (worker reports, Maestro outbox) drift | Lost or duplicate parent delivery | P3 keeps raw reports in the worker and checked outcomes in Maestro only |

## 15. Open questions

**For the founder:**

- **D1. License.** MIT, as A0 intended and Shep uses (R21)? The Go client is vendored into Shep's MIT tree, so
  it needs a compatible license at minimum.
- **D2. Release channel and credential.** Publish worker releases to `nublai/app` next to Shep's (R29), with its
  own GitHub App installation or an environment in `nublai/pi-worker`; or have Shep's release job bundle a pinned
  worker tarball. Recommendation: assets on `nublai/app` from a `release` environment in `nublai/pi-worker`, same
  stable-tag policy (stable only on the founder's go).
- **D3. Drop the process-group fallback.** Recommendation: yes. Linux only, every host has systemd; a host
  without delegation gets a clear `doctor` refusal.
- **D4. Kernel CI runner.** If the hosted runner fails P0-8, approve a persistent exe.dev VM as an ephemeral
  self-hosted runner for `nublai/pi-worker` (runner registration token, `tester` tag).

- **D5. Child core moves from P3 to P1 (review F1).** The milestone plan puts "typed children with the FD report"
  in P3 but asks for "conformance green" in P1, and frozen rows 04 to 06 launch a child. Recommendation: accept
  the move (P1-11 unsandboxed, P2-4 and P2-8 sandboxed); P3 keeps Maestro M5, the exec seam, the outbox and the
  fan-out journey. The alternative, leaving rows 04 to 06 as `todo` until P3, contradicts P1's "conformance
  green" and lets P2's security tests run without the typed children most of them create. Root owns this plan and
  can accept it; it is listed because it edits the milestone table's P1 and P3 rows.

**For Shep:** the proposal and its questions are in [b2-for-shep.md](b2-for-shep.md).

## Decisions taken by root (2026-11-16, founder delegated ownership)

- **2026-11-16, P1-8 scope (rescheduled by root after the PR #7 correctness review, finding F4):** P1-8 delivered the
  event stream, the history marker, and worker-bound `history.page` and `items.read`. It did not deliver `blobs.read`
  or worker-free archived `history.page`. `blobs.read` moves to **P1-16** (it serves the image blobs P1-16 stages
  and needs its binary response mode and blob cap); archived `history.page` by `session_id` with no worker moves to
  **P1-14** (with `sessions.list/get`, which find the archived sessions it reads). The P1 table rows for P1-8, P1-14
  and P1-16 say so; [b2-for-shep.md](b2-for-shep.md) names the same PRs.

- **D1 license: MIT**, as already intended for pi-worker (nubl decision R21); compatible with vendoring the Go client into Shep.
- **D3: no process-group fallback.** Hosts are Linux-only with systemd (founder, 2026-11-16); a host without cgroup v2 delegation is refused with a clear error.
- **D2 (release channel) and D4 (kernel CI runner) are deferred:** D2 is decided at P4 with the founder; D4 is settled by P0-8's evidence, and a persistent self-hosted runner needs the founder's go because it adds a machine and a runner credential.
