#!/usr/bin/env node
/**
 * pi-worker supervisor entry. It refuses to start without a cgroup v2 delegation (plan decision D3): `PIW_CGROUP_ROOT`
 * names an operator-supplied delegated cgroup, otherwise an installation-scoped systemd user service keeps one.
 */
import { openContainment } from './containment/containment.js';
import { runDaemon } from './daemon.js';

await runDaemon(stateDir => openContainment(stateDir));
