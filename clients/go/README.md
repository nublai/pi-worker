# Go client for B2

`github.com/nublai/pi-worker/clients/go`: Go 1.24, standard library only (`stdlib-gate.sh` enforces it, tests
included).

| File | What |
| --- | --- |
| `b2/models.gen.go` | Models from oapi-codegen v2.8.2, models only (`b2/oapi-codegen.yaml`; the tool is pinned in `tools/go/go.mod`). |
| `b2/ops.gen.go` | Operation table, `EventTypes`, `GrantProfiles` and typed JSON call wrappers, from `tools/codegen/go.mjs`. |
| `b2/transport.go` | Unix-socket transport: SO_PEERCRED owner check before the bearer, one attempt, no keep-alive, no redirects, classification. |
| `b2/bytes.go` | The byte operations: `AttachmentsStage` (streamed upload, never buffered whole or re-sent), `SessionsHistory` and `BlobsRead` (byte reads with their headers). |
| `b2/sse.go`, `b2/events.go` | The SSE loop (`Watch`) and the event union decoder. Never reconnects on its own. |
| `workerfake/` | A fake worker for driver tests (below). |
| `workerfake/fixtures.gen.json` | The fake's embedded copy of `api/fixtures`, from `tools/codegen/go-fixtures.mjs`. |

Regenerate with `npm run generate` at the repository root. Failures are `*ClientFailure`: `NoEffect` only before the
connection reaches the writer or when the worker says `no_effect`; otherwise `UnknownEffect`, and the caller reads the
receipt for its `command_id`. After an upload whose reply was lost, read `AttachmentsStatus` for the attachment id;
never upload again blindly.

## `workerfake`

`workerfake.Start(workerfake.Options{})` serves B2 on a private socket with a grant file (`Fake.Client()` returns a
client for it). The grant is the `bridge` profile unless `Options.Methods` says otherwise.

- **Stateful (default).** Workers, bindings, executions, the follow-up queue, fences and `resolve_unknown`,
  receipts, interactions, attachments and the event stream follow the worker's rules. Reads it does not model
  (models, commands, the session catalog, history bytes, blobs, files) answer from the wire fixtures.
- **Replay (`Options.Replay`).** Every operation answers only from its wire fixtures, matched exactly; use it to test
  that a driver handles every documented reply, refusals included.
- **Fixture controls**, never model effects: `Host(id)` (`DropNextPromptReply`, `HoldNextPromptReply`,
  `ReleaseHeldReply`, `NextAgentStart`, `Emit("agent_start" | "agent_settled" | "exit")`, `Prompts`), `Hosts`,
  `Restart`, `Drain`, `Disk`, `Overflow`, `DropNextStageReply`, `OpenInteraction`. A prompt starts and is
  acknowledged; nothing settles until `Emit("agent_settled")`.

Its tests are the plan's P1-17 check: the Go replay of `api/fixtures/transitions.json` (the eleven section 0.1 rows,
semantic hash pinned), the bridge-profile closure (every method routed, with wire fixtures, answered; every wire
fixture round-trips through its typed Go call), SSE reconnect and overflow, and the streamed upload (1.5 MiB, a lost
reply reconciled through `attachments.status`, limits refused before sending).

## Vendoring (Shep, S-2)

Copy `b2/` and `workerfake/` (with `fixtures.gen.json`) at one pi-worker commit, rewrite the import path
`github.com/nublai/pi-worker/clients/go/b2` in `workerfake/*.go` to the vendored one, and record the commit and the
files' SHA-256 in the stamp file. Nothing outside the two directories is read at build or test time. Skip
`b2/integration_test.go`: it starts the built worker from this repository.

```sh
go vet ./... && go test -race ./...
go test -race ./workerfake/...     # the P1-17 check alone
go test -tags integration ./...    # needs `npm run build` first; starts packages/worker/dist/src/main.js
./stdlib-gate.sh
```
