/**
 * Children core (P1-11), ported from A0 `src/test/children.test.ts` with every assertion. A0's `callerGrant.run(grant)`
 * is `authority.run` with the guard the B2 router builds for a grant (its methods, rechecked against the registry);
 * A0's `grants.register` returns a bearer file, ours a record whose id the test uses. Reports arrive as the host's
 * `report` events, as the SDK host emits them from the child's FD 3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJournal } from '../src/journal/journal.js';
import { openState } from '../src/journal/state.js';
import { ReceiptStore } from '../src/receipts/receipts.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { join } from 'node:path';
import { Refusal } from '../src/b2/errors.js';
import { authority, type Guard } from '../src/grants/authority.js';
import { allowsMethod, type GrantStore } from '../src/grants/store.js';
import type { Create, Worker } from '../src/supervisor/state.js';
import type { EventFrame } from '../src/generated/events.js';
import type { SessionHost } from '../src/host/host.js';
import { createApp } from '../src/b2/app.js';
import { createMemoryTransport } from '../src/b2/memory.js';
import { bind, fixture, Host, tick, type Fixture } from './supervisor-fixture.js';

type Grant = { grant_id: string; methods: readonly string[] };

const store = (f: Fixture): GrantStore => f.supervisor.state.grants!;

/** A registered grant, as the owner's `grant register` makes it. */
function scopedGrant(f: Fixture, id: string, methods = ['workers.create', 'children.report']): Grant {
  const { grant } = store(f).register({ caller: id, scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods, grant_id: id });
  return grant;
}

/** The guard the router runs a request under for this grant (A0's `callerGrant.run`). */
function asCaller<T>(f: Fixture, grant: Grant, fn: () => Promise<T>): Promise<T> {
  const guard: Guard = Object.assign(
    () => {
      const now = store(f).read(grant.grant_id);
      if (now.revoked) throw new Refusal('grant_revoked');
    },
    { grant_id: grant.grant_id, caller_name: grant.grant_id, methods: grant.methods },
  );
  return authority.run(guard, fn);
}

export const spec: NonNullable<Create['launch_spec']> = {
  environment: { id: 'test', revision: 1, allowed_methods: ['workers.create', 'children.report'] },
  role: 'writer',
  tools: ['read', 'write', 'caller_ping'],
  denied_tools: ['bash'],
  resources: { extensions: [], skills: [] },
  grant_methods: ['workers.create', 'children.report'],
  seed_mode: 'standalone',
};

async function parent(f: Fixture, launch_spec = spec): Promise<Worker> {
  const cwd = join(f.dir, 'parent');
  mkdirSync(cwd);
  const r = await f.supervisor.create({ command_id: 'parent', cwd, provider: 'p', model: 'm', thinking: 'off', launch_spec });
  const w = f.supervisor.get(r.worker_id!);
  await f.supervisor.prompt(w.worker_id, { ...bind(w, 'task'), message: 'fan out' });
  return f.supervisor.get(w.worker_id);
}

function child(f: Fixture, p: Worker): Create {
  const cwd = join(f.dir, 'child');
  mkdirSync(cwd);
  return {
    command_id: 'child',
    cwd,
    provider: 'p',
    model: 'm',
    thinking: 'off',
    parent: { worker_id: p.worker_id, worker_epoch: p.worker_epoch, session_id: p.session_id!, binding_revision: p.binding_revision, execution_id: p.execution!.execution_id, task_id: 'job', generation_id: 'generation' },
    launch_spec: { ...structuredClone(spec), grant_methods: ['children.report'] },
  };
}

test('children: late native exit cannot downgrade a confirmed stop', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.hosts[0]!.stop = async () => true; // OS probe wins before Node exit event.
    const receipt = await f.supervisor.stop(w.worker_id, bind(w, 'stop'));
    assert.equal(receipt.state, 'delivered');
    f.hosts[0]!.emit('exit');
    assert.equal(f.supervisor.get(w.worker_id).status, 'stopped');
  } finally {
    f.cleanup();
  }
});

