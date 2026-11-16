/**
 * The supervisor facade the B2 handlers call. Each domain lives in its own module over the shared state
 * (state.ts): lifecycle (create, stop, exit, recovery). Later PRs add input, fence and binding modules.
 */
import type { Journal } from '../journal/journal.js';
import type { Receipt, ReceiptStore } from '../receipts/receipts.js';
import { Lifecycle } from './lifecycle.js';
import { SupervisorState, type Binding, type Create, type HostFactory, type Worker } from './state.js';

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

  constructor(options: SupervisorOptions) {
    this.state = new SupervisorState(options.journal, options.receipts, options.supervisorEpoch, options.stateDir, options.factory);
    this.lifecycle = new Lifecycle(this.state);
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

  shutdown(): Promise<void> {
    return this.lifecycle.shutdown();
  }
}
