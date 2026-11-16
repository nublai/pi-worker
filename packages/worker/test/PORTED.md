# Ported A0 tests

Ledger of tests ported from A0 (`prototype/a0` at `ee66117`, `src/test/`). A port keeps every assertion. A test that
reached into A0 internals is rewritten to drive B2 and the host seam, with the same assertions. A partial port names
the assertions still waiting and the PR that ports them.

| A0 test | New test | Status |
| --- | --- | --- |
| `transport.test.ts` › "client failure before connect is no_effect; after write is unknown, one attempt and keepalive disabled" | `packages/client-ts/test/transport.test.ts` › same name | Ported, all assertions (literal binding instead of a fixture worker) |
| `transport.test.ts` › "public client retains no_effect HTTP detail and supervisor-wide snapshot; overflow disables controls" | `packages/client-ts/test/transport.test.ts` › "public client retains no_effect HTTP detail and the snapshot; overflow disables controls until a resync snapshot" | Partial: client-side assertions ported against a fake worker. Waiting for P1-8 (event hub): the snapshot coming from a real supervisor with one worker, overflow produced by the bounded subscriber queue under backpressure, and `status === 'ready'` after overflow |
| `transport.test.ts` › "one supervisor stream filters workers/types, snapshot barrier, bounded explicit overflow and resync" | — | Waiting for P1-8 (`EventHub` rewrite) |
| `conformance.test.ts` (fixture replay) | `packages/worker/test/conformance/transitions.test.ts` | Runner ported in P0-7 with all row assertions; rows run as `todo` until P1 |
| `receipts.test.ts` › "a late callback on a CLOSED journal cannot corrupt a newly opened journal via recycled fd" | `packages/worker/test/crash/journal.test.ts` › same name | Ported in P1-1, all assertions (append takes a durable label) |
| `receipts.test.ts` › "journal truncates a torn final record, rejects complete corruption or sequence gaps" | `packages/worker/test/crash/journal.test.ts` › same name | Ported in P1-1, all assertions |
