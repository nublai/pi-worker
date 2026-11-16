# pi-worker production plan: P0 to P6

Status: **draft for root review**, 2026-11-16. Branch `plan/production`, based on `main` at `5504d66`.
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
  owner-Git tests are the conformance suite. P0 runs the fixture rows as `todo`; P1 must turn all eleven green.
- **P0 is 9 PRs, P1 is 15, P2 is 9.** Every milestone ends with a live journey on a throwaway exe.dev VM and a
  cross-family review; P2 (containment) gets Claude plus Grok security reviews.
- **Packaging:** a release tarball with the daemon, its production `node_modules` and a pinned, checksum-verified
  official Node 26 binary, run as a systemd user service with `Delegate=yes`. No system Node, no SEA bundle.
- **Decisions needed** (section 15): license, release channel and credential, process-group fallback dropped,
  kernel CI runner.

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
| `receipts.ts` | **Port with tests** | P1 | The command flow (reserve, intent, dispatch marker, result, reply) and recovery buckets are the contract's core. The `ProvenNoEffect` rule (a default refusal after dispatch is not `no_effect`) came out of Gate 1's D2 [a0 src/receipts.ts:99-100]. Raise the 512-receipt cap with retention (P1-10); review 1 showed a full store blocking `workers.stop` [nubl .pi/plan/research/a0-slice1-review.md:20]. |
| `journal.ts`, `fsync.ts` | **Rewrite journal; port fsync injection** | P1 | Keep the append, fsync and parse semantics. Add retention and compaction with their own crash cuts: A0 caps at 32 MiB with no eviction [a0 src/journal.ts:31] [a0 README.md:68], which a daily host outgrows. |
| `interactions.ts`, `resolvers.ts` | **Port with tests** | P1 | Answer stages 1 to 4, exact resolver compare-and-delete, privacy (no answer text or hash in control records). Proven by slice 3 and its fix round. |
| `host.ts` | **Rewrite** (SDK only) | P1 | Keep LF framing, correlation, bounded stderr and reject-on-exit (from exmach). Drop the RPC and ACP branches from the default build. The FD-3 report pipe moves to P3. |
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
| `git-safe.ts`, `artifact.ts` | **Port with tests** | P2 | Owner Git on a private snapshot of pinned metadata, executing config refused, global config ignored [a0 src/git-safe.ts:69] [a0 src/git-safe.ts:147-159]; commit and tree subject. |
| Parent channel (in `server.ts`) | **Port with tests** | P2 | Per-generation socket, its own grant, restricted method set, O_NOFOLLOW child root. Slice 7's B1 escape is the reason every rule here exists. |
| FD-3 child report, typed launch spec | **Port with tests** | P3 | Children and Maestro milestone. |
| `api.generated.ts`, `types.ts`, `openapi.json` | **Regenerate** from the new source | P0 | The A0 spec seeds `api/b2.openapi.yaml` (21 operations, 32 schemas); operationIds become the contract's method names. |
| `evidence/*` harness scripts | **Port the patterns** into `harness/lib` | P0 | Evidence record bound to commit and tree, privacy scan, reversion runner, VM setup from a git bundle. Not the job-specific scripts. |

### 3.2 Tests

| A0 tests | Tier in production | Phase |
| --- | --- | --- |
| `conformance` (fixture replay), `invariants` | conformance (frozen) | P0 runner, P1 green |
| `crash-matrix`, `receipts`, `interaction-crash`, `gate1-pi-cuts` | crash | P1 |
| `binding-answer-race`, `gate1-native-binding`, `gate1-sibling`, `interactions`, `transport`, `grants` | conformance | P1 |
| `containment`, `containment-crash`, `relaunch`, `sandbox`, `gate1-parent`, `gate1-git`, `owner-git`, `security-fix`, `gate1-fix`, `gate1-artifact` | security (several are kernel tests) | P2 |
| `children`, `children-crash` | conformance | P3 |
| `supervisor`, `host`, `slice2-fix`, `fix-round`, `review5-fixes`, `slice5-followups`, `issue1-stop`, `stop-superseded` | regression | with their module |
| `acp-profile` | dropped (ACP dropped) | — |
| `merged-host-children` | replaced by the Maestro M5 journey | P3 |

