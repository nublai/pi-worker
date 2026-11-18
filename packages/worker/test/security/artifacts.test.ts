/**
 * P3-6: `artifacts.inspect`, owner-Git facts about a worker's checkout at its saved launch pin (nubl
 * `.pi/plan/p3-worker-provider.md` sections 3 and 6, V1 check binding). Real supervisor state, real Git linked
 * worktrees (topology B: a sandboxed parent's root is a linked worktree of the owner repository, its children run in
 * owner-prepared slots of the same repository), the real parent channel sockets and the public TS client over a
 * private B2 socket; the hosts are fixture hosts (no pi, no model). The "child" commits with plain Git in its slot, as
 * the sandboxed child would. Every Git run here has a synthetic environment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { Client, ClientFailure } from '@nublai/pi-worker-client';
import { createApp } from '../../src/b2/app.js';
import { parentChannels } from '../../src/b2/channel.js';
import { createB2Server, listenPrivate } from '../../src/b2/server.js';
import { GrantStore, writeBearerFile } from '../../src/grants/store.js';
import { artifactSubject } from '../../src/owner-git/artifact.js';
import { readGitPin, type GitPin, type OwnerGit } from '../../src/owner-git/git-safe.js';
import { sandboxLaunch } from '../../src/sandbox/sandbox.js';
import { ARTIFACT_INSPECTION_BUDGET_MS, ARTIFACT_INSPECTIONS_PER_CALLER_MAX, type ArtifactFacts } from '../../src/supervisor/artifacts.js';
import type { Create, Worker } from '../../src/supervisor/state.js';
import { ownerGrant, privateTmp, socketCall, wireFixtures, bundledSpec } from '../helpers.js';
import { bind, fixture, Host } from '../supervisor-fixture.js';

type Spec = NonNullable<Create['launch_spec']>;
/** The complete environment of a recorded sandbox launch: synthetic, never process.env. */
const SANDBOX_ENV: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/tmp/piw-home', LANG: 'C' };
/** Fixed identities and dates: the commits, so the wire fixture's object ids, are the same on every run. */
const DATE = '2026-01-01T00:00:00Z';
const gitEnv = (home: string) => ({
  PATH: '/usr/bin:/bin',
  HOME: home,
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'P3 owner',
  GIT_AUTHOR_EMAIL: 'p3@example.invalid',
  GIT_AUTHOR_DATE: DATE,
  GIT_COMMITTER_NAME: 'P3 owner',
  GIT_COMMITTER_EMAIL: 'p3@example.invalid',
  GIT_COMMITTER_DATE: DATE,
});
const OWNER_ENV = { PATH: '/usr/bin:/bin' };
type Facts = ArtifactFacts;
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();

/**
 * A `git` first on owner Git's PATH (owner Git passes on only PATH and the locale, so its settings are in its text).
 * `statusSeconds`: `git status` records its own pid and its sleep's, then sleeps that long before the real Git.
 * `mergeBaseExit`: `git merge-base` exits with that status and prints nothing.
 */
function fakeGit(dir: string, options: { statusSeconds?: number; mergeBaseExit?: number }) {
  mkdirSync(dir);
  const pidFile = join(dir, 'pids');
  const lines = ['#!/bin/sh'];
  if (options.mergeBaseExit !== undefined) lines.push(`for a in "$@"; do [ "$a" = merge-base ] && exit ${options.mergeBaseExit}; done`);
  if (options.statusSeconds !== undefined) lines.push(`for a in "$@"; do if [ "$a" = status ]; then echo $$ >> '${pidFile}'; sleep ${options.statusSeconds} & echo $! >> '${pidFile}'; wait; fi; done`);
  lines.push(`exec '${REAL_GIT}' "$@"`);
  writeFileSync(join(dir, 'git'), `${lines.join('\n')}\n`, { mode: 0o755 });
  const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : []);
  return { env: { PATH: `${dir}:/usr/bin:/bin` }, pids };
}

/** The process is gone (or a zombie: killed, not yet reaped by its new parent). */
function gone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return true;
  }
}

