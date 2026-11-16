/**
 * The supervisor facade the B2 handlers call. Each domain lives in its own module over the shared state
 * (state.ts): lifecycle (create, stop, exit, recovery) and input (prompt, steer, follow-up queue, cancel,
 * interrupt). Later PRs add fence and binding modules.
 */
import type { Journal } from '../journal/journal.js';
import type { Receipt, ReceiptStore } from '../receipts/receipts.js';
import { Input } from './input.js';
import { Lifecycle } from './lifecycle.js';
import { SupervisorState, type Binding, type Control, type Create, type FollowUp, type HostFactory, type Prompt, type Steer, type Worker } from './state.js';

export interface SupervisorOptions {
  readonly journal: Journal;
  readonly receipts: ReceiptStore;
  readonly supervisorEpoch: string;
  readonly stateDir: string;
  readonly factory: HostFactory;
}

export class Supervisor {
  readonly state: SupervisorState;
  readonly lifecycle: Lifecycle;
  readonly input: Input;

  constructor(options: SupervisorOptions) {
    this.state = new SupervisorState(options.journal, options.receipts, options.supervisorEpoch, options.stateDir, options.factory);
    this.lifecycle = new Lifecycle(this.state);
    this.input = new Input(this.state, this.lifecycle);
  }

  get receipts(): ReceiptStore {
    return this.state.receipts;
  }

  /** Recovery after a restart, before the socket listens. Never adopts or relaunches a host; never replays. */
  async recover(): Promise<void> {
    this.state.receipts.recover();
    await this.lifecycle.recover();
  }

  /** One worker row, refreshed from its session file. A read failure faults the worker in memory only. */
  get(id: string): Worker {
    const live = this.state.require(id);
    this.lifecycle.guarded(live, () => this.state.refresh(live), true);
    return this.state.view(live);
  }

  list(): Worker[] {
    return [...this.state.workers.keys()].map(id => this.get(id));
  }

  create(c: Create): Promise<Receipt> {
    return this.lifecycle.create(c);
  }

  stop(id: string, b: Binding): Promise<Receipt> {
    return this.lifecycle.stop(id, b);
  }

  prompt(id: string, p: Prompt): Promise<Receipt> {
    return this.input.prompt(id, p);
  }

  steer(id: string, r: Steer): Promise<Receipt> {
    return this.input.steer(id, r);
  }

  followUp(id: string, f: FollowUp): Promise<Receipt> {
    return this.input.followUp(id, f);
  }

  control(id: string, b: Control, interrupt: boolean): Promise<Receipt> {
    return this.input.control(id, b, interrupt);
  }

  shutdown(): Promise<void> {
    return this.lifecycle.shutdown();
  }
}