test('children: help-only durable report does not discharge the parent recovery fence', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    const r = await f.supervisor.create(c);
    const w = f.supervisor.get(r.worker_id!);
    f.hosts[1]!.emit('report', { report_id: 'help-only', kind: 'help', message: 'blocked' });
    await tick();
    await tick();
    assert.equal(f.supervisor.get(w.worker_id).child_reports!.length, 1);
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const recovered = await f.restart(() => {
      throw new Error('no recovery spawn');
    });
    assert.ok(recovered.get(p.worker_id).fence?.uncertain_command_ids?.includes(c.command_id), 'help is not completion');
  } finally {
    f.cleanup();
  }
});

for (const restriction of ['caller', 'parent'] as const) {
  test(`children: child methods respect distinct ${restriction} grant ceiling`, async () => {
    const f = fixture();
    try {
      const parentSpec = structuredClone(spec);
      if (restriction === 'parent') parentSpec.grant_methods = ['children.report'];
      const parentGrant = scopedGrant(f, 'parent-source');
      assert.notEqual(parentGrant.grant_id, 'owner');
      const p = await asCaller(f, parentGrant, () => parent(f, parentSpec));
      const c = child(f, p);
      // The environment permits both methods, so it cannot mask either tested ceiling.
      c.launch_spec!.grant_methods = restriction === 'caller' ? ['children.report'] : ['workers.create'];
      const caller = scopedGrant(f, 'child-caller', restriction === 'caller' ? ['workers.create'] : ['workers.create', 'children.report']);
      await assert.rejects(() => asCaller(f, caller, () => f.supervisor.create(c)), restriction === 'caller' ? /child_grant_not_subset/ : /child_authority_not_subset/);
      assert.equal(f.hosts.length, 1);
      assert.equal(f.supervisor.state.workers.size, 1);
    } finally {
      f.cleanup();
    }
  });
}

for (const revoked of ['parent-source', 'child-caller'] as const) {
  test(`children: FD report rechecks distinct ${revoked} revocation`, async () => {
    const f = fixture();
    try {
      const pg = scopedGrant(f, 'parent-source');
      const cg = scopedGrant(f, 'child-caller');
      const p = await asCaller(f, pg, () => parent(f));
      const c = child(f, p);
      const r = await asCaller(f, cg, () => f.supervisor.create(c));
      assert.notEqual(pg.grant_id, cg.grant_id);
      store(f).revoke(revoked);
      f.hosts[1]!.emit('report', { report_id: 'revoked', kind: 'result', message: 'must not arrive' });
      await tick();
      await tick();
      assert.equal(f.supervisor.get(r.worker_id!).child_reports!.length, 0);
      assert.equal(
        [...f.supervisor.receipts.all.values()].some(receipt => receipt.operation === 'children.report' && receipt.state === 'delivered'),
        false,
      );
      assert.equal(f.hosts[0]!.stops, 0);
    } finally {
      f.cleanup();
    }
  });
}

test('children: child create rechecks revoked parent source even with an active independent caller', async () => {
  const f = fixture();
  try {
    const pg = scopedGrant(f, 'parent-source');
    const cg = scopedGrant(f, 'child-caller');
    const p = await asCaller(f, pg, () => parent(f));
    const c = child(f, p);
    store(f).revoke(pg.grant_id);
    await assert.rejects(() => asCaller(f, cg, () => f.supervisor.create(c)), /revoked/);
    assert.equal(f.hosts.length, 1);
  } finally {
    f.cleanup();
  }
});

test('children: FD report requires children.report in the child grant', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    c.launch_spec!.grant_methods = [];
    const r = await f.supervisor.create(c);
    f.hosts[1]!.emit('report', { report_id: 'ungranted', kind: 'result', message: 'must not arrive' });
    await tick();
    await tick();
    assert.equal(f.supervisor.get(r.worker_id!).child_reports!.length, 0);
  } finally {
    f.cleanup();
  }
});