/** Waits until `ready()` holds, checking it first; fails by assertion after `ms`. */
async function until(ready: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ready()) return;
    assert.ok(Date.now() < deadline, `timed out waiting: ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}
type Reply = { status: number; body: Record<string, unknown> };

/**
 * A fixture supervisor that serves parent channels, an owner B2 socket with the TS client on it, and an owner
 * repository `repo` (one commit, `note`; `.piw-*` excluded). `parent(ns)` makes a sandboxed parent whose root is a
 * linked worktree on `refs/heads/<ns>/root`, with a running execution; its `child(name)` makes an owner-prepared slot
 * on `refs/heads/<name>/work` (the owner reads its pin before any agent touches it) and launches it over the parent's
 * channel. Every channel server is closed by `cleanup`, whatever production code did.
 */
async function world() {
  const servers: Server[] = [];
  const f = fixture({
    launch: launch => {
      if (!launch.sandbox) return undefined;
      const opened = f.supervisor.state.workers.get(launch.workerId)?.channel?.server;
      if (opened) servers.push(opened);
      sandboxLaunch(launch.sandbox, '/bin/true', [], { env: SANDBOX_ENV, ...(launch.gitPin !== undefined ? { gitPin: launch.gitPin } : {}), ...(launch.dependencies ? { dependencies: launch.dependencies } : {}), ...(launch.channel ? { channel: launch.channel } : {}) }).close();
      const sid = `sandboxed-${launch.workerId}`;
      const file = join(launch.sessionDir, `${sid}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session', id: sid })}\n`);
      return new Host(launch.sessionDir, sid, file);
    },
  });
  const tmp = privateTmp();
  const grants = new GrantStore(f.dir);
  f.supervisor.serveParentChannels(parentChannels({ supervisor: f.supervisor, grants }));
  const owner = ownerGrant(f.dir);
  const socket = join(f.dir, 'b2.sock');
  const server = createB2Server(createApp({ supervisor: f.supervisor, grants: owner.grants }).handle);
  const cleanup = async () => {
    try {
      await f.supervisor.shutdown();
    } finally {
      for (const s of [...servers, server]) {
        s.closeAllConnections();
        if (s.listening) await new Promise<void>(resolve => s.close(() => resolve()));
      }
      f.cleanup();
      tmp.cleanup();
    }
  };
  try {
    await listenPrivate(server, socket);
    const base = realpathSync(tmp.dir);
    const env = gitEnv(base);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'note'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.piw-agent/\n.piw-worker/\n.piw-slots/\n');
    const baseId = git(repo, 'rev-parse', 'HEAD');
    const client = new Client({ socketPath: socket, grantFile: owner.file });
    const ownerGit: OwnerGit = { stateDir: join(base, 'owner-state'), env: OWNER_ENV };
    mkdirSync(ownerGit.stateDir, { mode: 0o700 });
    const inspect = (worker: string, body: unknown): Promise<Facts> => client.call('artifacts.inspect', { path: { worker_id: worker }, body: body as never }) as Promise<Facts>;
    /** The refusal a call ends with, through the TS client: its code, effect and phase. */
    const refusal = async (pending: Promise<unknown>): Promise<{ error: string; effect: string; phase: string; status?: number; detail?: unknown }> => {
      const got = await pending.then(
        () => assert.fail('the call succeeded'),
        (error: unknown) => error,
      );
      assert.ok(got instanceof ClientFailure, String(got));
      return { error: got.message, effect: got.effect, phase: got.phase, status: got.status, ...(got.details.detail === undefined ? {} : { detail: got.details.detail }) };
    };
    const parent = async (ns: string, create: (c: Create) => Promise<{ state: string; worker_id?: string }> = c => f.supervisor.create(c)) => {
      const root = join(base, ns);
      git(repo, 'worktree', 'add', '-qb', `${ns}/root`, root, 'HEAD');
      mkdirSync(join(root, '.piw-agent'), { recursive: true });
      mkdirSync(join(root, '.piw-slots'));
      const methods = ['workers.create', 'children.report'];
      const spec: Spec = { environment: { id: ns, revision: 1, filesystem: 'bwrap', root, allowed_methods: methods }, role: 'parent', tools: ['read'], denied_tools: [], resources: { extensions: [], skills: [] }, grant_methods: methods, seed_mode: 'standalone' };
      const made = await create({ command_id: `parent-${ns}`, cwd: root, host: 'sdk', provider: 'p', model: 'm', thinking: 'off', launch_spec: spec });
      assert.equal(made.state, 'delivered', JSON.stringify(made));
      const p = f.supervisor.get(made.worker_id!);
      assert.equal((await f.supervisor.prompt(p.worker_id, { ...bind(p, `run-${ns}`), message: 'run' })).state, 'delivered');
      const w = f.supervisor.get(p.worker_id);
      const channel = f.supervisor.state.require(w.worker_id).channel;
      assert.ok(channel, 'a sandboxed parent has a channel');
      const channelSocket = join(channel.dir, 'sock');
      const call = (path: string, body?: unknown) => socketCall(channelSocket, body === undefined ? 'GET' : 'POST', `/b2${path}`, body) as Promise<Reply>;
      const child = async (name: string, options: { plain?: boolean } = {}) => {
        const slot = join(root, '.piw-slots', name);
        if (options.plain) mkdirSync(slot);
        else git(repo, 'worktree', 'add', '-qb', `${name}/work`, slot, 'HEAD');
        // The owner's own pin, read before any agent touches the slot (readGitPin's contract), for an independent check.
        const ownerPin: GitPin | null = options.plain ? null : readGitPin(slot);
        const body: Create = {
          command_id: `child-${name}`,
          cwd: slot,
          host: 'sdk',
          provider: 'p',
          model: 'm',
          thinking: 'off',
          parent: { worker_id: w.worker_id, worker_epoch: w.worker_epoch, session_id: w.session_id!, binding_revision: w.binding_revision, execution_id: w.execution!.execution_id, task_id: `task-${name}`, generation_id: 'gen' },
          launch_spec: { ...spec, role: 'child', grant_methods: ['children.report'], environment: { id: slot, revision: 1, allowed_methods: ['children.report'] } },
        };
        const launched = await call('/workers', body);
        assert.equal(launched.body.state, 'delivered', JSON.stringify(launched.body));
        return { worker: f.supervisor.get(String(launched.body.worker_id)), slot, ownerPin };
      };
      return { w, root, call, child };
    };
    return { f, base, repo, git, baseId, owner, socket, client, ownerGit, inspect, refusal, parent, cleanup };
  } catch (error) {
    // A fixture that fails before its test's try block still closes its sockets (an open one keeps the run alive).
    await cleanup();
    throw error;
  }
}

