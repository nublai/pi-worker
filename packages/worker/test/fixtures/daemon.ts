/**
 * The daemon on test domains (../domains.ts) for tests that need a running daemon process on a host without a cgroup
 * delegation (plain CI runners, developer machines). Everything but the containment is the production daemon
 * (src/daemon.ts); src/main.ts refuses to start without a delegation, and its refusal is tested in
 * security/containment.test.ts. Run as `node dist/test/fixtures/daemon.js` with PIW_STATE_DIR and PIW_SOCKET.
 *
 * The installation lock (src/containment/containment.ts `holdInstallation`) lives in `$XDG_RUNTIME_DIR`; a runner may
 * have none, so without one the fixture uses the socket's directory (a test that needs two daemons to contend sets
 * XDG_RUNTIME_DIR for both).
 */
import { dirname } from 'node:path';
import { runDaemon } from '../../src/daemon.js';
import { TestDomains } from '../domains.js';

if (!process.env.XDG_RUNTIME_DIR && process.env.PIW_SOCKET) process.env.XDG_RUNTIME_DIR = dirname(process.env.PIW_SOCKET);

await runDaemon(() => new TestDomains());
