/**
 * Relaunch over real cgroup v2 domains (P2-3, kernel tier: `harness/ci/kernel.sh -- relaunch`, which sets
 * PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT; elsewhere these skip). The old epoch's leader double-forks a setsid/nohup
 * grandchild that would write a marker later. Whatever ends the old epoch (a stop, a leader crash, a supervisor crash
 * and recovery), `workers.relaunch` starts the new epoch only after that grandchild is dead and the old domain removed
 * and recorded: the factory of the new epoch checks it at the moment it is asked to spawn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CgroupContainment, checkDelegation, type Domain } from '../../src/containment/containment.js';
import { procInfo, processToken } from '../../src/host/process.js';
import { parseJournal } from '../../src/journal/journal.js';
import { openState } from '../../src/journal/state.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import type { HostFactory, Persisted } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { privateTmp } from '../helpers.js';
import { bind, Host, retire } from '../supervisor-fixture.js';

const kernel = process.env.PIW_TEST_KERNEL === '1';
const skip = kernel ? false : 'kernel tier: needs PIW_TEST_KERNEL=1 and PIW_CGROUP_ROOT in a delegated user service (harness/ci/kernel.sh)';
const root = process.env.PIW_CGROUP_ROOT ?? '';

/** A double fork with setsid and nohup: the grandchild leaves the leader's process group and session. */
const DETACHED = `(setsid nohup /bin/sh -c 'echo $$ > "$1"; sleep 2; echo ESCAPED > "$2"' detached "$1" "$2" >/dev/null 2>&1 &); echo READY`;
const gone = (pid: number) => !procInfo(pid) || procInfo(pid)?.state === 'Z';
const rows = (file: string): Persisted[] =>
  parseJournal(readFileSync(file))
    .records.filter(r => r.kind === 'worker')
    .map(r => r.value as unknown as Persisted);

/** What the new epoch's factory observed when it was asked to spawn. */
interface AtRelaunch {
  grandchildDead: boolean;
  oldDomainPresent: boolean;
  /** The old epoch's removal was recorded before the new epoch's first row. */
  recorded: boolean;
  newDomain: Domain;
}

for (const end of ['stop', 'leader-crash', 'supervisor-crash'] as const) {
  test(`kernel: relaunch after a ${end} starts the new epoch only once the old epoch's setsid grandchild is dead and its domain removed and recorded`, { skip, timeout: 60_000 }, async () => {
    const tmp = privateTmp();
    const dir = tmp.dir;
    const pidFile = join(dir, 'grandchild.pid');
    const marker = join(dir, 'escaped');
    const leaders: ChildProcess[] = [];
    let grandchild = 0;
    let oldDomain: Domain | undefined;
    let oldEpoch = '';
    let seen: AtRelaunch | undefined;
    let state = openState(dir);
    const factory: HostFactory = launch => {
      const relaunch = leaders.length > 0;
      if (relaunch) {
        seen = {
          grandchildDead: gone(grandchild),
          oldDomainPresent: existsSync(join(root, oldDomain!.name)),
          recorded: (() => {
            const all = rows(state.journal.file);
            const first = all.findIndex(p => p.worker.worker_epoch !== oldEpoch);
            return all.slice(0, first).some(p => p.worker.cleanup === 'cgroup_empty_removed' && p.worker.status === 'stopped');
          })(),
          newDomain: launch.domain,
        };
      }
      const file = join(launch.sessionDir, `launch-${leaders.length}.jsonl`);
      const sid = relaunch ? 'fresh' : 's';
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid })}\n`);
      const script = relaunch ? 'echo READY; read line' : `${DETACHED}; read line`;
      const leader = spawn(launch.prefix[0]!, [...launch.prefix.slice(1), '/bin/sh', '-c', script, 'payload', pidFile, marker], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      leaders.push(leader);
      const h = new Host(launch.sessionDir, sid, file);
      h.pid = leader.pid;
      h.token = processToken(leader.pid!);
      // A host's own stop is never the proof: the domain is.
      h.stopOk = false;
      leader.once('exit', () => h.emit('exit'));
      return h;
    };
    const open = () =>
      new Supervisor({
        journal: state.journal,
        receipts: new ReceiptStore(state.journal),
        supervisorEpoch: state.supervisorEpoch,
        stateDir: dir,
        containment: new CgroupContainment(checkDelegation(root), state.installation),
        factory,
      });
    let s = open();
    try {
      const made = await s.create({ command_id: 'create', cwd: dir, provider: 'p', model: 'm', thinking: 'off' });
      assert.equal(made.state, 'delivered');
      const w = s.get(made.worker_id!);
      oldEpoch = w.worker_epoch;
      oldDomain = s.state.require(w.worker_id).domain!;
      for (let n = 0; n < 300 && !(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()); n++) await delay(10);
      grandchild = Number(readFileSync(pidFile, 'utf8'));
      assert.match(readFileSync(join(root, oldDomain.name, 'cgroup.procs'), 'utf8'), new RegExp(`^${grandchild}$`, 'm'), 'the detached grandchild is in the old domain');
      if (end === 'stop') {
        assert.equal((await s.stop(w.worker_id, bind(w, 'stop'))).result?.termination, 'observed_stopped');
      } else if (end === 'leader-crash') {
        const exited = once(leaders[0]!, 'exit');
        process.kill(leaders[0]!.pid!, 'SIGKILL');
        await exited;
        for (let n = 0; n < 600 && s.get(w.worker_id).cleanup !== 'cgroup_empty_removed'; n++) await delay(10);
      } else {
        // The supervisor dies: nothing of it cleans anything. Its successor's recovery kills and removes the domain.
        retire(s);
        state.close();
        state = openState(dir);
        s = open();
        assert.ok(!gone(grandchild), 'the grandchild outlived its supervisor');
        await s.recover();
      }
      assert.deepEqual([s.get(w.worker_id).status, s.get(w.worker_id).cleanup], ['stopped', 'cgroup_empty_removed']);
      const relaunched = await s.relaunch(w.worker_id, bind(s.get(w.worker_id), 'relaunch'));
      assert.equal(relaunched.state, 'delivered', JSON.stringify(relaunched));
      assert.ok(seen, 'the new epoch was spawned');
      assert.equal(seen.grandchildDead, true, "the old epoch's setsid grandchild is dead before the new epoch starts");
      assert.equal(seen.oldDomainPresent, false, "the old epoch's domain is removed before the new epoch starts");
      assert.equal(seen.recorded, true, 'the removal is recorded before the new epoch is');
      assert.notEqual(seen.newDomain.name, oldDomain.name);
      const fresh = s.get(w.worker_id);
      assert.equal(fresh.status, 'ready');
      assert.notEqual(fresh.worker_epoch, oldEpoch);
      assert.equal(fresh.session_id, 's', 'the new epoch reopened the old session');
      // The join prefix enters the domain before it runs the leader, which then says READY.
      await once(leaders[1]!.stdout!, 'data');
      assert.match(readFileSync(join(root, seen.newDomain.name, 'cgroup.procs'), 'utf8'), new RegExp(`^${leaders[1]!.pid}$`, 'm'), 'the new leader runs in the new domain');
      await delay(2200);
      assert.equal(existsSync(marker), false, 'the grandchild never wrote after its domain was cleaned');
    } finally {
      await s.shutdown();
      const jail = new CgroupContainment(checkDelegation(root), state.installation);
      for (const d of [oldDomain, seen?.newDomain]) if (d) await jail.clean(d);
      state.close();
      tmp.cleanup();
    }
  });
}