/** The child's commit: one new file, committed in its slot on its own branch, as the sandboxed child would. */
function commitFeature(x: Awaited<ReturnType<typeof world>>, slot: string): string {
  writeFileSync(join(slot, 'feature.txt'), 'feature\n');
  x.git(slot, 'add', 'feature.txt');
  x.git(slot, 'commit', '-qm', 'feature');
  return x.git(slot, 'rev-parse', 'HEAD');
}

test('V1 readback: the owner reads a child commit, tree, base, HEAD, status and changed paths through the TS client; the facts equal the owner\'s own P2-6 subject', { timeout: 60_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const { worker, slot, ownerPin } = await p.child('ca');
    const head = commitFeature(x, slot);
    const tree = x.git(slot, 'rev-parse', 'HEAD^{tree}');
    const facts = await x.inspect(worker.worker_id, { worker_epoch: worker.worker_epoch, commit: 'refs/heads/ca/work', base: x.baseId });
    assert.deepEqual(facts.commit, { requested: 'refs/heads/ca/work', commit_id: head, tree_id: tree });
    assert.deepEqual(facts.head, { ref: 'refs/heads/ca/work', commit_id: head, matches_commit: true });
    assert.deepEqual(facts.worktree, { state: 'clean', entries: [], truncated: false });
    assert.equal(facts.base?.base_id, x.baseId);
    assert.equal(facts.base?.merge_base_id, x.baseId);
    assert.equal(facts.base?.is_ancestor, true);
    assert.deepEqual(facts.base?.changed, [{ status: 'A', path: 'feature.txt' }]);
    assert.equal(facts.base?.changed_truncated, false);
    assert.equal(facts.pin.kind, 'linked');
    assert.equal(facts.pin.head_ref, 'refs/heads/ca/work');
    assert.match(facts.pin.sha256, /^[0-9a-f]{64}$/);
    assert.equal(facts.provenance.evidence, 'owner_git_launch_pin');
    assert.equal(facts.provenance.replace_objects, 'disabled');
    assert.deepEqual([facts.worker_id, facts.worker_epoch], [worker.worker_id, worker.worker_epoch]);
    // The owner's independent comparison: P2-6's artifactSubject on the owner's own pin, its own snapshot directory.
    const own = artifactSubject(x.ownerGit, slot, head, x.baseId, ownerPin!);
    assert.deepEqual({ commit_id: facts.commit.commit_id, tree_id: facts.commit.tree_id, base_id: facts.base?.base_id, digest: facts.base?.diff_digest.value }, { commit_id: own.commit_id, tree_id: own.tree_id, base_id: own.base_id, digest: own.diff_digest?.value });
    assert.equal(facts.base?.diff_digest.advisory, true);
    // By object id the same facts; the parent reads them over its own channel (its own child), the reply validated.
    const byId = await x.inspect(worker.worker_id, { worker_epoch: worker.worker_epoch, commit: head, base: x.baseId });
    assert.deepEqual({ ...byId.commit, requested: 'id' }, { requested: 'id', commit_id: head, tree_id: tree });
    const channel = await p.call(`/workers/${worker.worker_id}/artifacts/inspect`, { worker_epoch: worker.worker_epoch, commit: head });
    assert.equal(channel.status, 200, JSON.stringify(channel.body));
    assert.deepEqual((channel.body as unknown as Facts).commit, byId.commit);
    assert.equal((channel.body as unknown as Facts).base, undefined, 'no base requested, none reported');
    // A base with no shared history: no merge base, not an ancestor (a fact, never a guess).
    const orphanTree = x.git(slot, 'rev-parse', `${x.baseId}^{tree}`);
    const orphan = x.git(slot, 'commit-tree', orphanTree, '-m', 'orphan');
    const unrelated = await x.inspect(worker.worker_id, { worker_epoch: worker.worker_epoch, commit: head, base: orphan });
    assert.deepEqual([unrelated.base?.base_id, unrelated.base?.merge_base_id, unrelated.base?.is_ancestor], [orphan, null, false]);
    assert.deepEqual(unrelated.base?.changed, [{ status: 'A', path: 'feature.txt' }]);
    // A dirty checkout is reported as such: an untracked file and a modified tracked one.
    writeFileSync(join(slot, 'stray.txt'), 'x\n');
    writeFileSync(join(slot, 'note'), 'changed\n');
    const dirty = await x.inspect(worker.worker_id, { worker_epoch: worker.worker_epoch, commit: head });
    assert.deepEqual(dirty.worktree, { state: 'dirty', entries: [{ code: ' M', path: 'note' }, { code: '??', path: 'stray.txt' }], truncated: false });
    // A conflicted one too: a cherry-pick of a commit that changes `note` differently (its objects in the shared store).
    rmSync(join(slot, 'stray.txt'));
    x.git(slot, 'commit', '-qam', 'ours');
    writeFileSync(join(slot, 'note'), 'theirs\n');
    const blob = x.git(slot, 'hash-object', '-w', 'note');
    x.git(slot, 'checkout', '--', 'note');
    const tree2 = execFileSync('git', ['-C', slot, 'mktree'], { input: `100644 blob ${blob}\tnote\n`, encoding: 'utf8', env: gitEnv(x.base) }).trim();
    const theirs = x.git(slot, 'commit-tree', tree2, '-p', x.baseId, '-m', 'theirs');
    assert.throws(() => x.git(slot, 'cherry-pick', theirs), 'the cherry-pick conflicts');
    const conflicted = await x.inspect(worker.worker_id, { worker_epoch: worker.worker_epoch, commit: 'refs/heads/ca/work' });
    assert.equal(conflicted.worktree.state, 'conflicted', JSON.stringify(conflicted.worktree));
    assert.ok(conflicted.worktree.entries.some(e => e.code === 'UU' && e.path === 'note'));
    assert.equal(conflicted.head.matches_commit, true);
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect: every refusal is typed and no_effect (stale epoch, foreign namespace, missing object, missing tree, pin mismatch, no saved pin, owner Git refusal)', { timeout: 60_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const b = await p.child('cb');
    const head = commitFeature(x, a.slot);
    const at = (w: Worker, body: Record<string, unknown>) => x.refusal(x.inspect(w.worker_id, { worker_epoch: w.worker_epoch, ...body }));
    const typed = (error: string, detail?: string) => ({ error, effect: 'no_effect', phase: 'http', status: 409, ...(detail === undefined ? {} : { detail }) });
    // A stale epoch.
    assert.deepEqual(await x.refusal(x.inspect(a.worker.worker_id, { worker_epoch: 'not-the-epoch', commit: head })), typed('stale_binding'));
    // Refs outside the worker's own namespace: the parent's branch, a sibling's, and the base branch.
    for (const ref of ['refs/heads/pa/root', 'refs/heads/cb/work']) assert.deepEqual(await at(a.worker, { commit: ref }), typed('artifact_ref_outside_namespace'), ref);
    assert.deepEqual(await at(a.worker, { commit: head, base: 'refs/heads/cb/work' }), typed('artifact_ref_outside_namespace'));
    // An object id the store does not hold; a branch of its own namespace that does not exist.
    assert.deepEqual(await at(a.worker, { commit: 'f'.repeat(40) }), typed('artifact_object_missing'));
    assert.deepEqual(await at(a.worker, { commit: head, base: 'e'.repeat(40) }), typed('artifact_object_missing'));
    assert.deepEqual(await at(a.worker, { commit: 'refs/heads/ca/other' }), typed('artifact_object_missing'));
    // A tree object (only) for which the sandbox removed from the shared store: the commit still names it.
    writeFileSync(join(a.slot, 'lone.txt'), 'lone\n');
    const blob = x.git(a.slot, 'hash-object', '-w', 'lone.txt');
    rmSync(join(a.slot, 'lone.txt'));
    const loneTree = execFileSync('git', ['-C', a.slot, 'mktree'], { input: `100644 blob ${blob}\tlone.txt\n`, encoding: 'utf8', env: gitEnv(x.base) }).trim();
    const lone = x.git(a.slot, 'commit-tree', loneTree, '-p', x.baseId, '-m', 'lone');
    rmSync(join(x.repo, '.git', 'objects', loneTree.slice(0, 2), loneTree.slice(2)));
    assert.deepEqual(await at(a.worker, { commit: lone }), typed('artifact_object_missing'), 'a commit whose tree is gone');
    // A commit whose parent the sandbox removed: the merge base cannot be computed, which is never read as unrelated history.
    const baseTree = x.git(a.slot, 'rev-parse', `${x.baseId}^{tree}`);
    const middle = x.git(a.slot, 'commit-tree', baseTree, '-p', x.baseId, '-m', 'middle');
    const tip = x.git(a.slot, 'commit-tree', baseTree, '-p', middle, '-m', 'tip');
    rmSync(join(x.repo, '.git', 'objects', middle.slice(0, 2), middle.slice(2)));
    assert.deepEqual(await at(a.worker, { commit: tip, base: x.baseId }), typed('artifact_inspection_unavailable', 'git_failed'), 'a broken history');
    // A HEAD retargeted after the launch (at the sibling's namespace): the saved pin refuses; a fresh pin never replaces it.
    const adminHead = join(x.repo, '.git', 'worktrees', 'ca', 'HEAD');
    writeFileSync(adminHead, 'ref: refs/heads/cb/work\n');
    assert.deepEqual(await at(a.worker, { commit: head }), typed('artifact_pin_mismatch'));
    writeFileSync(adminHead, 'ref: refs/heads/ca/work\n');
    assert.equal((await x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: head })).commit.commit_id, head, 'non-vacuous: the restored HEAD inspects');
    // A gitfile the parent redirects at another slot's admin dir.
    writeFileSync(join(a.slot, '.git'), `gitdir: ${join(x.repo, '.git', 'worktrees', 'cb')}\n`);
    assert.deepEqual(await at(a.worker, { commit: head }), typed('artifact_pin_mismatch'));
    // A split index owner Git cannot snapshot: unavailable, naming owner Git's code.
    writeFileSync(join(x.repo, '.git', 'worktrees', 'cb', 'sharedindex.0000000000000000000000000000000000000000'), '');
    assert.deepEqual(await at(b.worker, { commit: 'refs/heads/cb/work' }), typed('artifact_inspection_unavailable', 'git_split_index_refused'));
    // No saved launch pin: an unsandboxed worker, and a sandboxed child in a plain-directory slot (no Git metadata).
    const plain = await p.child('cp', { plain: true });
    assert.deepEqual(await at(plain.worker, { commit: head }), typed('artifact_inspection_unavailable', 'no_saved_launch_pin'));
    const unsandboxed = await x.f.create();
    assert.deepEqual(await at(unsandboxed, { commit: head }), typed('artifact_inspection_unavailable', 'no_saved_launch_pin'));
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect: malformed values refuse before owner Git runs (paths, pathspecs, options, abbreviations, flat or tag refs, extra fields), over B2 and in the supervisor itself', { timeout: 60_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const snapshots = () => readdirSync(join(x.f.dir, 'git-snapshots')).length;
    await x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: x.baseId });
    for (const commit of ['HEAD', '--output=/tmp/x', '-n', 'abc123', x.baseId.slice(0, 39), `${x.baseId}^{tree}`, `${x.baseId}:note`, 'refs/heads/flat', 'refs/tags/v1', 'refs/heads/ca/work/../x', '../note', '/etc/passwd', ':(top)note', 'A'.repeat(40)]) {
      const got = await x.refusal(x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit }));
      assert.deepEqual({ ...got, detail: undefined }, { error: 'request_schema_mismatch', effect: 'no_effect', phase: 'http', status: 400, detail: undefined }, `commit #${commit.length}`);
    }
    for (const extra of [{ path: '/etc/passwd' }, { paths: ['note'] }, { argv: ['--version'] }, { pin: {} }]) {
      const got = await x.refusal(x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: x.baseId, ...extra }));
      assert.equal(got.error, 'request_schema_mismatch', Object.keys(extra).join(','));
    }
    // The supervisor checks the values again, so a caller that bypasses the router cannot reach owner Git with one.
    for (const commit of ['--output=/tmp/x', 'HEAD', `${x.baseId}..HEAD`, 'refs/tags/v1']) {
      await assert.rejects(x.f.supervisor.inspectArtifact(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit }), /request_schema_mismatch/, `direct commit #${commit.length}`);
      await assert.rejects(x.f.supervisor.inspectArtifact(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: x.baseId, base: commit }), /request_schema_mismatch/, `direct base #${commit.length}`);
    }
    assert.equal(snapshots(), 0, 'every snapshot removed; none made for a refused value');
  } finally {
    await x.cleanup();
  }
});

