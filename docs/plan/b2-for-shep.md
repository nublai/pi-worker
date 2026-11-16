# B2 for Shep's Go driver: a proposal for Shep to review

Status: **proposal, revision 3** (2026-11-16: Shep's answers recorded in section 8 and applied to the API from
P1-14; revision 2 added the PR per method, the authority table and the photo upload limits), from root. Shep owns its bridge driver and decides what it needs; root owns
pi-worker, the B2 contract and the generated clients. Nothing here is frozen. The method catalog stays draft until
P6 (contract sections 4 onward).

Citation keys are as in [production.md](production.md#0-sources-and-citation-keys): `shep` is Shep `origin/main` at
`eb481e1`, `nubl` is `nublai/root` at `6fe8c82`, `a0` is `prototype/a0` at `ee66117`.

## BLUF

- **The worker driver is the bridge's second driver behind the #129 seam**, chosen per machine. R31 made #129 the
  two-driver seam [shep research/DECISIONS.md:25]; this adds pi-worker as a driver for Linux hosts.
- **Every Shep operation that touches pi maps to one B2 method** (table below). Folders, files, Improvements,
  pairing, push, photo staging and the history projection stay in the bridge, as the contract's ownership table
  says [nubl .pi/plan/worker-contract.md:22-42].
- **The bridge gets a generated Go client** (models plus an operation table, stdlib only, Go 1.24) with a
  hand-written transport, SSE loop and error classification, and a Go fake worker for tests.
- **Auth:** the bridge reads a bearer grant from a 0600 file that `pi-worker grant register` writes, checks the
  socket peer's UID before sending it, and passes the device as `actor` on answers. The `bridge` grant profile is
  an exact method list (section 2.1), checked in CI against the spec.
- **Every method below has a worker PR and an authority rule** (section 2.1): grant method, binding, and what
  happens under a fence. Photos use a streamed binary upload with Shep's current limits, not the 256 KiB JSON cap.
- **The phone's chat identity becomes `worker_id`**, not a pane id. That lands with Shep's single wire break
  (R26 amended in R31 [shep research/DECISIONS.md:31-33]).
- **Twelve questions for Shep** are at the end. The ones that block P1's API: S-1 (history transport), S-2 (Go
  client delivery), S-4 (photos) and S-5 (interrupt marker).

## 1. What the bridge does today (herdr driver)

- **Adapter seam.** `Adapter` and its optional interfaces (`Resumer`, `FeatureSource`, `DialogReader`,
  `Classifier`) [shep bridge/adapter.go:33-101] with capability bits from `history` to `session_info`
  [shep bridge/adapter.go:106-120]. pi has all of them [shep bridge/adapter_pi.go:25].
- **Requests.** `shep.*` methods dispatch in one switch [shep bridge/requests.go:61-99]; a herdr allowlist covers
  pane reads, keys and `agent.prompt` [shep bridge/server.go:17-25]. Stop is an Escape key through
  `agent.send_keys` or `pane.send_keys` [shep bridge/server.go:22-23].
- **Send** checks commands, refuses while a dialog shows, adds the interrupt marker, then `agent.prompt` with a
  `pane.send_input` fallback [shep bridge/requests_send.go:18-83] [shep bridge/requests_send.go:140].
- **Dialogs** are read from the screen and answered with keys, after re-reading that the dialog id is unchanged
  [shep bridge/dialogs.go:244-336]. A key whose reply times out is reported as "may have been delivered"
  [shep bridge/dialogs.go:327].
- **History** is the bridge's own parser over the session file, incremental by byte offset
  [shep bridge/history/index.go:122], paged by `shep.history {pane_id, before, limit}`
  [shep bridge/requests.go:149].
- **Subagents** are classified from pi-herdr-agents sidecars next to the log (R11)
  [shep bridge/history/subagent.go:18-37].
- **Photos** are staged by the bridge, then typed into pi as an envelope that a pi hook recognizes
  [shep bridge/photos.go:49-58] [shep bridge/photos.go:606].
