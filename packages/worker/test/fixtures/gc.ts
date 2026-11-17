/**
 * Preloaded into a daemon (`node --expose-gc --import dist/test/fixtures/gc.js <daemon>`): on SIGUSR2 it runs full
 * garbage collections, lets their weak callbacks run, then prints `{"event":"collected"}` to stderr. A test signals it
 * once the daemon listens, so anything the daemon holds only by an unreachable reference (its installation lock, PR #23
 * GPT delta 3, Grok delta 1) is closed before the test goes on, as an ordinary collection would at some later time.
 * The daemon's own code is unchanged.
 */
import { setImmediate as tick } from 'node:timers/promises';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('fixtures/gc.js needs node --expose-gc');

process.on('SIGUSR2', () => {
  void (async () => {
    for (let n = 0; n < 3; n++) {
      gc();
      await tick();
    }
    process.stderr.write(`${JSON.stringify({ event: 'collected' })}\n`);
  })();
});