test("artifacts.inspect scope: a parent's channel reads only its own children (never itself or another parent's child); a stale epoch refuses; an owner grant without the method, or out of scope, is refused", { timeout: 60_000 }, async () => {
  const x = await world();
  try {
    const pa = await x.parent('pa');
    const a = await pa.child('ca');
    // Parent B is created through B2 by an owner grant that may create workers but not inspect artifacts.
    const limited = new GrantStore(x.f.dir).register({ caller: 'limited-owner', scope: { worker_ids: ['*'], cwd_roots: ['*'] }, methods: ['workers.create', 'workers.get', 'workers.list', 'events.subscribe', 'receipts.get', 'history.page', 'workers.stop', 'sessions.prompt', 'hello', 'children.report'], grant_id: 'limited' });
    const limitedFile = join(x.f.dir, 'limited.grant.json');
    writeBearerFile(limitedFile, limited.token);
    const limitedClient = new Client({ socketPath: x.socket, grantFile: limitedFile });
    const pb = await x.parent('pb', c => limitedClient.call('workers.create', { body: c }) as Promise<{ state: string; worker_id?: string }>);
    const b = await pb.child('cb');
    const body = (w: Worker) => ({ worker_epoch: w.worker_epoch, commit: x.baseId });
    const inspectOn = (p: typeof pa, w: Worker, req: unknown = body(w)) => p.call(`/workers/${w.worker_id}/artifacts/inspect`, req);
    // Its own child: facts.
    const own = await inspectOn(pa, a.worker);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    // Another parent's child, and a worker outside the channel entirely: invisible.
    const unrelated = await x.f.create();
    for (const w of [b.worker, unrelated]) assert.deepEqual(await inspectOn(pa, w), { status: 409, body: { error: 'grant_scope_denied', effect: 'no_effect' } }, w.worker_id);
    // The parent itself: not its own child.
    const self = f(pa.w);
    assert.deepEqual(await inspectOn(pa, self), { status: 409, body: { error: 'parent_channel_requires_own_child', effect: 'no_effect' } });
    // A stale epoch over the channel.
    assert.deepEqual(await inspectOn(pa, a.worker, { worker_epoch: 'stale', commit: x.baseId }), { status: 409, body: { error: 'stale_binding', effect: 'no_effect' } });
    // Parent B's channel grant is within its creating grant's methods: no artifacts.inspect, even for its own child.
    assert.deepEqual(await inspectOn(pb, b.worker), { status: 409, body: { error: 'grant_method_denied', effect: 'no_effect' } });
    // The owner without the method; an owner grant scoped to another worker.
    assert.deepEqual(await x.refusal(limitedClient.call('artifacts.inspect', { path: { worker_id: a.worker.worker_id }, body: body(a.worker) })), { error: 'grant_method_denied', effect: 'no_effect', phase: 'http', status: 409 });
    const scoped = new GrantStore(x.f.dir).register({ caller: 'scoped-owner', scope: { worker_ids: [unrelated.worker_id], cwd_roots: [] }, methods: ['*'], grant_id: 'scoped' });
    const scopedFile = join(x.f.dir, 'scoped.grant.json');
    writeBearerFile(scopedFile, scoped.token);
    const scopedClient = new Client({ socketPath: x.socket, grantFile: scopedFile });
    assert.deepEqual(await x.refusal(scopedClient.call('artifacts.inspect', { path: { worker_id: a.worker.worker_id }, body: body(a.worker) })), { error: 'grant_scope_denied', effect: 'no_effect', phase: 'http', status: 409 });
    // The full owner sees every worker: B's child included.
    assert.equal((await x.inspect(b.worker.worker_id, body(b.worker))).commit.commit_id, x.baseId);
  } finally {
    await x.cleanup();
  }

  function f(w: Worker): Worker {
    return x.f.supervisor.get(w.worker_id);
  }
});