test('children: unknown child initialization fences the live parent before another launch', async () => {
  const childCwd = (f: Fixture) => join(f.dir, 'child');
  let f!: Fixture;
  f = fixture({
    // A native get_state timeout after spawn, not a refusal before dispatch.
    launch: launch => {
      if (launch.create.command_id !== 'child') return undefined;
      const host = new Host(f.dir, 'never', join(f.dir, 'never.jsonl'));
      host.request = async () => {
        throw new Error('get_state timed out');
      };
      f.hosts.push(host);
      return host as SessionHost;
    },
  });
  try {
    const p = await parent(f);
    const c = child(f, p);
    assert.equal(c.cwd, childCwd(f));
    const r = await f.supervisor.create(c);
    assert.equal(r.effect, 'unknown');
    assert.ok(f.supervisor.get(p.worker_id).fence?.uncertain_command_ids?.includes(c.command_id));
    const cwd = join(f.dir, 'replacement');
    mkdirSync(cwd);
    await assert.rejects(() => f.supervisor.create({ ...c, cwd, command_id: 'replacement' }), /fenced/);
    assert.equal(f.hosts.length, 2);
  } finally {
    f.cleanup();
  }
});

test('children: typed child lineage exists before spawn, narrows authority and reports a claim exactly once', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    await assert.rejects(
      () => f.supervisor.launchChild(p.worker_id, { ...bind(p, 'legacy-bypass'), execution_id: p.execution!.execution_id, launch: { ...c, parent: undefined, launch_spec: undefined } as Create }),
      /typed_children_use_workers_create/,
    );
    const created = await f.supervisor.create(c);
    const w = f.supervisor.get(created.worker_id!);
    assert.deepEqual(w.parent, c.parent);
    assert.equal(w.parent_launch_command_id, 'child');
    let reports = 0;
    const sub = f.supervisor.subscribe(e => {
      if ((e as EventFrame).type === 'child.reported') reports++;
    });
    const report = { report_id: 'first', kind: 'help', message: 'which file?' };
    f.hosts[1]!.emit('report', report);
    f.hosts[1]!.emit('report', report);
    await tick();
    await tick();
    f.hosts[1]!.emit('report', report);
    await tick();
    await tick();
    assert.equal(reports, 1);
    assert.equal(f.supervisor.get(w.worker_id).child_reports!.length, 1);
    assert.equal(f.supervisor.get(w.worker_id).child_reports![0]!.claim_not_verified, true);
    assert.equal(f.supervisor.get(p.worker_id).execution!.state, 'started');
    await assert.rejects(() => f.supervisor.report(w.worker_id, { ...bind(w, 'foreign-task'), task_id: 'other', result_digest: 'not-proof' }), /wrong_child_task/);
    sub.close();
  } finally {
    f.cleanup();
  }
});

for (const widen of ['tools', 'denials', 'methods', 'environment', 'resources', 'skills', 'stale', 'execution', 'fence'] as const) {
  test(`children: typed child refuses ${widen} before any spawn or checkout reservation`, async () => {
    const f = fixture();
    try {
      const p = await parent(f);
      const c = child(f, p);
      if (widen === 'tools') c.launch_spec!.tools.push('edit');
      if (widen === 'denials') c.launch_spec!.denied_tools = [];
      if (widen === 'methods') c.launch_spec!.grant_methods.push('workers.stop');
      if (widen === 'environment') c.launch_spec!.environment.allowed_methods.push('workers.stop');
      if (widen === 'resources') c.launch_spec!.resources.extensions.push('/tmp/foreign.ts');
      if (widen === 'skills') c.launch_spec!.resources.skills.push('/tmp/foreign-skill');
      if (widen === 'execution') c.parent!.execution_id = 'old-execution';
      if (widen === 'stale') c.parent!.binding_revision++;
      if (widen === 'fence') {
        f.hosts[0]!.emit('exit');
        await tick();
      }
      await assert.rejects(() => f.supervisor.create(c), /subset|stale_binding|stale_parent_execution|fenced/);
      assert.equal(f.hosts.length, 1);
      assert.equal(f.supervisor.state.workers.size, 1);
    } finally {
      f.cleanup();
    }
  });
}

