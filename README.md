# pi-worker

One supervisor per Linux user that runs pi headless, one session per worker, with typed events and dialogs, a
durable journal, receipts, epochs and explicit unknown outcomes, and child sessions in worktrees and sandboxes. Its
typed API (B2) is served over a private Unix socket.

**Status: P0 (foundation) in progress.** The contract is nublai/root `.pi/plan/worker-contract.md`, revision 8
(sections 0, 0.1 and 0.2 frozen). The build plan is [docs/plan/production.md](docs/plan/production.md); how agents
work here is in [AGENTS.md](AGENTS.md).

Requirements: Linux, Node 26.12.1 or later for the daemon (`.node-version` pins CI).

```sh
npm ci --ignore-scripts
npm run check
```

License: [MIT](LICENSE) (nubl decision R21, plan decision D1).
