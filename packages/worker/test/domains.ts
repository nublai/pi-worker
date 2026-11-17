/**
 * A test stand-in for cgroup domains (src/containment): each domain holds the one host launched in it, and cleaning
 * the domain stops that host (`SessionHost.stop`, true only when it was observed gone). A domain entered with no host
 * (the factory threw) is empty. A domain this instance never entered (a supervisor restarted over the same state) is
 * unproven unless `confirmUnknown` says otherwise. The kernel tier tests real domains (security/containment.test.ts).
 */
import type { Containment, Domain } from '../src/containment/containment.js';
import type { SessionHost } from '../src/host/host.js';
import type { HostFactory } from '../src/supervisor/state.js';
import type { SupervisorOptions } from '../src/supervisor/supervisor.js';

/** Supervisor options whose hosts each run in a test domain (`domains`, a fresh TestDomains by default). */
export function domained(options: Omit<SupervisorOptions, 'containment'>, domains = new TestDomains()): SupervisorOptions {
  return { ...options, factory: domains.track(options.factory), containment: domains };
}

export class TestDomains implements Containment {
  readonly profile = 'test_domains: the host stop stands in for a cgroup domain';
  /** Every clean call, in order. */
  readonly cleaned: Domain[] = [];
  /** Whether a domain this instance never entered is proven clean. */
  confirmUnknown = false;
  /** When false, no domain is ever proven clean (its host may still be stopped). */
  confirm = true;
  private readonly hosts = new Map<string, SessionHost | null>();
  private readonly removed = new Set<string>();

  constructor(options: { confirmUnknown?: boolean; confirm?: boolean } = {}) {
    this.confirmUnknown = options.confirmUnknown ?? false;
    this.confirm = options.confirm ?? true;
  }

  reserve(epoch: string): Domain {
    return { root: '/test-domains', name: `w-${epoch}`, boot: 'test' };
  }

  enter(domain: Domain): readonly string[] {
    if (this.hosts.has(domain.name) || this.removed.has(domain.name)) throw new Error('cleanup domain already exists; populated or not retired');
    this.hosts.set(domain.name, null);
    return [];
  }

  /** Wraps a factory so each host it makes is recorded as its domain's only process. */
  track(factory: HostFactory): HostFactory {
    return launch => {
      const host = factory(launch);
      this.hosts.set(launch.domain.name, host);
      return host;
    };
  }

  async clean(domain: Domain): Promise<boolean> {
    this.cleaned.push(structuredClone(domain));
    if (this.removed.has(domain.name)) return true;
    if (!this.hosts.has(domain.name)) return this.confirmUnknown;
    const host = this.hosts.get(domain.name);
    const gone = (host ? await host.stop() : true) && this.confirm;
    if (gone) this.removed.add(domain.name);
    return gone;
  }
}