test('children: FD reports recheck parent grant revocation; siblings and parent remain untouched on child stop', async () => {
  const f = fixture();
  try {
    const grant = scopedGrant(f, 'parent');
    const p = await asCaller(f, grant, () => parent(f));
    const c = child(f, p);
    const r = await asCaller(f, grant, () => f.supervisor.create(c));
    const w = f.supervisor.get(r.worker_id!);
    const cwd = join(f.dir, 'sibling');
    mkdirSync(cwd);
    const s = await f.supervisor.create({ ...c, command_id: 'sibling', cwd, parent: { ...c.parent!, task_id: 'sibling' } });
    await f.supervisor.stop(s.worker_id!, bind(f.supervisor.get(s.worker_id!), 'stop-sibling'));
    assert.equal(f.hosts[0]!.stops, 0);
    assert.equal(f.hosts[1]!.stops, 0);
    store(f).revoke(grant.grant_id);
    f.hosts[1]!.emit('report', { report_id: 'revoked', kind: 'result', message: 'untrusted' });
    await tick();
    await tick();
    assert.equal(f.supervisor.get(w.worker_id).child_reports!.length, 0);
    assert.equal(f.hosts[0]!.stops, 0);
  } finally {
    f.cleanup();
  }
});

/** A public B2 client for a registered grant of the fixture's own registry. */
function publicApi(f: Fixture, id: string, methods: string[] = ['*']) {
  const { token } = store(f).register({ caller: id, scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods, grant_id: id });
  return createMemoryTransport(createApp({ supervisor: f.supervisor, grants: store(f) }).handle, { authorization: `Bearer ${token}` });
}

const reportBody = (w: Worker, command_id: string, task_id: string) => ({ ...bind(w, command_id), task_id, result_digest: 'sha256:claim', kind: 'result', message: 'claimed complete' });

test('children: a typed child reports only through its FD 3; public children.report is refused and never discharges the missing-report fence', async () => {
  const f = fixture();
  try {
    const pg = scopedGrant(f, 'parent-source');
    const p = await asCaller(f, pg, () => parent(f));
    const c = child(f, p);
    const r = await asCaller(f, pg, () => f.supervisor.create(c));
    const w = f.supervisor.get(r.worker_id!);
    // A second grant over every worker, holding children.report: neither it nor the creating grant can report for the
    // typed child over B2, before or after the creating grant is revoked.
    const api = publicApi(f, 'reporter', ['children.report', 'workers.get']);
    const forged = await api.request('POST', `/b2/workers/${w.worker_id}/report`, { json: reportBody(w, 'forged-report', 'job') });
    assert.equal(forged.status, 409, JSON.stringify(forged.body));
    assert.deepEqual(forged.body, { error: 'typed_child_reports_through_fd3_only', effect: 'no_effect' });
    store(f).revoke(pg.grant_id);
    const afterRevoke = await api.request('POST', `/b2/workers/${w.worker_id}/report`, { json: reportBody(w, 'forged-after-revoke', 'job') });
    assert.equal(afterRevoke.status, 409);
    assert.equal(f.supervisor.receipts.all.has('forged-report'), false);
    assert.equal(f.supervisor.receipts.all.has('forged-after-revoke'), false);
    assert.equal(f.supervisor.get(w.worker_id).child_reports!.length, 0);
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const recovered = await f.restart();
    assert.ok(recovered.get(p.worker_id).fence?.uncertain_command_ids?.includes(c.command_id), 'only the child FD report discharges the launch fence');
  } finally {
    f.cleanup();
  }
});

