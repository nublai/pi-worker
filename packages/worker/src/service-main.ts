#!/usr/bin/env node
/**
 * pi-worker supervisor entry for the installed user unit (`pi-worker daemon`, docs/plan/install.md): enters the unit's
 * `supervisor` leaf, then runs the daemon with the unit cgroup as its delegation. Outside such a unit it refuses to
 * start (`no_service_delegation`); main.ts stays the entry for an operator-supplied delegation or the keeper unit.
 */
import { openContainment } from './containment/containment.js';
import { runDaemon } from './daemon.js';
import { enterServiceLeaf, ServiceDelegationRefused } from './service.js';

let root: string;
try {
  root = enterServiceLeaf();
} catch (error) {
  if (!(error instanceof ServiceDelegationRefused)) throw error;
  console.error(JSON.stringify({ event: 'refused', reason: error.code, detail: error.message }));
  process.exit(1);
}
await runDaemon(installation => openContainment(installation, { ...process.env, PIW_CGROUP_ROOT: root }));
