// p1-chat, the CLI side: every step is one `pi-worker` CLI command against the running P1 daemon (journey.sh starts
// it). Grant, hello, create with the faux provider, prompt, history, a dialog answered over B2, an image staged and
// sent, an extension command, interrupt (with a queued follow-up), new and resume, typed refusals, stop, revoke, and
// the next call refused. Writes <run>/chat.json: checks and per-step exit codes, typed error names and receipt states
// only (no message text, answers, history or bearer).
//   node chat.mjs <cli.js> <work-dir> <scratch-dir> <out.json>    (env: PIW_SOCKET, PIW_STATE_DIR, PIW_GRANT_FILE)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const [cli, work, scratch, outFile] = process.argv.slice(2);
const steps = [];
const checks = {};
const facts = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One CLI command. Records the step without stdout (it may carry text); returns the parsed output and error. */
function pw(label, args, { timeout = 60_000, env = process.env } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout, env });
  const lines = (r.stdout ?? '').split('\n').filter(Boolean);
  const parse = s => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const out = lines.length === 1 ? parse(lines[0]) : undefined;
  const error = r.stderr?.trim() ? parse(r.stderr.trim().split('\n')[0]) : undefined;
  steps.push({
    step: label,
    command: args[0] === 'grant' ? `grant ${args[1]}` : args[0],
    exit: r.status,
    ms: Date.now() - t0,
    ...(out && typeof out === 'object' && 'state' in out ? { state: out.state } : {}),
    ...(error ? { error: error.error, effect: error.effect, ...(error.status ? { status: error.status } : {}) } : {}),
  });
  return { code: r.status, out, error, frames: lines.map(parse) };
}
const check = (name, ok) => (checks[name] = ok === true);
async function until(read, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(250);
  }
}
const settled = (label, worker, execution) => pw(label, ['events.subscribe', '--worker', worker, '--type', 'execution.settled', '--until-settled', '--execution-id', execution], { timeout: 45_000 });
const text = entry => (Array.isArray(entry?.message?.content) ? entry.message.content.filter(c => c.type === 'text').map(c => c.text).join('') : '');

