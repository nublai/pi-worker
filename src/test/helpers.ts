/** THROWAWAY test seam, never model/live-Pi evidence. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { Supervisor } from '../supervisor.js';
import type { SessionHost, PiRecord, PiResponse } from '../host.js';
import type { Worker, Binding } from '../types.js';
export class Host extends EventEmitter implements SessionHost {
  pid = undefined; token = null; prompts = 0; stops = 0; failure = false; serial = 0;
  commands: PiRecord[] = []; before = (_c: PiRecord) => {};
  cancelled: string[] = []; holdUI = false;
  constructor(readonly dir: string, public sid: string, public file: string) { super(); }
  async cancelUI(id: string): Promise<void> { this.cancelled.push(id); if (this.holdUI) await new Promise<void>(() => {}); }
  async request(c: PiRecord): Promise<PiResponse> {
    this.commands.push(c); this.before(c);
    if (c.type === 'new_session' || c.type === 'fork') {
      this.sid = `new-${this.sid}-${++this.serial}`; this.file = join(this.dir, this.sid + '.jsonl');
      writeFileSync(this.file, JSON.stringify({ type: 'session', id: this.sid }) + '\n');
    }
    if (c.type === 'switch_session') { this.file = String(c.sessionPath); this.sid = JSON.parse((await import('node:fs')).readFileSync(this.file, 'utf8').split('\n')[0]!).id as string; }
    if (c.type === 'prompt') {
      this.prompts++;
      this.emit('event', { type: 'agent_start' });
      if (this.failure) throw new Error('lost_prompt_reply');
      return { type: 'response', id: 'x', success: true, data: { disposition: 'started' } };
    }
    if (c.type === 'abort') this.emit('event', { type: 'agent_settled', aborted: true });
    return { type: 'response', id: 'x', success: true, data: { sessionId: this.sid, sessionFile: this.file, cancelled: false } };
  }
  async stop(): Promise<boolean> { this.stops++; this.emit('exit'); return true; }
}
export const bind = (w: Worker, command_id: string): Binding => ({ command_id, session_id: w.session_id!, worker_epoch: w.worker_epoch, binding_revision: w.binding_revision });
export const tick = () => new Promise<void>(r => setImmediate(r));
export function fixture() {
  mkdirSync('/tmp/a0s2', { recursive: true });
  const dir = mkdtempSync('/tmp/a0s2/core-');
  const journal = new Journal(join(dir, 'journal'));
  const hosts: Host[] = [];
  const supervisor = new Supervisor(dir, journal, '1.5.2', () => {
    const sid = `session-${hosts.length}`, file = join(dir, sid + '.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: sid }) + '\n');
    const host = new Host(dir, sid, file); hosts.push(host); return host;
  });
  const create = async () => {
    const cwd = join(dir, 'cwd-' + hosts.length); mkdirSync(cwd);
    const r = await supervisor.create({ command_id: 'create-' + hosts.length, cwd, provider: 'p', model: 'm', thinking: 'off' });
    if (r.state !== 'delivered') throw new Error(JSON.stringify(r));
    return supervisor.get(r.worker_id!);
  };
  return { dir, journal, supervisor, hosts, create, cleanup: () => { journal.close(); rmSync(dir, { recursive: true }); } };
}