test('artifacts.inspect: listed entries stop at 10,000 or 1 MiB of paths and say so (the reply stays within its schema and the client limit)', { timeout: 120_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const req = { worker_epoch: a.worker.worker_epoch, commit: x.baseId };
    for (let i = 0; i < 10_050; i++) writeFileSync(join(a.slot, `f${i}`), '');
    const many = await x.inspect(a.worker.worker_id, req);
    assert.deepEqual([many.worktree.state, many.worktree.entries.length, many.worktree.truncated], ['dirty', 10_000, true]);
    for (let i = 0; i < 10_050; i++) rmSync(join(a.slot, `f${i}`));
    // 4,300 untracked names of 250 bytes: past 1 MiB of paths well before 10,000 entries.
    for (let i = 0; i < 4_300; i++) writeFileSync(join(a.slot, `${String(i).padStart(5, '0')}${'n'.repeat(245)}`), '');
    const long = await x.inspect(a.worker.worker_id, req);
    const bytes = long.worktree.entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.path)), 0);
    assert.equal(long.worktree.truncated, true);
    assert.ok(long.worktree.entries.length < 4_300 && long.worktree.entries.length > 4_000, `entries ${long.worktree.entries.length}`);
    assert.ok(bytes <= 1024 * 1024, `path bytes ${bytes}`);
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect: the launch pin is memory only; after a supervisor restart the inspection is unavailable, never a pin read again', { timeout: 60_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const head = commitFeature(x, a.slot);
    assert.equal((await x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: head })).commit.commit_id, head);
    const s = await x.f.restart();
    const w = s.state.require(a.worker.worker_id).worker;
    assert.equal(w.worker_epoch, a.worker.worker_epoch, 'the row keeps its epoch');
    await assert.rejects(s.inspectArtifact(w.worker_id, { worker_epoch: w.worker_epoch, commit: head }), (e: unknown) => e instanceof Error && e.message === 'artifact_inspection_unavailable' && (e as { details?: { detail?: string } }).details?.detail === 'no_saved_launch_pin');
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect answers each of its wire fixtures from a real checkout, and every reachable documented refusal has one', { timeout: 60_000 }, async () => {
  const fixtures = wireFixtures().filter(f => f.operationId === 'artifacts.inspect');
  // SAFETY: the bundled spec carries each operation's description; the helper's type names only what it needs.
  const op = (bundledSpec().paths['/b2/workers/{worker_id}/artifacts/inspect'] as unknown as { post: { description: string } }).post;
  const documented = [...op.description.slice(op.description.indexOf('Refusals')).matchAll(/`([a-z0-9_]+)`/g)].map(m => m[1]!).filter(n => !['no_effect', 'worker_epoch', 'detail'].includes(n));
  const covered = new Set(fixtures.map(f => (f.fixture.response.body as { error?: string }).error));
  assert.ok(documented.length >= 6, `documented refusals parsed: ${documented}`);
  assert.deepEqual(documented.filter(n => !covered.has(n)), [], 'every documented refusal has a wire fixture');
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const head = commitFeature(x, a.slot);
    const unsandboxed = await x.f.create();
    const ids: Record<string, string> = { 'worker-child': a.worker.worker_id, 'epoch-child': a.worker.worker_epoch, 'worker-unsandboxed': unsandboxed.worker_id, 'epoch-unsandboxed': unsandboxed.worker_epoch, 'worker-parent': p.w.worker_id, 'epoch-parent': p.w.worker_epoch };
    const map = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/"(worker|epoch)-(child|unsandboxed|parent)"/g, m => JSON.stringify(ids[m.slice(1, -1)])));
    /** What differs per host and run: the Git version, the pin (its paths are this run's) and the time. */
    const normalize = (body: Record<string, unknown>): unknown => {
      const facts = structuredClone(body) as unknown as Facts;
      if (facts.provenance) facts.provenance = { ...facts.provenance, git_version: 'git version X', inspected_at: 'T' };
      if (facts.pin) facts.pin = { ...facts.pin, sha256: '0'.repeat(64) };
      if (facts.base) facts.base = { ...facts.base, diff_digest: { ...facts.base.diff_digest, git_version: 'git version X' } };
      return facts;
    };
    assert.match(head, /^[0-9a-f]{40}$/);
    // The pin-mismatch fixture's checkout: the child's HEAD retargeted after its launch, restored after the call.
    const adminHead = join(x.repo, '.git', 'worktrees', 'ca', 'HEAD');
    // The timeout and busy fixtures' supervisor: a git status that sleeps, and a short budget or one inspection per grant.
    const inspections = x.f.supervisor.artifacts;
    const ownEnv = inspections.env;
    const slow = fakeGit(join(x.base, 'slow-git'), { statusSeconds: 30 });
    let background: Promise<unknown> = Promise.resolve();
    const around: Record<string, [() => void | Promise<void>, () => void | Promise<void>]> = {
      'pin-mismatch.json': [() => writeFileSync(adminHead, 'ref: refs/heads/pa/root\n'), () => writeFileSync(adminHead, 'ref: refs/heads/ca/work\n')],
      'inspection-timeout.json': [
        () => {
          inspections.env = slow.env;
          inspections.budgetMs = 1_500;
        },
        () => {
          inspections.env = ownEnv;
          inspections.budgetMs = ARTIFACT_INSPECTION_BUDGET_MS;
        },
      ],
      'inspections-busy.json': [
        async () => {
          inspections.env = slow.env;
          inspections.maxPerCaller = 1;
          const before = slow.pids().length;
          // The owner's own inspection holds its one slot (the fixture's call is the same owner grant).
          background = x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: head }).catch((error: unknown) => error);
          await until(() => slow.pids().length >= before + 2, 6_000, 'the background inspection is in git status');
        },
        async () => {
          await inspections.close();
          assert.match(String(await background), /artifact_inspection_unavailable/, 'the background inspection ends at close');
          inspections.env = ownEnv;
          inspections.maxPerCaller = ARTIFACT_INSPECTIONS_PER_CALLER_MAX;
        },
      ],
    };
    assert.deepEqual(fixtures.map(f => f.name).sort(), ['inspection-timeout.json', 'inspections-busy.json', 'not-own-child.json', 'object-missing.json', 'ok.json', 'pin-mismatch.json', 'ref-outside-namespace.json', 'stale-epoch.json', 'unavailable.json']);
    for (const { name, fixture: fx } of fixtures) {
      const request = map(fx.request) as { path: { worker_id: string }; body: unknown };
      await around[name]?.[0]();
      // The parent's own worker is inspected over its channel (`parent_channel_requires_own_child`); the rest as the owner.
      const got = name === 'not-own-child.json' ? await p.call(`/workers/${request.path.worker_id}/artifacts/inspect`, request.body) : ((await socketCall(x.socket, 'POST', `/b2/workers/${request.path.worker_id}/artifacts/inspect`, request.body, x.owner.headers)) as Reply);
      await around[name]?.[1]();
      assert.deepEqual({ status: got.status, body: normalize(got.body) }, { status: fx.response.status, body: normalize(map(fx.response.body) as Record<string, unknown>) }, name);
    }
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect runs owner Git off the event loop: a slow Git delays neither hello nor a concurrent stop; past its budget it refuses artifact_inspection_timeout (no_effect), its Git process group killed and its snapshots removed', { timeout: 120_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const other = await x.f.create();
    const fake = fakeGit(join(x.base, 'slow-git'), { statusSeconds: 30 });
    x.f.supervisor.artifacts.env = fake.env;
    x.f.supervisor.artifacts.budgetMs = 8_000;
    const started = Date.now();
    let settledAt = 0;
    const pending = x.refusal(x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: x.baseId })).finally(() => (settledAt = Date.now()));
    await until(() => fake.pids().length >= 2, 6_000, 'the slow git status started');
    let t = Date.now();
    assert.equal(((await x.client.call('hello', {})) as { supervisor_id: string }).supervisor_id.length > 0, true);
    const helloMs = Date.now() - t;
    t = Date.now();
    const stopped = (await x.client.call('workers.stop', { path: { worker_id: other.worker_id }, body: bind(other, 'stop-other') })) as { state: string };
    const stopMs = Date.now() - t;
    assert.equal(stopped.state, 'delivered');
    assert.equal(settledAt, 0, 'the inspection is still in Git while hello and stop are answered');
    assert.ok(helloMs < 1_000 && stopMs < 2_000, `hello ${helloMs} ms, stop ${stopMs} ms`);
    assert.ok(Date.now() - started < 6_000, `answered ${Date.now() - started} ms after the inspection started (Git sleeps 30 s)`);
    assert.deepEqual(await pending, { error: 'artifact_inspection_timeout', effect: 'no_effect', phase: 'http', status: 409 });
    assert.ok(settledAt - started >= 8_000 && settledAt - started < 20_000, `refused after ${settledAt - started} ms (budget 8 s)`);
    // The whole group: the fake's shell and its sleep, not only the child process.
    const pids = fake.pids();
    assert.equal(pids.length, 2);
    await until(() => pids.every(gone), 5_000, 'every process of the timed-out inspection is gone');
    assert.deepEqual(readdirSync(join(x.f.dir, 'git-snapshots')), [], 'its private snapshot directory is removed');
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect: running inspections are capped per grant and supervisor-wide; past a cap the call refuses artifact_inspections_busy (no_effect) at once; an ended inspection frees its slot', { timeout: 120_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const fake = fakeGit(join(x.base, 'slow-git'), { statusSeconds: 30 });
    const inspections = x.f.supervisor.artifacts;
    inspections.env = fake.env;
    inspections.budgetMs = 6_000;
    inspections.maxInFlight = 2;
    inspections.maxPerCaller = 1;
    const req = { worker_epoch: a.worker.worker_epoch, commit: x.baseId };
    const first = x.refusal(x.inspect(a.worker.worker_id, req));
    await until(() => fake.pids().length >= 2, 6_000, 'the first inspection is in git status');
    // The same grant again: refused at once, nothing started.
    let t = Date.now();
    assert.deepEqual(await x.refusal(x.inspect(a.worker.worker_id, req)), { error: 'artifact_inspections_busy', effect: 'no_effect', phase: 'http', status: 409, detail: 'per_caller_limit' });
    assert.ok(Date.now() - t < 1_000, 'refused at once');
    assert.equal(fake.pids().length, 2, 'the refused call started no Git');
    // Another grant (the parent's channel) takes the second slot.
    const second = p.call(`/workers/${a.worker.worker_id}/artifacts/inspect`, req);
    await until(() => fake.pids().length >= 4, 6_000, 'the second inspection is in git status');
    // A third grant: the supervisor-wide cap.
    const third = new GrantStore(x.f.dir).register({ caller: 'third', scope: { worker_ids: [a.worker.worker_id], cwd_roots: [] }, methods: ['artifacts.inspect'], grant_id: 'third' });
    const thirdFile = join(x.f.dir, 'third.grant.json');
    writeBearerFile(thirdFile, third.token);
    const thirdClient = new Client({ socketPath: x.socket, grantFile: thirdFile });
    t = Date.now();
    assert.deepEqual(await x.refusal(thirdClient.call('artifacts.inspect', { path: { worker_id: a.worker.worker_id }, body: req })), { error: 'artifact_inspections_busy', effect: 'no_effect', phase: 'http', status: 409, detail: 'supervisor_limit' });
    assert.ok(Date.now() - t < 1_000, 'refused at once');
    assert.equal(fake.pids().length, 4, 'the refused call started no Git');
    assert.deepEqual(await first, { error: 'artifact_inspection_timeout', effect: 'no_effect', phase: 'http', status: 409 });
    assert.deepEqual(await second, { status: 409, body: { error: 'artifact_inspection_timeout', effect: 'no_effect' } });
    // Both slots are free again: with the real Git the same grants inspect.
    inspections.env = OWNER_ENV;
    assert.equal((await x.inspect(a.worker.worker_id, req)).commit.commit_id, x.baseId);
    assert.equal(((await thirdClient.call('artifacts.inspect', { path: { worker_id: a.worker.worker_id }, body: req })) as Facts).commit.commit_id, x.baseId);
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect: only Git\'s silent exit 1 is no common ancestor; a merge-base that fails silently otherwise refuses, never reported as unrelated history', { timeout: 60_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const head = commitFeature(x, a.slot);
    const req = { worker_epoch: a.worker.worker_epoch, commit: head, base: x.baseId };
    x.f.supervisor.artifacts.env = fakeGit(join(x.base, 'exit-2'), { mergeBaseExit: 2 }).env;
    assert.deepEqual(await x.refusal(x.inspect(a.worker.worker_id, req)), { error: 'artifact_inspection_unavailable', effect: 'no_effect', phase: 'http', status: 409, detail: 'git_failed' });
    // Non-vacuous: the same silent failure with Git's no-common-ancestor exit is reported as no merge base.
    x.f.supervisor.artifacts.env = fakeGit(join(x.base, 'exit-1'), { mergeBaseExit: 1 }).env;
    const unrelated = await x.inspect(a.worker.worker_id, req);
    assert.deepEqual([unrelated.base?.merge_base_id, unrelated.base?.is_ancestor], [null, false]);
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect: the worktree state is judged on the complete status, so a conflict past the listed cap is still conflicted', { timeout: 120_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    // 10,001 staged additions that sort before an unmerged entry (stages 2 and 3, as a merge leaves them).
    for (let i = 0; i <= 10_000; i++) writeFileSync(join(a.slot, `a${String(i).padStart(5, '0')}`), '');
    x.git(a.slot, 'add', '.');
    writeFileSync(join(a.slot, 'zconflict'), 'ours\n');
    const ours = x.git(a.slot, 'hash-object', '-w', 'zconflict');
    writeFileSync(join(a.slot, 'zconflict'), 'theirs\n');
    const theirs = x.git(a.slot, 'hash-object', '-w', 'zconflict');
    execFileSync('git', ['-C', a.slot, 'update-index', '--index-info'], { input: `100644 ${ours} 2\tzconflict\n100644 ${theirs} 3\tzconflict\n`, env: gitEnv(x.base) });
    assert.match(x.git(a.slot, 'status', '--porcelain', '--', 'zconflict'), /^AA zconflict$/, 'fixture: Git reports the conflict');
    const facts = await x.inspect(a.worker.worker_id, { worker_epoch: a.worker.worker_epoch, commit: x.baseId });
    assert.deepEqual([facts.worktree.entries.length, facts.worktree.truncated], [10_000, true]);
    assert.ok(!facts.worktree.entries.some(e => e.path === 'zconflict'), 'non-vacuous: the conflict is past the cut');
    assert.equal(facts.worktree.state, 'conflicted');
  } finally {
    await x.cleanup();
  }
});