/** A small valid PNG (RGB gradient), so the worker's magic and hash checks see a real image. */
function png(seed) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = b => {
    let x = 0xffffffff;
    for (const v of b) x = table[(x ^ v) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const w = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw.set([x * 8, y * 8, seed], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sha = b => createHash('sha256').update(b).digest('hex');
const sleepRunning = () => spawnSync('pgrep', ['-f', '^sleep 60$']).status === 0;

// 1. No grant, no B2; register one by local file access, then hello.
const grantFile = process.env.PIW_GRANT_FILE;
const anonymous = pw('hello without a grant', ['hello'], { env: { ...process.env, PIW_GRANT_FILE: '' } });
check('no_grant_refused', anonymous.code === 1 && anonymous.error?.error === 'bearer_grant_required' && anonymous.error?.effect === 'no_effect');
const reg = pw('grant register', ['grant', 'register', '--caller', 'p1-chat', '--out', grantFile, '--worker', '*', '--cwd-root', '*', '--answers-for-person']);
check('grant_registered', reg.code === 0 && typeof reg.out?.grant_id === 'string' && existsSync(grantFile));
const grantId = reg.out?.grant_id;
const hello = pw('hello', ['hello']);
check('hello', hello.code === 0 && hello.out?.protocol?.major === 0);
facts.pi_version = hello.out?.pi_version ?? null;
check('help', spawnSync(process.execPath, [cli, 'sessions.prompt', '--help'], { encoding: 'utf8' }).stdout.startsWith('usage: pi-worker sessions.prompt WORKER --message VALUE'));

// 2. Inventory before any worker, then create one with the faux provider.
const models = pw('models.list for the cwd', ['models.list', '--cwd', work]);
check('models_list_cwd', models.code === 0 && models.out?.models?.some(m => m.provider === 'faux' && m.id === 'faux-1'));
const commands = pw('commands.list for the cwd', ['commands.list', '--cwd', work]);
check('commands_list_cwd', commands.code === 0 && commands.out?.commands?.some(c => c.name === 'p1-chat-mark'));
const created = pw('workers.create', ['workers.create', '--cwd', work, '--provider', 'faux', '--model', 'faux-1', '--thinking', 'off']);
const W = created.out?.worker_id;
check('workers_create', created.code === 0 && created.out?.state === 'delivered' && typeof W === 'string');
check('workers_list', pw('workers.list', ['workers.list']).out?.some(w => w.worker_id === W) === true);
const row = () => pw('workers.get', ['workers.get', W]).out;
const first = row();
check('workers_get_ready', first?.status === 'ready');
const S1 = first?.session_id;
check('models_list_worker', pw('models.list for the worker', ['models.list', '--worker', W]).out?.current?.provider === 'faux');

// 3. Prompt, wait for settlement on the event stream, read the receipt and the history.
const p1 = pw('sessions.prompt', ['sessions.prompt', W, '--message', 'hello from p1-chat']);
check('prompt_delivered', p1.code === 0 && p1.out?.state === 'delivered' && typeof p1.out?.execution_id === 'string');
const s1 = settled('events.subscribe until settled', W, p1.out?.execution_id);
check('prompt_settled_event', s1.code === 0 && s1.frames.some(f => f?.type === 'execution.settled' || f?.type === 'snapshot'));
check('receipts_get', pw('receipts.get', ['receipts.get', p1.out?.command_id]).out?.state === 'delivered');
const page = pw('history.page', ['history.page', W]);
const reply = page.out?.entries?.find(e => e.message?.role === 'assistant' && text(e) === 'scripted reply');
check('history_has_reply', page.code === 0 && reply !== undefined);
check('items_read', reply !== undefined && pw('items.read', ['items.read', W, reply.id]).out?.entry?.id === reply.id);

// 4. A dialog: the faux model calls `write`, the extension asks to confirm; answer it over B2 and the tool runs.
const p2 = pw('sessions.prompt (dialog)', ['sessions.prompt', W, '--message', 'p1-chat:write']);
const card = await until(() => pw('interactions.list', ['interactions.list', W]).out?.find(i => i.kind === 'confirm' && i.status === 'pending'));
check('dialog_pending', card !== undefined && !existsSync(join(work, 'dialog.txt')));
check('interactions_status_pending', card !== undefined && pw('interactions.status', ['interactions.status', W, '--interaction-id', card.interaction_id]).out?.status === 'pending');
const answered = card && pw('interactions.answer_if_current', ['interactions.answer_if_current', W, '--interaction-id', card.interaction_id, '--revision', String(card.revision), '--kind', 'confirm', '--outcome', 'answer', '--confirm', 'yes']);
check('dialog_answered', answered?.code === 0 && answered.out?.state === 'delivered' && answered.out?.answer_stage === 3);
check('dialog_settled', settled('events.subscribe until settled (dialog)', W, p2.out?.execution_id).code === 0);
check('dialog_tool_ran', existsSync(join(work, 'dialog.txt')));
check('interaction_closed', card !== undefined && pw('interactions.status (after)', ['interactions.status', W, '--interaction-id', card.interaction_id]).out?.status !== 'pending');

// 5. An image: stage a PNG, read its status, send it with a prompt, find it in the session file, read it back.
const image = png(128);
const imageFile = join(scratch, 'photo.png');
writeFileSync(imageFile, image);
const staged = pw('attachments.stage', ['attachments.stage', W, imageFile]);
const A = staged.out?.result?.attachment_id;
check('attachment_staged', staged.code === 0 && staged.out?.result?.state === 'staged' && staged.out?.result?.bytes === image.length);
const status = pw('attachments.status', ['attachments.status', A]).out;
check('attachment_status', status?.state === 'staged' && status?.sha256 === sha(image) && status?.content_type === 'image/png');
const p3 = pw('sessions.prompt (image)', ['sessions.prompt', W, '--message', 'what is in this picture?', '--attachment', A]);
check('image_prompt_accepted', p3.code === 0 && p3.out?.result?.accepted_images === 1);
check('image_settled', settled('events.subscribe until settled (image)', W, p3.out?.execution_id).code === 0);
check('attachment_released_by_prompt', pw('attachments.status (after)', ['attachments.status', A]).out?.state === 'released');
const lines = pw('sessions.history', ['sessions.history', S1]).out;
const withImage = lines?.lines?.find(l => l?.message?.role === 'user' && Array.isArray(l.message.content) && l.message.content.some(c => c.type === 'image'));
check('image_in_session_file', withImage !== undefined && lines?.headers?.['piw-session-id'] === S1);
check('model_saw_image', lines?.lines?.some(l => l?.message?.role === 'assistant' && text(l) === 'saw 1 image(s)') === true);
const blobFile = join(scratch, 'blob.png');
const blob = withImage && pw('blobs.read', ['blobs.read', S1, withImage.id, '0', '--out', blobFile]);
check('blobs_read_same_bytes', blob?.code === 0 && existsSync(blobFile) && sha(readFileSync(blobFile)) === sha(image));
const spareFile = join(scratch, 'spare.png');
writeFileSync(spareFile, png(7));
const spare = pw('attachments.stage (spare)', ['attachments.stage', W, spareFile]).out?.result?.attachment_id;
check('attachments_release', pw('attachments.release', ['attachments.release', spare]).out?.state === 'delivered' && pw('attachments.status (spare)', ['attachments.status', spare]).out?.state === 'released');

// 6. Session features: catalog, configure, reload, an extension command, compaction (a typed outcome either way).
check('sessions_list', pw('sessions.list', ['sessions.list']).out?.sessions?.some(s => s.session_id === S1) === true);
check('sessions_get', pw('sessions.get', ['sessions.get', S1]).out?.session_id === S1);
check('session_configure', pw('session.configure', ['session.configure', W, '--name', 'p1-chat']).out?.state === 'delivered');
check('resources_reload', pw('resources.reload', ['resources.reload', W]).out?.state === 'delivered');
check('commands_list_worker', pw('commands.list for the worker', ['commands.list', '--worker', W]).out?.commands?.some(c => c.name === 'p1-chat-mark') === true);
const invoked = pw('commands.invoke', ['commands.invoke', W, '--name', 'p1-chat-mark', '--args', 'marked']);
check('commands_invoke', invoked.out?.state === 'delivered' && existsSync(join(work, 'p1-chat-mark.txt')));
const compacted = pw('sessions.compact', ['sessions.compact', W]);
check('sessions_compact_typed', compacted.code === 0 || (compacted.code === 1 && typeof compacted.error?.error === 'string'));
facts.compact = compacted.code === 0 ? 'delivered' : compacted.error?.error;

// 7. Interrupt: the faux model runs `sleep 60`; a follow-up queues behind it; interrupt ends both well before 60 s.
const p4 = pw('sessions.prompt (sleep)', ['sessions.prompt', W, '--message', 'p1-chat:sleep']);
const E = p4.out?.execution_id;
check('sleep_running', (await until(sleepRunning, 20_000)) === true);
const follow = pw('sessions.follow_up', ['sessions.follow_up', W, '--execution-id', E, '--message', 'after the sleep']);
check('follow_up_queued', follow.out?.state === 'queued');
const t0 = Date.now();
const interrupted = pw('executions.interrupt', ['executions.interrupt', W, '--execution-id', E]);
check('interrupt_delivered', interrupted.code === 0 && interrupted.out?.state === 'delivered');
check('interrupt_settled', settled('events.subscribe until settled (interrupt)', W, E).code === 0);
facts.interrupt_to_settled_ms = Date.now() - t0;
check('interrupt_fast', facts.interrupt_to_settled_ms < 30_000);
check('sleep_stopped', (await until(() => !sleepRunning(), 10_000)) === true);
const after = row();
check('follow_up_dropped', after?.queued?.some(q => q.command_id === follow.out?.command_id && q.state === 'dropped') === true);
check('idle_after_interrupt', after?.foreground === 'idle' && after?.fence === null);
check('executions_cancel', pw('executions.cancel', ['executions.cancel', W]).out?.state === 'delivered');

// 8. Binding moves: a new session, then resume the first; the old binding is refused afterwards.
const before = row();
const fresh = pw('sessions.new', ['sessions.new', W]);
check('sessions_new', fresh.out?.state === 'delivered' && fresh.out?.result?.session_id !== S1);
const resumed = pw('sessions.rebind', ['sessions.rebind', W, '--action', 'resume', '--target-session-id', S1]);
check('sessions_rebind_resume', resumed.out?.state === 'delivered' && resumed.out?.result?.session_id === S1);
const stale = pw('sessions.prompt (stale binding)', ['sessions.prompt', W, '--message', 'stale', '--worker-epoch', before.worker_epoch, '--session-id', before.session_id, '--binding-revision', String(before.binding_revision)]);
check('stale_binding_refused', stale.code === 1 && stale.error?.effect === 'no_effect' && typeof stale.error?.error === 'string');

// 9. Typed refusals: nothing to resolve; operations this P1 worker does not serve yet.
const resolve = pw('sessions.resolve_unknown', ['sessions.resolve_unknown', W, '--disposition', 'keep', '--fence-generation', '0', '--uncertain-command-id', 'none']);
check('resolve_unknown_typed', resolve.code === 1 && resolve.error?.error === 'uncertainty_not_current');
const files = pw('files.read', ['files.read', W, '--path', join(work, 'dialog.txt'), '--root', work]);
check('files_read_typed', files.code === 1 && files.error?.status === 501 && files.error?.effect === 'no_effect');
const relaunch = pw('workers.relaunch', ['workers.relaunch', W]);
check('relaunch_typed', relaunch.code === 1 && relaunch.error?.status === 501 && relaunch.error?.effect === 'no_effect');

// 10. Stop, then revoke the grant: the next call is refused.
const stopped = pw('workers.stop', ['workers.stop', W]);
check('workers_stop', stopped.out?.state === 'delivered' && stopped.out?.stage === 'termination_observed');
check('worker_stopped', row()?.status === 'stopped');
check('grant_revoke', pw('grant revoke', ['grant', 'revoke', grantId]).out?.revoked === true);
const refused = pw('hello after revoke', ['hello']);
check('revoked_refused', refused.code === 1 && refused.error?.error === 'grant_revoked' && refused.error?.effect === 'no_effect');
check('grant_list_revoked', pw('grant list', ['grant', 'list']).out?.find(g => g.grant_id === grantId)?.revoked === true);

const pass = Object.values(checks).every(Boolean);
writeFileSync(outFile, `${JSON.stringify({ pass, checks, facts, steps }, null, 2)}\n`);
console.log(JSON.stringify({ pass, failed: Object.keys(checks).filter(k => !checks[k]) }));
process.exit(pass ? 0 : 1);