test('children: recovery discharges a typed child launch only with a report its FD 3 delivered', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    const r = await f.supervisor.create(c);
    // A delivered report receipt that did not come from the child's FD (written straight into the journal, as an older
    // build or a bypass could have) is not the child's report.
    f.supervisor.receipts.put(
      { command_id: 'not-fd', operation: 'children.report', request_hash: 'x', worker_id: r.worker_id!, state: 'delivered', stage: 'forwarded', effect: 'observed', evidence: 'supervisor_journal_fsynced', created_at: new Date().toISOString(), result: { task_id: 'job', kind: 'result', claim_not_verified: true } },
      'receipt.result',
    );
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const recovered = await f.restart();
    assert.ok(recovered.get(p.worker_id).fence?.uncertain_command_ids?.includes(c.command_id), 'a report without the FD channel does not discharge');
  } finally {
    f.cleanup();
  }
});

test('children: a typed child result report from its FD 3 discharges the launch fence; the receipt names the channel', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    const r = await f.supervisor.create(c);
    f.hosts[1]!.emit('report', { report_id: 'done', kind: 'result', message: 'finished' });
    await tick();
    await tick();
    const receipt = [...f.supervisor.receipts.all.values()].find(x => x.operation === 'children.report' && x.worker_id === r.worker_id)!;
    assert.equal(receipt.state, 'delivered');
    assert.equal(receipt.result?.channel, 'fd3');
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const recovered = await f.restart();
    assert.equal(recovered.get(p.worker_id).fence?.uncertain_command_ids?.includes(c.command_id) ?? false, false);
  } finally {
    f.cleanup();
  }
});

test('children: every report path rechecks the creating grants: an untyped child public report after revocation is refused', async () => {
  const f = fixture();
  try {
    const api = publicApi(f, 'orchestrator', ['workers.create', 'workers.get', 'sessions.prompt', 'children.launch', 'children.report']);
    const cwd = join(f.dir, 'root');
    mkdirSync(cwd);
    const created = await api.request('POST', '/b2/workers', { json: { command_id: 'root', cwd, provider: 'p', model: 'm', thinking: 'off' } });
    const p = f.supervisor.get((created.body as { worker_id: string }).worker_id);
    await api.request('POST', `/b2/workers/${p.worker_id}/prompt`, { json: { ...bind(p, 'run'), message: 'run' } });
    f.hosts[0]!.emit('event', { type: 'agent_settled' });
    const running = f.supervisor.get(p.worker_id);
    const childCwd = join(f.dir, 'untyped');
    mkdirSync(childCwd);
    const launched = await api.request('POST', `/b2/workers/${p.worker_id}/children`, {
      json: { ...bind(running, 'launch'), execution_id: running.execution!.execution_id, launch: { command_id: 'create-untyped', cwd: childCwd, provider: 'p', model: 'm', thinking: 'off' } },
    });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    await tick();
    await tick();
    const w = f.supervisor.list().find(x => x.parent_worker_id === p.worker_id)!;
    assert.equal(w.grant_source_id, 'orchestrator');
    // Another grant may report for the untyped child only while the grants that created it and its parent are active.
    const other = publicApi(f, 'reporter', ['children.report']);
    store(f).revoke('orchestrator');
    const refused = await other.request('POST', `/b2/workers/${w.worker_id}/report`, { json: reportBody(w, 'after-revoke', 'launch') });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: 'grant_revoked', effect: 'no_effect' });
    assert.equal(f.supervisor.receipts.all.has('after-revoke'), false);
    const recovered = await f.restart();
    assert.equal(recovered.get(p.worker_id).fence?.command_id, 'launch', 'the refused report did not discharge the launch fence');
  } finally {
    f.cleanup();
  }
});

