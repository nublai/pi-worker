/** Owner read-only inspection through the pinned helper; prints Git metadata only. */
import {readFileSync} from 'node:fs';
import {parseJournal} from '/tmp/a0g1b/runtime/dist/journal.js';
import {safeGit} from '/tmp/a0g1b/runtime/dist/git-safe.js';
const R='/tmp/a0g1b/run',root=R+'/workspace',pin=JSON.parse(readFileSync(R+'/workspace-pin.json','utf8'));
const recs=parseJournal(readFileSync(R+'/state/journal.jsonl')).records.filter(r=>r.kind==='worker');
const latest=new Map(recs.map(r=>[r.value.worker.worker_id,r.value.worker]));
for(const w of latest.values())console.log(w.worker_id,w.parent_worker_id?'child':'parent',w.cwd,w.status,w.cleanup);
console.log(safeGit(root,pin,['worktree','list','--porcelain']));
console.log(safeGit(root,pin,['log','--oneline','-5']));
console.log(safeGit(root,pin,['for-each-ref','--format=%(refname) %(objectname:short)']));