- **Close** is `pane.close` after a fresh read [shep bridge/requests_close.go:15].
- **Live list** rows carry pane, workspace, status, `status_since`, `completion_seq`, `needs_you`, title, preview,
  last activity [shep bridge/wire/wire.go:35-56]; activity frames carry the screen tail and dialog
  [shep bridge/wire/wire.go:110-127].

With the worker there is no pane and no screen. Dialogs become typed interactions, Stop becomes
`executions.interrupt`, and history comes from the worker instead of a path the bridge resolves.

## 2. Method catalog draft, mapped to Shep's operations

All mutations carry a phone-generated `command_id` (contract 8.1 [nubl .pi/plan/worker-contract.md:200]).
Session-directed mutations also carry the binding `{worker_epoch, session_id, binding_revision}` the phone last
saw. "A0" means the method exists in A0's spec and has crash evidence; "new" means designed, not yet built.

| Shep operation | Today | B2 method | Route (draft) | Phase | Status |
| --- | --- | --- | --- | --- | --- |
| Connect, features of the machine | `shep.features` | `hello` | `GET /b2/hello` | P0-4 | A0 |
| Chats list (live) | `shep.conversations` | `workers.list` (fields: `status`, `status_since`, `settle_count`, `foreground`, `interactions_pending`, `cwd`, `repo_label`, `lineage`, `parent_worker_id`, `title`, `binding`) | `GET /b2/workers` | P1-4; fields P1-14 | A0 + new fields |
| One chat | — | `workers.get` | `GET /b2/workers/{worker_id}` | P1-4 | A0 |
| Archived sessions, Resume list | `shep.sessions`, `shep.session_info` | `sessions.list` (per cwd, up to 100, title, preview, last activity, stats, per-model cost), `sessions.get` | `GET /b2/sessions`, `GET /b2/sessions/{session_id}` | P1-14 | new |
| New chat | `shep.conversation.create` | `workers.create` (`cwd`, `model`, `thinking`, `name`, optional `first_prompt`, `command_id`); idempotent by `command_id` | `POST /b2/workers` | P1-4 | A0 + new fields |
| Resume a saved session | `shep.conversation.create {resume_session}` | "view archived": `history.page` by `session_id`, no worker; "reattach live": `workers.create {resume_session_id}`, refused with the holder when another worker holds it | as above | P1-4; view archived P1-14 (moved from P1-8, 2026-11-16) | A0 refusal, new split |
| Send | `shep.send` | `sessions.prompt` with `if_busy` (`steer`, `follow_up` or `reject`) and `attachments[]` | `POST /b2/workers/{worker_id}/prompt` | P1-5; `attachments[]` P1-16 | A0 + `if_busy` |
| Stop | Escape via `agent.send_keys` | `executions.interrupt` (cancel dialogs, clear queued input, abort; reports `settled`, `forced_termination` or `unknown`) | `POST /b2/workers/{worker_id}/interrupt` | P1-5 | A0 |
| Close chat | `shep.conversation.close` | `workers.stop` (keeps session and environment; reports observed or unknown; `close_stops_work` capability) | `POST /b2/workers/{worker_id}/stop` | P1-4 | A0 |
| Needs-you cards | screen read, `activity.dialog` | `interactions.list` plus `interactions.changed` events (all four kinds, prefill, options with ids, absolute deadline) | `GET /b2/workers/{worker_id}/interactions` | P1-10 | A0 |
| Answer a dialog | `shep.dialog_answer {pane_id, dialog_id, answer}` | `interactions.answer_if_current {interaction_id, revision, kind, binding, answer_id, command_id, outcome, value or option_id, actor}` | `POST /b2/workers/{worker_id}/interactions/answer` | P1-10 | A0 |
| Answer status | — | `interactions.status`, `receipts.get` | `GET …/interactions/status`, `GET /b2/receipts/{command_id}` | P1-10; `receipts.get` P1-2 | A0 |
| History page | `shep.history` | `sessions.history` (shape (a), S-1; section 4) for the bridge; `history.page` entry pages for orchestrators | `GET /b2/sessions/{session_id}/history` (any catalog session, live or archived) | P1-14; `history.page` for a worker's bound session (`GET /b2/workers/{worker_id}/history`) P1-8 | new |
| Item part, blob | `shep.item`, `shep.blob` | `items.read`, `blobs.read` | `GET …/entries/{entry_id}`, `GET /b2/sessions/{session_id}/entries/{entry_id}/blobs/{index}` | `items.read` P1-8; `blobs.read` P1-16 (moved from P1-8, 2026-11-16) | new |
| Photo message | HTTP upload, then `shep.send {photo_message_id}` | `attachments.stage`: a streamed binary upload of one JPEG (`Content-Type: image/jpeg`; SHA-256, `command_id`, worker and binding in headers), up to 2 MiB, never through the 256 KiB JSON path; then `sessions.prompt {attachments}`, up to 4 per message and 8 MiB in total. Limits are in `hello` and equal today's [shep bridge/photos.go:49-55]. Whether the bridge keeps its own copy first is S-4 | `PUT /b2/attachments/{attachment_id}` | P1-16 | new |
| Photo status | `shep.photo_status` | `attachments.status`, `receipts.get`: after an upload whose response was lost, the bridge reads status by `attachment_id` and never re-uploads | `GET /b2/attachments/{attachment_id}` | P1-16 | new |
| Composer features | `shep.agent_features` | `models.list`, `commands.list` (per cwd before a worker exists, or per worker), `workers.get` for current model, thinking, name, skills | `GET /b2/models`, `GET /b2/commands` | P1-14 | new |
| Model, thinking, name change | key presses on the picker | `session.configure {model, thinking, name}` | `POST /b2/workers/{worker_id}/configure` | P1-14 | new |
| `/new`, fork, tree | typed into the pane | `sessions.new`, `sessions.rebind {action, entry_id, source_leaf_id}` (action `fork` or `navigate`) | `POST …/new`, `POST …/rebind` | P1-7 | A0 |
| Compaction, reload | typed into the pane | `sessions.compact`, `resources.reload` | `POST …/compact`, `POST …/reload` | P1-15 | new |
| Slash commands | typed into the pane (R7, R8) | `commands.invoke` for supported commands; unsupported built-ins refuse explicitly | `POST …/commands/invoke` | P1-15 | new |
| Unknown outcome | "may have been delivered" | `outcome_unknown` fences the session; the phone offers Keep, Abandon, Observed: `sessions.resolve_unknown` | `POST …/resolve_unknown` | P1-6 | A0 |
| Subagent rows | sidecar classification (R11), Delegated rows (R28) | `workers.list` with `lineage` (`root`, `child` or `unknown`) and `parent_worker_id`; children hidden from Chats; a parent's Delegated rows from its children's status | as above | P1-11 (children), P1-14 (list fields); Maestro-driven fan-out P3 | A0 parent fields, new `lineage` |
| Linked files | `shep.file` | stays in the bridge for local cwds; `files.read` only for sandboxed roots | `POST …/files/read` | P2-4 | A0 |
| Terminal | `tab.create`, keys | stays herdr-side in 0.9.x; the bridge maps chat → cwd → shell tab | — | — | contract 8.1 |
| Folders, Improvements, pairing, push tokens | bridge | stay in the bridge | — | — | — |