A test that reaches into A0 internals is rewritten to drive B2 and the host seam, with the same assertions. The
fixture seams stay: a deterministic fake host, `PIW_CRASH_AT` SIGKILL after a real fsync, and independent native
artifacts as the effect oracle.

## 4. B2 single source: the OpenAPI pipeline

### 4.1 Pipeline

`api/b2.openapi.yaml` (OpenAPI 3.1) → `npm run generate`:

1. **Redocly CLI** lints with custom rules (every operation has an `operationId` equal to a contract method name;
   every 4xx and 5xx response uses `Error`; every mutation requires `command_id` and declares `x-piw-mutation`;
   every event schema declares `x-piw-event` with producer, durability and visibility) and bundles to
   `api/generated/b2.json`. One tool does both jobs.
2. **openapi-typescript** (7.x, as A0) emits the TS types for the worker and for `client-ts`.
3. **Ajv** (`Ajv2020`, JSON Schema 2020-12, which is OpenAPI 3.1's dialect, with `ajv-formats`) compiles **standalone
   validators** for every request body and every response per status. They are generated code, so startup does no
   schema compilation and a review sees the diff.
4. **`tools/codegen`** (in-repo, about 200 lines) emits three tables from the bundled spec: the TS route table
   (`operationId`, method, path, parameters, request validator, response validators, mutation flag, grant method);
   the TS event publishers; and the Go operation table.
5. **oapi-codegen v2.8.2**, models only, emits `clients/go/b2/models.gen.go`. It supports OpenAPI 3.1
   [oapi README.md:2324-2326] and a models-only mode for hand-rolled clients [oapi README.md:867-869].
   `exclude-schemas` [oapi pkg/codegen/configuration.go:461] leaves the event union to a hand-written decoder.

`npm run check:generated` reruns everything and fails on any diff. It covers the bundle, TS types, validators,
tables, Go models and the Go table.

### 4.2 Server-side validation and contract closure

- The router is built from the generated route table. Its handler map is typed as
  `{ [K in OperationId]: Handler<K> }`, so a missing handler is a compile error. An operation the server does not
  implement yet is marked `x-piw-status: unsupported` in the spec and answers `501`, `effect: no_effect`.
- **Requests:** content type, a 256 KiB cap (as A0), then the generated validator. A failure is `400`,
  `request_schema_mismatch`, `effect: no_effect`, before any journal write.
- **Responses:** every response is validated before it is written, in production too. A read that fails is `500`,
  `response_schema_mismatch`, `no_effect`. A mutation that fails after its dispatch record is `500` with
  `effect: unknown` and the `command_id`, so the caller reads the receipt. A validation failure never becomes a
  retryable error (the borrow study's risk note [nubl .pi/plan/research/opencode-borrow-study.md:52-54]).
- **Embedded mode:** the same request handler runs over an injected in-memory transport for tests and
  single-process use; there is no second supervisor implementation.
- **Closure tests:** every spec operation is routed, every route is in the spec, every operation has at least one
  wire fixture, and every wire fixture validates.

### 4.3 Clients

| | TypeScript (`client-ts`) | Go (`clients/go`) |
| --- | --- | --- |
| Generated | Types (openapi-typescript), route table | Models (oapi-codegen), operation table |
| Hand-written | `node:http` over the socket, `agent: false`, one attempt; SSE reader; `ClientFailure` classification (ported from A0) | `http.Transport` with a Unix dialer and `DisableKeepAlives`; `httptrace.ClientTrace.WroteRequest` decides before-write `no_effect` vs after-write `unknown`; SSE loop; event decoder; peer UID check (`SO_PEERCRED`) before the bearer is sent |
| Retries | None. Reconnect is the caller's decision and always starts with a snapshot. | Same |
| Runtime floor | Node 22.19 (pi's floor), tested on 22 and 26 | Go 1.24 (Shep's `go.mod` [shep bridge/go.mod:3]) |
| Dependencies | none at runtime | **standard library only**, enforced in CI with `go list -deps` |
| Drift check | `check:generated` | `check:generated` plus a Go 1.24 build |

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

## 5. The conformance suite

- **Contract rows.** `api/fixtures/transitions.json` is A0's fixture at revision 8 (eleven rows, `01-binding` to
  `11-control`) [a0 src/test/fixtures/transitions.json:4]. Its semantic fields (row id, from, event, to,
  assertions) are hashed; a test pins the hash. `call` bodies are wire data and may migrate when the catalog
  changes, in a PR that changes no assertion. The replay runner is a port of A0's conformance test
  [a0 src/test/conformance.test.ts:1].
- **Invariant and crash tiers.** Invariants 1 to 8 (A0's `invariants` tests) and fsync cut matrices. Every durable
  point is a labelled call (`durable('prompt.dispatch')`); a test fails if a label has no cut scenario. A0 ran 364
  selected fsync cuts plus native-effect cuts [a0 A0-SLICE7.md:99]; production keeps the oracles (independent
  native artifacts, never receipts alone).
- **Security tier.** Containment, sandbox, owner Git and parent-channel tests, with kernel tests under a delegated
  user service. Each guard has a recorded reversion that fails by assertion.
- **Go side.** `workerfake` replays the same `transitions.json` through the Go client (P1-12), so the fake Shep
  tests against cannot drift from the worker's behaviour.
- **Rule:** an assertion in the conformance or security tier is never weakened. A frozen row changes only with a
  contract revision.

## 6. CI

| Workflow | Runs on | Steps |
| --- | --- | --- |
| `ci.yml` (every push and PR) | GitHub-hosted `ubuntu-24.04`, Node 26 | `npm ci --ignore-scripts`; `npm run check` (lint spec, typecheck, build, unit, regression, conformance, crash, portable security); `npm run check:generated`; `client-ts` tests on Node 22; `clients/go`: `go vet`, `go test -race`, stdlib-only gate, Go 1.24 build; cross-language test (Go client against the built worker) |
| `kernel.yml` (every PR touching `containment/`, `sandbox/`, `owner-git/`, `b2/` channel code, and nightly) | Primary: GitHub-hosted `ubuntu-24.04`. Fallback: an ephemeral self-hosted runner on an exe.dev tester VM | Enable linger, install bubblewrap, allow unprivileged user namespaces for the job, then run the suite inside `systemd-run --user --pipe --wait -p Delegate=yes` with `PIW_TEST_KERNEL=1`; require 0 skips; stop every `piw-*` unit; fail on leftovers |
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
| **P0-3** TS generation | openapi-typescript types, Ajv standalone validators, route and event tables, `check:generated` | Generated files committed; a spec edit without regeneration fails CI (shown on a throwaway branch, logged in the PR) | `npm run generate && npm run check:generated` |
| **P0-4** Server skeleton with closure | Router from the route table, Unix socket (0700/0600, no TCP), request and response validation, in-memory transport, every operation `501 no_effect` | Closure tests pass; removing response validation or one route fails a test (reversion logged) | `npm test -w @nublai/pi-worker -- --test-name-pattern=closure` |
| **P0-5** TS client | `client-ts` with A0's transport and `ClientFailure`, SSE reader, ported `transport` tests | Classification tests pass on Node 22 and 26 | `npm test -w @nublai/pi-worker-client` (CI matrix) |
| **P0-6** Go client | `clients/go` models (oapi-codegen v2.8.2 via `tools/go`), op table, transport, SSE, classification tests, stdlib-only gate, Go 1.24 build | `go test -race ./...` passes; the Go client gets `hello` and a `501` from the P0-4 server in CI | `cd clients/go && go vet ./... && go test -race ./... && go test -tags integration ./...` |
| **P0-7** Conformance runner | `api/fixtures/transitions.json` (rev 8), semantic-hash test, replay runner, every call body validated against the spec; rows run as `todo` | Runner lists 11 rows as `todo`, hash test passes, all bodies validate | `npm run test:conformance` |
| **P0-8** Kernel CI tier | `kernel.yml`, `harness/ci/kernel.sh`: delegated user unit, cgroup v2 create/kill/remove smoke test, bwrap `--unshare-user` smoke test | Smoke tests pass with 0 skips on the chosen runner, log names cgroup path and bwrap version, 0 units left. If the hosted runner cannot, the exe.dev runner path lands instead (decision D4) | `harness/ci/kernel.sh` in the `kernel` workflow |
| **P0-9** Harness skeleton and P0 journey | `harness/vm/*`, evidence record, privacy scan, `p0-hello` journey | Journey passes on a fresh VM; evidence committed; VM deleted | `harness/run.sh p0-hello` |

P0 review: one cross-family review of the pipeline and closure (P0-2 to P0-7) before P1 builds on it.

## 10. P1: Core supervisor

Done when: SDK host; receipts and fsynced journal; binding and fence; interactions; events over SSE with snapshot;
history; grants; crash cuts at every durable point; conformance green.

| PR | Scope (ported from) | Completion criterion | Verification |
| --- | --- | --- | --- |
| **P1-1** Journal and fsync points | Journal rewrite, `durable(label)`, `PIW_CRASH_AT` / `PIW_TRACE_FSYNC` (`journal.ts`, `fsync.ts`) | Append, torn-tail and parse tests pass; a SIGKILL after each labelled fsync recovers a parseable journal | `npm run test:crash -- journal` |
| **P1-2** Receipts | `receipts/` (`receipts.ts`, `receipts` tests): reserve, intent, dispatch, result; `ProvenNoEffect`; recovery buckets | Ported tests pass; reversions of "default refusal after dispatch is `no_effect`" and "dispatch marker after write" fail | `npm test -- receipts` and `harness/lib/reversions.mjs receipts` |
| **P1-3** SDK host and child | `host/`, `sdk-child/` (no ACP), resolvers, readiness (resources loaded, no loader errors), native binding observer | Real-Pi tests with no model call pass: start, ready, inventory, `/new`, tree, fork observed; fake-host tests pass | `npm test -- host` (real pi 1.5.2, no credentials) |
| **P1-4** Worker lifecycle | `workers.create/list/get/stop`, one live writer per session, exclusive cwd, holder named in refusals; restart kills pi and records `cleanup_pending`. Until P2's cgroup domains can confirm cleanup it stays pending, so a restarted worker is not resumable in P1 (invariant 2) | Rows `09` and `10` green; duplicate-open refusal names the holder | `npm run test:conformance -- 09 10` |
| **P1-5** Input and executions | `sessions.prompt/steer/follow_up`, `if_busy`, supervisor-owned follow-up queue (cap 32), admission vs start vs `agent_settled`, `executions.cancel/interrupt` with requested/observed/unknown | Row `11` green; control effect cuts (cancel, interrupt, stop) find effect-bearing receipts | `npm run test:conformance -- 11 && npm run test:crash -- control` |
| **P1-6** Binding and fence | `sessions.rebind` (new, fork, resume, navigate), `sessions.new`, native move handling (pre-move signal, 15 s reconcile), fence latch with generation, `sessions.resolve_unknown`, queue pause | Rows `01` to `08` green; `binding-answer-race` and `gate1-native-binding` ported and green | `npm run test:conformance` |
| **P1-7** Interactions | `interactions/` (`interactions.ts`): four kinds, offered option ids, absolute deadline, stages 1 to 3, restart → `interrupted`, sibling settlement | Ported `interactions`, `gate1-sibling`, `interaction-crash` green; the six slice 3 killing mutations fail | `npm test -- interactions && npm run test:crash -- interactions` |
| **P1-8** Events and history | Event manifest, SSE endpoint, attach barrier, snapshot with history marker and lag, overflow; `history.page`, `items.read`, `blobs.read` (`events.ts`, `session.ts`) | Overflow closes and forces resync; snapshot restores live cards; history never creates a live interaction; every event validates against its schema | `npm test -- events history` |
| **P1-9** Grants | `grants/` rewrite: registration via CLI only, bearer hash at rest, method and scope check, revocation rechecked at dispatch and release | Ported `grants` tests green; a grant revoked between answer and release blocks release | `npm test -- grants` |
| **P1-10** Retention | Receipt and journal retention, compaction with crash cuts, limits in `hello`; stop, cancel, interrupt and resolve never blocked by count quota | 10,000 receipts on a test journal stay within the advertised bound; a compaction cut recovers; unresolved `outcome_unknown` receipts are never evicted | `npm run test:crash -- compaction` |
| **P1-11** Crash-cut coverage | Port `crash-matrix`, `gate1-pi-cuts`; label coverage test | Every `durable()` label has a cut; pi-leader SIGKILL cuts pass; no blind replay | `npm run test:crash` |
| **P1-12** Go fake and Go replay | `clients/go/workerfake`; Go replay of `transitions.json`; SSE reconnect tests | Fake passes the eleven rows through the Go client under `-race` | `cd clients/go && go test -race ./workerfake/...` |
| **P1-13** Phone inventory and features | From contract 8.1: `workers.list` fields (settle counter, `status_since`, cwd, repo label, `lineage`), `sessions.list/get` (archived, 100 per folder), `models.list`, `commands.list` per cwd, `session.configure` (model, thinking, name), `command_id` stamped into a pi custom entry | Wire fixtures for each; `observed` resolution matches a stamped `command_id` | `npm test -- inventory features` |
| **P1-14** Attachments and images | `attachments.stage/status/release` (bounded MIME, count, bytes), image blocks into `sessions.prompt`, exact accepted image count | Real-Pi image prompt test (no model) shows the image block in the session file; uncertain delivery allows status lookup, never re-upload | `npm test -- attachments` |
| **P1-15** CLI | `packages/cli` over `client-ts` | Every A0 CLI command works against the P1 daemon in the journey | `harness/run.sh p1-chat` |

**P1 live journey (`p1-chat`):** fresh VM, daemon under `systemd-run --user`; create with a real model, prompt,
watch to settlement; disconnect, work continues, reconnect gets a `gap` snapshot; answer a startup and a working
dialog at stage 3; `/new` and fork bump the binding and refuse the old one; a forced `outcome_unknown` fences, a
new prompt refuses `no_effect`, `resolve_unknown(keep)` resumes; SIGKILL the supervisor at a dispatch cut and see
`unknown` with no replay; stop; 0 units. **Review:** cross-family on the supervisor, plus Claude and Grok on
grants (security-sensitive per the milestone plan).

## 11. P2: Containment

Done when: cgroup v2 domains, `cleanup_pending`, relaunch, bwrap for parent and children, git-safe owner Git,
startup sweep; Claude and Grok security reviews.

| PR | Scope (ported from) | Completion criterion | Verification |
| --- | --- | --- | --- |
| **P2-1** cgroup domains | `containment/` (`containment.ts`): per-epoch domain, recorded before spawn, `cgroup.kill`, `populated 0`, remove, durable `cleanup_pending`; startup refuses without delegation | Ported `containment` and `containment-crash` green in the kernel tier; a detached grandchild is killed | `harness/ci/kernel.sh -- containment` |
| **P2-2** Startup sweep | Kill unknown domains of this installation only, before accepting requests | Another installation's and operator domains untouched; sweep failure fails startup (ported slice 5 tests) | `harness/ci/kernel.sh -- sweep` |
| **P2-3** Relaunch | `workers.relaunch`: confirmed cleanup, session file, no fence, no competing writer; owner-kept recovered prompt dispatches once on the new epoch | Ported `relaunch`, `slice5-followups`, `review5-fixes` green | `npm test -- relaunch` |
| **P2-4** Pinned FS and bwrap profile | `sandbox/` (`pinned-fs.ts`, `sandbox.ts`): descriptor binds, private `/proc` `/tmp` `/run` HOME, env allowlist, `--clearenv`, `--die-with-parent`, protected-path overlap refusals; `files.read`; root-pinned history reads | Ported `sandbox` and the matching `security-fix` cases green; bwrap closes every descriptor before pi runs | `harness/ci/kernel.sh -- sandbox` |
| **P2-5** Git mounts | `git-sandbox.ts`: read-only pointers, private branch namespace, ordinary-checkout overlays, refusals (`commondir`, includes, `worktreeConfig`) | Ported `gate1-git` green; a child commits in its namespace and cannot write `.git`, `gitdir`, `commondir`, HEAD, alternates or config | `harness/ci/kernel.sh -- git` |
| **P2-6** Owner Git | `owner-git/` (`git-safe.ts`, `artifact.ts`): snapshot from pinned descriptors, executing config refused, global config ignored, index mtime kept | Ported `owner-git` green including the `commondir` flip race and racy-index test | `npm test -- owner-git && harness/ci/kernel.sh -- owner-git` |
| **P2-7** Profile staging | Staging after validation; descriptor copy; `node_modules` as read-only binds; budget; D2 always-unknown after creation; D3 failed rows | Ported `gate1-fix` green; the rename-aside test yields `outcome_unknown` and a fence | `harness/ci/kernel.sh -- staging` |
| **P2-8** Parent channel and sandboxed child launch | Per-generation socket, its own grant, method whitelist, O_NOFOLLOW child root under the parent root, Git dirs inside the parent root | Ported `gate1-parent` (including PROBE A and the literal project-extension fixture) green; old B1 reversions fail | `harness/ci/kernel.sh -- channel` |
| **P2-9** Security reviews and fixes | Claude and Grok reviews of the P2 head; reversion runner over every guard | Both reviews' blockers fixed with regressions; every listed guard's reversion fails by assertion | `node harness/lib/reversions.mjs --all` |

**P2 live journey (`p2-containment`):** sandboxed SDK parent on a real model; it cannot read the grant, journal
or socket; a detached tool survives a pi crash only until domain cleanup; SIGKILL the supervisor, restart sweeps,
cleanup is confirmed and recorded, `relaunch` opens history without prompting; owner verification through
`safeGit`; 0 units and 0 domains left.

## 12. P3 to P6 in outline

- **P3, Children and Maestro.** Typed launch spec (subset of the parent's grant and environment), FD-3 report,
  durable report receipts, `lineage` and child rows, missing-report fence. Maestro M5 worker provider on the one exec
  seam, with the checked-outcome outbox owned by Maestro (borrow study section 2
  [nubl .pi/plan/research/opencode-borrow-study.md:83]) and the slice 4 review's client gaps closed: response
  validation, SSE reconnect with snapshot diff, before/after-write classification
  [nubl .pi/plan/research/a0-slice4-review.md:85]. Journey `p3-fanout`: pstack fans out to two worktree children
  through the worker; owner verification binds commit and tree.
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

1. **B2 socket and auth (P0-4, P1-9):** 0700 directory and 0600 socket owned by the user, no TCP listener, bearer
   compare in constant time, bearer hashed at rest, grant files 0600, revocation at dispatch and at tool release.
   Named limit: same-user code reads grant files and reaches the socket (invariant 8).
2. **Validation boundary (P0-4):** oversized and malformed bodies refused before the journal; path parameters
   validated; no path from a client becomes worker authority.
3. **Answer privacy (P1-7):** no answer text or answer-derived hash in journal, receipts or events.
4. **Crash honesty (P1-2, P1-11):** `no_effect` only with proof; a dispatched command is never replayed.
5. **Containment (P2-1, P2-2):** sweep scope limited to this installation; domain identity recorded before spawn;
   daemon handoffs (tmux, `systemd-run --user`, Docker) escape and stay a named limit [a0 A0-SLICE5.md:171].
6. **Sandbox (P2-4, P2-5, P2-7, P2-8):** every writable mount source opened O_NOFOLLOW and bound by descriptor;
   no grant, socket, state or host home inside; credentials staged read-only and stated as readable; network
   shared (named limit).
7. **Owner Git (P2-6):** no agent-writable path read by Git for anything that selects code; global and system
   config ignored.
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
| Journal growth on a daily host | Refusals once full | P1-10 retention and compaction before the P1 journey |
| Synchronous fsync on the event loop with many workers | Latency for SSE and reads | Measure in `p1-chat` and `p3-fanout`; batching is a later, reviewed change |
| A session open in a herdr TUI pi is resumed by the worker | Two writers on one JSONL; invariant 1 only covers worker-held sessions | Shep's duplicate-open reservations stay; question S-9 in the Shep doc |
| Scope creep from contract 8.1 delays P1 | P5 starts late | 8.1 items are P1-13 and P1-14 only; the rest waits for P5 needs |
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

**For Shep:** the proposal and its questions are in [b2-for-shep.md](b2-for-shep.md).
