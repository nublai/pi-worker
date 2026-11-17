/**
 * Two seams for the late-cleanup cases (relaunch.test.ts, stop.test.ts): test domains whose cleanups wait until the
 * test finishes them (A0's controllable `jail.clean`), and a second cleanup of one domain started while the first is in
 * flight. Production shares one cleanup per worker (PR #21), so a late completion for a superseded generation cannot
 * happen through B2: a relaunch needs the recorded confirmation that only follows that one cleanup. A0 ran one cleanup
 * per caller; `independentCleanup` recreates that.
 */
import type { Domain } from '../src/containment/containment.js';
import type { Supervisor } from '../src/supervisor/supervisor.js';
import { TestDomains } from './domains.js';

/** Test domains whose cleanups wait for `finish` while held (A0's controllable `jail.clean`). */
export function heldDomains(): { domains: TestDomains; calls: { domain: Domain; finish: (gone: boolean) => void }[]; hold: () => void; release: () => void } {
  const domains = new TestDomains();
  const real = domains.clean.bind(domains);
  const calls: { domain: Domain; finish: (gone: boolean) => void }[] = [];
  return {
    domains,
    calls,
    hold: () => {
      domains.clean = domain => new Promise<boolean>(finish => calls.push({ domain, finish }));
    },
    release: () => {
      domains.clean = real;
      for (const call of calls) call.finish(true);
    },
  };
}

/** The seam: the next cleanup of this worker starts on its own instead of sharing the one in flight (A0's per-caller cleanup). */
export function independentCleanup(s: Supervisor, id: string): void {
  s.state.require(id).cleaning = undefined;
}