Error model: HTTP status plus `Error {error, effect: no_effect | unknown, uncertain_command_id?, holder_worker_id?,
expected_binding_revision?, received_binding_revision?}`. A transport failure before the request bytes are written
is `no_effect`; after, it is `unknown` and the bridge reads `receipts.get(command_id)`. The client never retries
a mutation.

**Contract rule "no replay past retention" (P1-12, review F1 of PR #12).** A `command_id` the worker may have
admitted is never executed again, however long ago. The worker keeps each receipt within `hello.limits`
(`ordinary_receipts_max`, `receipt_retention_min_seconds`), then its id (`receipt_expired`, `unknown`, for the newest
`receipt_expired_ids_max` evicted ids), and after that a durable horizon: the newest issue time of a forgotten
UUIDv7 id and whether any id that is not a UUIDv7 was forgotten. A command whose id the worker remembers neither as a
receipt nor as an expired id is refused `409 command_id_beyond_retention`, `no_effect`, before any record, when it
could be a forgotten one: a UUIDv7 whose timestamp is not after the horizon, or any id that is not a UUIDv7 once such
an id was forgotten. The refusal says this request did nothing; it is never proof that an earlier request with the
same id did nothing. **The phone mints every `command_id` as a UUIDv7 (RFC 9562) from its clock when it creates
the command**, and reuses it unchanged for a retry. Other ids work until the first non-UUIDv7 id is forgotten; after
that, every new one is refused. A phone whose command sat unsent longer than the horizon (at least
`receipt_retention_min_seconds` behind the worker's clock) is refused and mints a new id; a phone clock far ahead
of the worker's makes the horizon refuse fresh ids up to that time once such an id is forgotten. Named limit in
`hello`.

### 2.1 Implementation slice and authority per method

PRs are in [production.md](production.md) sections 9 to 11. **Rules for every row:** the grant method is the
`operationId`, carried by the generated route table, and a request whose bearer lacks it is refused `no_effect`
before any journal write. Every mutation carries `command_id`. "Binding" means the request carries
`{worker_epoch, session_id, binding_revision}` and a mismatch is refused `stale_binding`, `no_effect`. "Refused
under a fence" means `no_effect` naming the uncertain command. After its dispatch record, a lost reply is
`outcome_unknown` and fences the session (session-directed methods) or is read back with `receipts.get`.

| Method | PR | Kind | Binding | Under a fence |
| --- | --- | --- | --- | --- |
| `hello` | P0-4 | read | — | allowed |
| `workers.list`, `workers.get` | P1-4 (fields P1-14) | read, grant scope filters workers | — | allowed |
| `sessions.list`, `sessions.get` | P1-14 | read, grant cwd scope | — | allowed |
| `models.list`, `commands.list` | P1-14 | read | — | allowed |
| `events.subscribe` | P1-8 (interaction events P1-10) | read, filtered by grant scope | — | allowed |
| `history.page`, `items.read`, `sessions.history`, `blobs.read` | P1-8 (worker-bound `history.page`, `items.read`); P1-14 (`sessions.history`, any session by `session_id`); P1-16 (`blobs.read`) | read, grant scope (a session: its cwd in cwd scope and its last owner in worker scope) | — | allowed |
| `interactions.list`, `interactions.status` | P1-10 | read | — | allowed |
| `receipts.get` | P1-2 | read; only receipts of workers in scope | — | allowed |
| `attachments.status` | P1-16 | read | — | allowed |
| `files.read` | P2-4 | read, sandboxed roots only | — | allowed |
| `workers.create` | P1-4 | mutation | — (new worker); resume of a held session refused naming the holder | n/a for a new session; with `resume_session_id`, a fenced target is refused (`target_session_fenced`) and an `outcome_unknown` fences the target, held by the new worker, until `sessions.resolve_unknown` |
| `sessions.prompt` | P1-5 (attachments P1-16) | session mutation | yes | refused |
| `session.configure` | P1-14 | session mutation | yes | refused |
| `sessions.new`, `sessions.rebind` | P1-7 | session mutation | yes | refused |
| `sessions.compact`, `resources.reload`, `commands.invoke` | P1-15 | session mutation; also refused while an execution runs | yes | refused |
| `interactions.answer_if_current` | P1-10 | mutation; needs `answers_for_person` and the interaction's current revision; grant rechecked at release | yes | refused |
| `executions.interrupt` | P1-5 | control | yes | allowed (row 11) |
| `workers.stop` | P1-4 | control | yes | allowed |
| `sessions.resolve_unknown` | P1-6 | the fence's own resolution; needs the current `fence_generation` | yes | the only write that clears it |
| `attachments.stage`, `attachments.release` | P1-16 | mutation on bridge-owned staged bytes; no session effect | worker id only | allowed (the prompt that uses them is refused) |

**Not in the `bridge` profile:** `children.launch` and `children.report` (agent-side; parent and child grants
only), `workers.relaunch` (owner CLI until Shep asks for it), `sessions.steer`, `sessions.follow_up` and
`executions.cancel` (the bridge uses `if_busy` and interrupt), and grant management (local files only, never
HTTP). Adding one is a profile change in the spec, reviewed like any other.

**Check.** A closure test (P1-17) fails if a method in this table has no route or wire fixture, if the `bridge`
profile misses a method in this table, or if the profile names a method outside it.

## 3. Events, reconnect and snapshot

One SSE stream per supervisor: `GET /b2/events?worker_id=…&types=…` (both filters optional). Draft event types:

| Event | Carries | Durability |
| --- | --- | --- |
| `snapshot` | every authorized worker row, live interactions with payloads, fences, a history marker per worker (last entry known in the file, `lag`), cursor, `resync_reason` | sent first on every attach |
| `overflow` | cursor | then the stream closes |
| `worker.updated` | the full worker row (status, `status_since`, `settle_count`, foreground, fence, cleanup, binding) | journal or memory, labelled |
| `session.rebound` | new `binding_revision`, `session_id`, `leaf_id`, cause (`new`, `fork`, `resume`, `navigate`, `native`) | journal |
| `execution.admitted`, `execution.started`, `execution.settled` | `execution_id`, `command_id`, disposition | journal for settled |
| `assistant.delta` | text delta (transient; replaces the screen tail) | memory |
| `tool.started`, `tool.finished` | tool call id, name, short summary (the "pending tool") | memory |
| `interactions.changed` | live cards for the worker | memory (outcomes journaled) |
| `fence.set`, `fence.resolved` | `fence_generation`, uncertain command or execution | journal |
| `receipt.updated` | `command_id`, state, effect | journal |
| `history.appended` | `session_id`, new watermark | memory |
| `attachment.updated` | attachment id, state | journal |

Every event has a transport cursor `{transport_epoch, seq}` and a semantic `event_id`, `producer`, `evidence`.

**Reconnect.** The bridge reconnects with `Last-Event-ID`. The worker never replays: it answers with a fresh
`snapshot` whose `resync_reason` is `current`, `gap`, `epoch` (supervisor restarted) or `overflow`. Controls stay
disabled until the snapshot arrives. A subscriber queue holds 64 events or 256 KiB; past that, `overflow` and
close [a0 src/events.ts:12-31].

**Push seeding.** Contract section 5 says: seed silently on **cold start only**; on a resync, diff the snapshot
against the last known state so a missed approval or settlement still notifies; dedupe interactions by
`interaction_id` and settlements by `execution_id` [nubl .pi/plan/worker-contract.md:129]. R31's herdr-core note
says "seed silently on every snapshot" [shep research/DECISIONS.md:47]. For the worker driver, root proposes the
contract rule, because the snapshot carries `interaction_id`s and `settle_count`, which make the diff safe
(question S-7).

## 4. History

The contract gives the projection to the bridge and raw entries to the worker
[nubl .pi/plan/worker-contract.md:36]. Two shapes are possible:

- **(a) Byte-range read, proposed for Shep:** `GET /b2/sessions/{session_id}/history?format=jsonl&offset=N` returns
  the session file's complete lines from byte `N` (`application/x-ndjson`), with headers for the file identity, the
  next offset, the watermark and a reset flag if the file was rewritten. Shep's parser already reads by offset and
  checks the tail [shep bridge/history/index.go:122], so it would need a source interface, not a new parser.
  Validation: the worker validates the headers against a schema and checks that each line is one complete JSON
  value ending on a line boundary; it does not validate pi's entry contents, which B2 does not own
  ([production.md](production.md) section 4.2).
- **(b) Entry page:** `format=json` returns `{entries[], next, watermark, lag, truncated}` with large tool results
  and images replaced by references that `items.read` and `blobs.read` fetch. TypeScript orchestrators use this.

Either way the bridge never receives a host path, and history never creates a live interaction. Sandboxed
sessions live under the sandbox root, so reading the file directly from the bridge would not cover them.

## 5. Auth: how the bridge gets a grant

1. The owner (or Shep's installer, P4) runs
   `pi-worker grant register --caller shep-bridge --profile bridge --out <file>`. The `bridge` profile holds
   exactly the methods in section 2.1's table (including `resources.reload`, `sessions.compact` and
   `commands.invoke`), scope `*` (owner policy), and `answers_for_person: true`. Only this grant may answer
   interactions for a person.
2. The file is 0600 and holds the bearer; the worker keeps only its hash. The bridge config names the file path
   (for example `-worker-grant-file`), never the value. The bridge rereads it on SIGHUP and never logs it.
3. Before sending the bearer, the Go transport reads the socket peer's credentials (`SO_PEERCRED`) and refuses a
   peer whose UID is not the expected worker owner. The worker side cannot check the bridge's UID (Node has no
   peer-credential API), so its boundary is file modes plus the bearer [nubl .pi/plan/worker-contract.md:82].
4. B1 capabilities stay the bridge's decision (who may answer, approve, steer, cancel). The bridge passes the
   device as an opaque `actor` on answers; the worker journals it with the outcome; the bridge owns actor records
   [nubl .pi/plan/worker-contract.md:33].
5. Revocation: `pi-worker grant revoke <id>`. It takes effect on the next request and is rechecked at tool release.
6. Named limit: any process running as the same user can read the grant file and reach the socket (invariant 8).

## 6. What Shep would build (P5, for Shep to plan)

- A `worker` driver behind the #129 seam with a per-machine flag; chat identity `{machine, runtime: worker,
  worker_id}`; archived chats by `session_id`.
- Vendored Go client (`b2`) and the fake (`workerfake`) in bridge tests, race-tested.
- The history source interface for shape (a) or (b).
- The dialog card mapping from `interactions.list` (kinds, option ids, prefill, deadline); `invalid_text`, the
  64 KB cap and "editor answered as shown" stay bridge policy [nubl .pi/plan/worker-contract.md:201].
- The fenced-chat state with Keep, Abandon, Observed.
- Gate 2 tests: bridge crash cuts, two observers plus a controller, reconnect and push, images, model change,
  compaction, reload (milestone plan P5).

## 7. Open questions for Shep

- **S-1. History transport.** Byte-range JSONL (a) or entry pages (b)? Root proposes (a) for the bridge.
- **S-2. Go client delivery.** The Go module lives in the private `nublai/pi-worker`. Options: vendor a stamped copy
  into `bridge/internal/b2` with a checksum check (no new credential); fetch a private module in Shep's CI (needs a
  read token); or a separate public repo. Root proposes vendoring.
- **S-3. Chat identity and the wire break.** Can worker chats wait for the single wire break (`ai.nubl.app`), or
  does Shep want worker chats behind the flag before it?
- **S-4. Photos.** Keep bridge-side staging and forward bytes with `attachments.stage`, or let the phone's upload
  go straight to the worker through the bridge without a bridge copy? Current limits are 4 photos, 2 MiB each,
  8 MiB per message [shep bridge/photos.go:49-54]. The worker endpoint is the same streamed upload either way and
  defaults to these limits; root lowers them only if Shep agrees here.
- **S-5. Interrupt marker (R9).** Today the bridge prefixes the next prompt [shep bridge/history/interrupt.go:28].
  Proposal: the bridge keeps it, sends `interrupt_marker: true` on `sessions.prompt`, and the worker records
  delivered text and display text separately, so one owner holds the marker (contract 8.1).
- **S-6. Bridge as its own user (#174).** A separate bridge user breaks the 0700 socket directory. Group access
  (0750 directory, 0660 socket, a `piw` group) would be needed. Does #174 land before P5?
- **S-7. Push seeding.** Contract rule (cold start only, diff on resync) for the worker driver, instead of R31's
  "seed on every snapshot"?
- **S-8. Activity without a screen.** Is `assistant.delta` plus `tool.started` enough for the working bubble and the
  Chats row, or does the app need another field?
- **S-9. Sessions outside the worker.** A session open in a herdr TUI pi is invisible to the worker's one-writer
  check. Should the worker driver refuse Resume of a session that the herdr driver shows as live on the same
  machine, using the bridge's duplicate-open reservations?
- **S-10. Mixed machines.** On a machine with both drivers, is Chats one merged list keyed by runtime, and which
  driver does New Chat use?
- **S-11. Naming.** Shep calls pairing approval "B2" (#159) [shep research/DECISIONS.md:152]. The contract uses B2
  for the bridge-to-worker boundary. Could Shep call it the "worker API" in its docs to avoid confusion?
- **S-12. R22 approvals on the worker.** exmach approval cards arrive as select interactions titled
  `exmach-approval:`. The contract keeps title reading as the named compatibility path until a typed
  `tool_approval` exists [nubl .pi/plan/worker-contract.md:165]. Is that still how the app wants them?

## 8. Shep's answers (2026-11-16) and what the worker does

Shep answered all twelve questions at `12bdff9` (`research/worker-api/answers-2026-11-16.md`, read at pi-worker
`79e0d6c`); root accepted every answer. In Shep's docs this boundary is now "the worker API" (S-11).

| Q | Shep's answer | What the worker does | PR |
| --- | --- | --- | --- |
| **S-1** history | Shape (a): byte-range JSONL with `max_bytes`, complete lines only, a file identity, the next offset, a watermark matching `history.appended`, a reset flag on replace, shrink or rewrite in place, and a typed error for an offset past the watermark or not on a line start | New operation **`sessions.history`** (`GET /b2/sessions/{session_id}/history?format=jsonl&offset&max_bytes&identity&tail`, its own grant method): the session file's complete lines from `offset`, at most `max_bytes` (up to 16 MiB) unless one line alone is longer (then that line, up to 64 MiB), with headers `Piw-File-Identity`, `Piw-Offset`, `Piw-Next-Offset`, `Piw-Watermark`, `Piw-Reset` and `Piw-Tail-Sha256`. The reader sends back `identity` and `tail`; another identity or a tail that does not match the line before `offset` resets to byte 0. Without a tail, an offset past the watermark is `400 history_offset_past_watermark` and one inside a line `400 history_offset_not_line_start`. The new `history.appended` event carries the same watermark. It reads any session of the worker catalog, so an archived session reads with no worker. (b) stays as `history.page` for TypeScript orchestrators | P1-14 |
| **S-2** Go client | Vendored copy at `bridge/internal/b2` with a stamp file and `scripts/vendor-b2.sh`; `workerfake` the same way | The Go module stays stdlib-only and Go 1.24; `workerfake` and the hand-written byte reads and streamed upload land in P1-17 | P1-17 |
| **S-3** chat identity | Ship before the wire break, additively: an opaque `chat_id` plus `runtime` on every chat-addressed message | Worker rows carry `chat_id` (the `worker_id`) and `runtime: worker`; session rows carry `chat_id` (the `session_id`) and `runtime: worker`, so the bridge passes them through | P1-14 |
| **S-4** photos | Keep bridge-side staging, then forward each JPEG with `attachments.stage` under the same `attachment_id` and SHA-256; staging idempotent by `attachment_id` plus SHA-256 with status read-back, never a re-upload; limits 4 × 2 MiB and 8 MiB per message; real image blocks in the model request and the same image in history | `attachments.stage`, `attachments.status`, `attachments.release`, `sessions.prompt {attachments}`, `blobs.read` | P1-16 |
| **S-5** interrupt marker | The worker owns it: the rule from the log (the newest turn on the active path ended `aborted`, no user message since, the new text starts a turn), Shep's text, delivered and display text recorded separately, the entry flagged | The SDK child applies the rule to every prompt from any caller. The model gets `[The previous request was interrupted by the user before it finished.]` and a line feed in front of the text; a `pi-worker.input` custom entry right before the user message records `{command_id, execution_id, interrupt_marker, display_text}` (display text only when marked); the receipt's `result.interrupt_marker` says whether it applied; previews strip it. The bridge's worker driver sends plain text | P1-14 |
| **S-6** bridge user | Not blocking; make the socket directory's group and mode configurable now (0750 directory, 0660 socket, a `piw` group) | `PIW_SOCKET_GROUP` (a group name or gid) selects group access: the socket directory must be exactly 0750 in that group and the socket is 0660 in it; unset, 0700 and 0600 as before. The bearer grant is still required on every request | P1-14 |
| **S-7** push seeding | The contract rule: seed on cold start only, diff on resync, dedupe by `interaction_id` and `execution_id` | Nothing new in the worker: the snapshot already carries `interaction_id`s and `settle_count` | — |
| **S-8** activity | Add `last_activity_at` and a short `preview` (marker stripped) to the worker row | Worker rows carry `last_activity_at` (the newest entry's time in the session file), `preview` (the newest user or assistant text, at most 280 characters, marker stripped), `title`, `status_since`, `settle_count`, `lineage`, `repo_label`, `model` and `thinking` | P1-14 |
| **S-9** cross-driver opens | Refuse in the bridge with its duplicate-open reservations | Nothing in the worker | — |
| **S-10** mixed machines | One merged list keyed by `{machine, runtime, chat_id}` | `runtime` and `chat_id` on rows (S-3) | P1-14 |
| **S-11** naming | "Worker API" in Shep's docs | — | — |
| **S-12** R22 approvals | The title-prefix path is acceptable for P5; a typed `tool_approval` as soon as there is one | The worker already has the typed `tool_approval` kind for gates (P1-10); title reading stays the bridge's named exception | — |

**Other P1-14 decisions.** `sessions.list` and `sessions.get` list the worker's resume catalog (sessions a worker of
this supervisor bound), not pi's own session directories, because only those can be resumed with
`workers.create {resume_session_id}`; a session started in a herdr pi stays the bridge's (S-9). `models.list` and
`commands.list` for a cwd run a short-lived pi process in inventory mode that loads the cwd's settings and resources,
opens no session and exits. In P1-14, extension commands, prompt templates and skills are listed but marked
`unsupported`; `commands.invoke` (P1-15) makes extension commands invocable.

**P1-15 decisions.** `sessions.compact`, `resources.reload` and `commands.invoke` are session writes (invariant 3
names compact, command invoke and reload): refused `no_effect` under a fence, during a move and while an execution
runs; a lost reply is `outcome_unknown` and fences. Compaction and reload cancel live dialogs at their exact resolvers
first; neither moves the binding (same session file, same tree), so the bridge's binding stays valid. pi's own
"nothing to compact" and "already compacted" preconditions, which pi checks before any hook, are `no_effect` only when
the session is unchanged. `commands.invoke` runs extension commands only; skills and prompt templates stay
`unsupported` until a later PR serves their expansion through `sessions.prompt`.

**P1-16 decisions (S-4).** `attachments.stage` streams into a private staging file and is checked after the last byte
(SHA-256, magic bytes); every refusal up to there removes the file and is `no_effect`. Then the receipt flow: dispatch
record, the bytes fsynced and renamed, one `attachment` journal record makes it `staged`. The same `attachment_id` and
SHA-256 again returns a receipt naming the original command (`duplicate_of`) and stores nothing; another hash is
`attachment_id_conflict`. `attachments.status` answers `receiving` while an upload streams, then `staged` or
`released`; an unknown id is `effect: unknown`, never "nothing staged". Staging is allowed under a fence (the prompt is
refused). The worker header and epoch are checked; the session headers are recorded and the prompt checks its own
binding. A worker holds at most 16 staged attachments and 32 MiB. `sessions.prompt {attachments}` sends real image
blocks (the SDK child reads the staged file and checks its hash); the receipt's `result.accepted_images` is the number
of images pi put in the user message (pi drops an image it cannot convert, with a hint). A delivered prompt releases
its attachments; the image stays in pi's session file. `blobs.read` is by session id
(`GET /b2/sessions/{session_id}/entries/{entry_id}/blobs/{index}`), so it serves live and archived sessions alike, and
returns the image pi stored (after pi's own normalization), at most `hello.limits.blob_max_bytes` (16 MiB), with the
media type in an allowlist (JPEG, PNG, WebP, GIF) and matching the bytes. The Go client's streamed upload and byte
reads are P1-17.