test('children: a typed child that dies without a durable report fences its live parent; no replacement launches (invariant 4a, A0 W-4)', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    await f.supervisor.create(c);
    // A help report is not a result: it does not discharge the launch either.
    f.hosts[1]!.emit('report', { report_id: 'stuck', kind: 'help', message: 'blocked' });
    await tick();
    await tick();
    f.hosts[1]!.emit('exit');
    await tick();
    await tick();
    const fenced = f.supervisor.get(p.worker_id);
    assert.deepEqual(fenced.fence?.uncertain_command_ids, [c.command_id], 'the live parent is fenced on the dead child launch');
    // Durable before anything depends on it: the parent row in the journal carries the fence.
    const rows = parseJournal(readFileSync(f.journalFile)).records.filter(r => r.kind === 'worker' && (r.value.worker as Worker).worker_id === p.worker_id);
    assert.deepEqual((rows.at(-1)!.value.worker as Worker).fence?.uncertain_command_ids, [c.command_id]);
    const cwd = join(f.dir, 'replacement');
    mkdirSync(cwd);
    await assert.rejects(() => f.supervisor.create({ ...c, command_id: 'replacement', cwd }), /fenced/);
    assert.equal(f.hosts.length, 2, 'no replacement spawned');
  } finally {
    f.cleanup();
  }
});

test('children: a typed child that reported its result through FD 3 and then exits leaves its parent unfenced', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    await f.supervisor.create(c);
    f.hosts[1]!.emit('report', { report_id: 'done', kind: 'result', message: 'finished' });
    f.hosts[1]!.emit('exit');
    await tick();
    await tick();
    assert.equal(f.supervisor.get(p.worker_id).fence, null);
  } finally {
    f.cleanup();
  }
});

test('children: a faulted typed child (bad report channel) fences its live parent like an exit', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    const r = await f.supervisor.create(c);
    f.supervisor.lifecycle.fault(f.supervisor.state.require(r.worker_id!), new Error('invalid_child_report'));
    await tick();
    await tick();
    assert.deepEqual(f.supervisor.get(p.worker_id).fence?.uncertain_command_ids, [c.command_id]);
  } finally {
    f.cleanup();
  }
});

test('children: a typed child refuses a sandboxed spec until P2 (bwrap and the parent channel)', async () => {
  const f = fixture();
  try {
    const p = await parent(f);
    const c = child(f, p);
    c.launch_spec!.environment.filesystem = 'bwrap';
    await assert.rejects(() => f.supervisor.create(c), /sandboxed_children_not_supported_before_p2/);
    assert.equal(f.hosts.length, 1);
    assert.ok(allowsMethod({ methods: ['*'] }, 'children.report'));
  } finally {
    f.cleanup();
  }
});

test('children: automatic child flush is not owner-ready and recovers without redispatch eligibility', { timeout: 30_000 }, async () => {
  const out = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/queue-cut.js', import.meta.url)), 'child'], { encoding: 'utf8', timeout: 15000 });
  const dir = out.stdout.trim();
  assert.equal(out.signal, 'SIGKILL', out.stderr);
  const state = openState(dir);
  try {
    const pre = parseJournal(readFileSync(state.journal.file)).records;
    const queued = pre.filter(r => r.kind === 'receipt' && r.value.command_id === 'queued').at(-1)!;
    assert.equal(queued.value.state, 'queue_ready', 'automatic flush must never claim owner resolution');
    const s = new Supervisor({ journal: state.journal, receipts: new ReceiptStore(state.journal), supervisorEpoch: state.supervisorEpoch, stateDir: dir, factory: () => assert.fail('no spawn/replay') });
    await s.recover();
    const r = s.receipts.all.get('queued')!;
    assert.equal(r.state, 'intent_recovered');
    assert.equal(r.effect, 'no_effect');
    assert.deepEqual(s.list()[0]!.resolutions ?? [], []);
    assert.equal(s.list()[0]!.fence, null);
    assert.equal(s.receipts.all.get('create-child'), undefined);
    const w = s.list()[0]!;
    const retry = await s.receipts.run(
      'queued',
      r.operation,
      { ...bind(w, 'queued'), worker_id: w.worker_id, execution_id: w.execution!.execution_id, launch: { command_id: 'create-child', cwd: dir, provider: 'p', model: 'm', thinking: 'off' } },
      async () => assert.fail('retry needs owner resolution'),
    );
    assert.deepEqual(retry, r);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
