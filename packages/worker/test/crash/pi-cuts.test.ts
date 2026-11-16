/**
 * Real pi leader SIGKILL at each receipt phase (P1-13), ported from A0 `src/test/gate1-pi-cuts.test.ts`: the
 * supervisor stays alive while the pi process is killed right after the prompt's intent, dispatch marker or delivered
 * result is fsynced. A fixture extension's input hook is the native effect (it appends `ONCE` to a file). No duplicate
 * effect, no blind replay: the receipt is `delivered` with one effect only when the effect happened before the kill,
 * otherwise `outcome_unknown` with the session fenced; a duplicate returns the stored receipt; a restart recovers the
 * same receipt and fence without relaunching anything. Real pi 1.5.2, no credentials, no model call; HOME and
 * PI_CODING_AGENT_DIR live in the test's temporary directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SdkHost } from '../../src/host/host.js';
import { openState, type SupervisorState as OpenState } from '../../src/journal/state.js';
import { ReceiptStore } from '../../src/receipts/receipts.js';
import type { HostFactory } from '../../src/supervisor/state.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { bind, tick } from '../supervisor-fixture.js';
import { privateTmp } from '../helpers.js';

for (const phase of ['intent', 'accepted', 'delivered'] as const) {
  test(`crash (real pi): SIGKILL of the pi leader after the prompt ${phase} fsync: no duplicate effect or blind replay`, { timeout: 60_000 }, async () => {
    const tmp = privateTmp();
    const root = realpathSync(tmp.dir);
    const cwd = join(root, 'workspace');
    const state = join(root, 'state');
    const agent = join(root, 'agent');
    const home = join(root, 'home');
    for (const path of [cwd, state, agent, home]) mkdirSync(path, { mode: 0o700 });
    const extension = join(cwd, 'effect.mjs');
    const effect = join(cwd, 'effect');
    writeFileSync(
      extension,
      `import {appendFileSync} from 'node:fs';export default pi=>pi.on('input',e=>{if(e.text==='cut'){appendFileSync(${JSON.stringify(effect)},'ONCE\\n');return {action:'handled'}}});`,
    );
    // No credentials anywhere: only PATH, a private HOME and an empty agent directory.
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PI_CODING_AGENT_DIR: agent };
    const open = (factory: HostFactory): { opened: OpenState; s: Supervisor } => {
      const opened = openState(state);
      return { opened, s: new Supervisor({ journal: opened.journal, receipts: new ReceiptStore(opened.journal), supervisorEpoch: opened.supervisorEpoch, stateDir: state, factory }) };
    };
    let { opened, s } = open(launch =>
      new SdkHost(
        {
          cwd: launch.cwd,
          sessionDir: launch.sessionDir,
          provider: launch.create.provider,
          model: launch.create.model,
          thinking: launch.create.thinking,
          projectTrusted: false,
          launchSpec: launch.create.launch_spec ?? null,
        },
        { env },
      ),
    );
    try {
      const created = await s.create({
        command_id: 'create',
        cwd,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        thinking: 'off',
        launch_spec: { environment: { id: 'cut', revision: 1, allowed_methods: [] }, role: 'fixture', tools: [], denied_tools: [], resources: { extensions: [extension], skills: [] }, grant_methods: [], seed_mode: 'standalone' },
      });
      assert.equal(created.state, 'delivered', JSON.stringify(created));
      const w = s.get(created.worker_id!);
      const host = s.state.require(w.worker_id).host!;
      const exited = new Promise<void>(r => host.on('exit', r));
      const journal = opened.journal;
      const append = journal.append.bind(journal);
      let killed = false;
      journal.append = (kind, value, label, reservation) => {
        const appended = append(kind, value, label, reservation);
        if (!killed && kind === 'receipt' && value.command_id === 'cut' && value.state === phase) {
          assert.ok(host.pid && host.pid !== process.pid);
          killed = true;
          process.kill(host.pid, 'SIGKILL');
        }
        return appended;
      };
      const request = { ...bind(w, 'cut'), message: 'cut' };
      const receipt = await s.prompt(w.worker_id, request);
      await exited;
      await tick();
      assert.equal(killed, true);
      assert.equal(receipt.state, phase === 'delivered' ? 'delivered' : 'outcome_unknown');
      assert.equal(Boolean(s.get(w.worker_id).fence), phase !== 'delivered');
      const bytes = existsSync(effect) ? readFileSync(effect, 'utf8') : '';
      assert.equal(bytes, phase === 'delivered' ? 'ONCE\n' : '');
      assert.deepEqual(await s.prompt(w.worker_id, request), receipt);
      await s.shutdown();
      opened.close();
      let factories = 0;
      ({ opened, s } = open(() => {
        factories++;
        throw new Error('must never relaunch on recovery');
      }));
      await s.recover();
      assert.deepEqual(s.receipts.all.get('cut'), receipt);
      assert.deepEqual(await s.prompt(w.worker_id, request), receipt);
      assert.equal(factories, 0);
      assert.equal(existsSync(effect) ? readFileSync(effect, 'utf8') : '', bytes);
      assert.equal(Boolean(s.get(w.worker_id).fence), phase !== 'delivered');
      const latest = opened.journal.records.filter(r => r.kind === 'receipt' && r.value.command_id === 'cut').at(-1)!;
      assert.equal(latest.value.state, receipt.state);
    } finally {
      await s.shutdown();
      opened.close();
      tmp.cleanup();
    }
  });
}
