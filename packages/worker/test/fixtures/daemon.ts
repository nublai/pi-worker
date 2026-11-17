/**
 * The daemon on test domains (../domains.ts) for tests that need a running daemon process on a host without a cgroup
 * delegation (plain CI runners, developer machines). Everything but the containment is the production daemon
 * (src/daemon.ts); src/main.ts refuses to start without a delegation, and its refusal is tested in
 * security/containment.test.ts. Run as `node dist/test/fixtures/daemon.js` with PIW_STATE_DIR and PIW_SOCKET.
 */
import { runDaemon } from '../../src/daemon.js';
import { TestDomains } from '../domains.js';

await runDaemon(() => new TestDomains());
