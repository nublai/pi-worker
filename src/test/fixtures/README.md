# THROWAWAY section 0.1 conformance fixtures

`transitions.json` is data, not a TypeScript fixture. It has one row per contract revision 5 section 0.1 row. A future Go fake can replay the same table; no Go implementation or race-test claim is made here.

Each row starts with a fresh idle worker, private socket, controller grant and an exclusive empty cwd. Save its initial binding as `initial`. `worker` is a fresh authoritative `workers.get` after each step. `child_cwd` is a separate available cwd. Expand `macro` steps recursively from the top-level `macros` map.

Steps:

- `call`: send the named B2 method once. Body = the named binding (`initial` by default), `command_id`, then `fields`. Recursively replace a string beginning `@` with the value at that dot-path in `{initial,worker,child_cwd}`. The worker URL uses `initial.worker_id`. Save the JSON receipt or labelled HTTP error as `result`.
- `begin`: start a call, but wait only for native `agent_start`, not its reply.
- `host_reply`: native test seam, not a B2 method. `drop` loses the next prompt response after it starts; `hold` delays the response until `drop_reply`. Neither retries input.
- `drop_reply`: lose the held native reply, then await the previously begun B2 result.
- `host_event`: inject the given native event. `exit` is the host lifecycle event, not a Pi JSON message.
- `drain`: let due supervisor queue items run to the next asynchronous barrier; never admit a fenced item.
- `restart`: discard the old supervisor, recover its journal, and start a new transport epoch. Never adopt a host. The `unconfirmed_native_identity` profile supplies an untrusted/missing process token: cleanup must remain pending without attempting to signal an unrelated process.

Assertions are generic dot-path equality against `{result,worker,disk,effects}`. `disk` is the latest fsynced worker record; `effects.prompts` counts actual native prompt submissions and `effects.hosts` native host launches, independently of receipts. Array indices are ordinary path segments. No assertion accepts an agent completion message as evidence.

Row 01 exercises the binding rule with `new`; separate tests exercise fork and same-process resume, source-leaf checks and interaction invalidation. Pi 1.5.2 RPC has `get_tree`, but **no direct tree-navigation command**. That variant remains explicitly uncovered, not a green claim. The native lifecycle seam in these fixtures is deterministic; live Pi and actual supervisor SIGKILL evidence is separate.
