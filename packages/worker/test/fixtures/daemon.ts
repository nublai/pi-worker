/**
 * The daemon on test domains (../domains.ts) for tests that need a running daemon process on a host without a cgroup
 * delegation (plain CI runners, developer machines). Everything but the containment and the installation locks'
 * directory is the production daemon (src/daemon.ts); src/main.ts refuses to start without a delegation, and its
 * refusal is tested in security/containment.test.ts. Run as `node dist/test/fixtures/daemon.js` with PIW_STATE_DIR and
 * PIW_SOCKET.
 *
 * The installation locks: production always uses `/run/user/<euid>/pi-worker-installations` (src/containment/
 * containment.ts `installationLocks`), which a runner may lack and which tests must not fill. This fixture uses
 * `PIW_TEST_INSTALLATION_LOCKS`, else `pi-worker-installations` in the socket's directory; a test that needs two
 * daemons to contend sets the same PIW_TEST_INSTALLATION_LOCKS for both.
 */
import { dirname, join } from 'node:path';
import { runDaemon } from '../../src/daemon.js';
import { TestDomains } from '../domains.js';

const installationLocks = process.env.PIW_TEST_INSTALLATION_LOCKS || join(dirname(process.env.PIW_SOCKET ?? ''), 'pi-worker-installations');

await runDaemon(() => new TestDomains(), { installationLocks });