test('artifacts.inspect: a tracked change the child hides with assume-unchanged or skip-worktree is never reported clean (a typed refusal); without the flag it is dirty', { timeout: 60_000 }, async () => {
  const x = await world();
  try {
    const p = await x.parent('pa');
    const a = await p.child('ca');
    const req = { worker_epoch: a.worker.worker_epoch, commit: x.baseId };
    assert.deepEqual((await x.inspect(a.worker.worker_id, req)).worktree, { state: 'clean', entries: [], truncated: false }, 'control: clean');
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      x.git(a.slot, 'update-index', `--${flag}`, 'note');
      writeFileSync(join(a.slot, 'note'), 'hidden\n');
      assert.equal(x.git(a.slot, 'status', '--porcelain'), '', `fixture: plain Git reports clean with ${flag}`);
      assert.deepEqual(await x.refusal(x.inspect(a.worker.worker_id, req)), { error: 'artifact_inspection_unavailable', effect: 'no_effect', phase: 'http', status: 409, detail: 'git_index_hides_changes' }, flag);
      x.git(a.slot, 'update-index', `--no-${flag}`, 'note');
      assert.deepEqual((await x.inspect(a.worker.worker_id, req)).worktree, { state: 'dirty', entries: [{ code: ' M', path: 'note' }], truncated: false }, `${flag} cleared: the change is seen`);
      x.git(a.slot, 'checkout', '--', 'note');
    }
  } finally {
    await x.cleanup();
  }
});
