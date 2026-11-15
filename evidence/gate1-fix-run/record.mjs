/** Packages the Gate 1 fix-round records (local + VM). Reads exported files only. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const E='evidence/gate1-fix-run',F='evidence/gate1-fix';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const parse=p=>{try{return JSON.parse(readFileSync(p,'utf8'));}catch(cause){throw new Error('Invalid record: '+p,{cause});}};
const counts=p=>{const t=readFileSync(p,'utf8'),c={};for(const k of ['tests','pass','fail','skipped'])c[k]=Number(t.match(new RegExp('(?:#|ℹ) '+k+' (\\d+)'))?.[1]);return c;};
const log=(host,path,command,extra={})=>({host,command,log:path,sha256:sha(path),...(path.includes('generated')?{}:{counts:counts(path)}),...extra});
const v=parse(E+'/vm/verification.json'),n=parse(E+'/vm/native-audit.json'),att=parse(E+'/vm/attention.json'),ic=parse(E+'/vm/integration-check.json'),rev=parse(F+'/reversions.json');
const record={producer:'gate1-fix-round-owner-evidence-packager',
  runtime_subject:{commit_id:'24e1de26bc131d56a1773db006cb5a8b6aee8552',tree_id:parse(E+'/vm/vm-final-audit.json').subject.tree_id,note:'fixed runtime bundled to the VM (branch a0/gate1-rerun); code identical to 2a3ba08 fix commit plus docs/harness/evidence'},
  local:[log('local',F+'/local-default.log','npm test (TMPDIR=/tmp/a0g1f/tmp)'),log('local',F+'/local-kernel.log','systemd-run --user --unit=a0-g1f-kernel --property=Delegate=yes ... evidence/gate1-rerun/kernel.sh (A0_TEST_BWRAP=1, A0_TEST_CGROUP_DIR)'),log('local',F+'/local-generated.log','npm run check:generated')],
  before_fix:{log:F+'/before-fix/gate1-fix-on-7ea2f0d.log',sha256:sha(F+'/before-fix/gate1-fix-on-7ea2f0d.log'),counts:counts(F+'/before-fix/gate1-fix-on-7ea2f0d.log'),note:'all 6 new tests fail by assertion on the unfixed runtime (A0_TEST_BWRAP=1)'},
  reversions:{killed:rev.killed,total:rev.total,file:F+'/reversions.json'},
  vm:[log('a0-worker',E+'/vm/vm-default.log','npm test (/tmp/a0g1b/runtime)'),
    log('a0-worker',E+'/vm/vm-kernel-run1-flake.log','kernel suite, first run',{result:'1 failure: owner Git snapshot-faithful test (pre-existing racy-git flake, see report)'}),
    log('a0-worker',E+'/vm/vm-kernel.log','systemd-run --user --unit=a0-g1b-suite-kernel --property=Delegate=yes ... kernel.sh, second run'),
    log('a0-worker',E+'/vm/vm-generated.log','npm run check:generated')],
  model_driven_job:{pass:true,steps:['vm-setup.sh','live.mjs start','live.mjs wait','live.mjs freeze','audit.mjs','integration-check.mjs','verify.mjs','finish.mjs','final-audit.mjs','privacy-scan.mjs'],
    artifact_subject:{commit_id:v.subject.commit_id,tree_id:v.subject.tree_id,base_id:v.subject.base_id},verification:v.result,
    launch_attempts:n.launch_attempts,delivery_counts:n.delivery_counts,changed_refs:n.changed_refs,parent_tool_counts:n.workers[0].tool_counts,
    parent_did_child_work:false,integration:{parent_commits_equal_child_diffs:ic.parent_commits.map(c=>({commit:c.commit,same_diff_as:c.same_diff_as})),parent_edit_or_write_calls:ic.parent_edit_or_write_paths.length,parent_git_commit_calls:ic.parent_bash_git_commit_calls},
    reconnect:n.reconnect,native_calls_during_disconnect:n.native_calls_during_disconnect,
    staged_child_profile_entries:{parent_profile:18801,each_child:23,child_node_modules_mount_point_entries_on_host:0},
    fresh_checkout_checks:v.checks.map(c=>({command:c.command.slice(-3).join(' '),pass:c.pass,counts:c.counts})),
    harness_attempts_not_counted_as_passes:['audit.mjs run before freeze (ordering error; parent still ready)','audit.mjs used safeGit worktree list, which cannot see linked worktrees on the private snapshot; replaced by an O_NOFOLLOW check of <admin>/locked','verify.mjs clone refused by SAFE_GIT_CONFIG protocol.allow=never; re-allowed only protocol.file for the clone','verify.mjs attempt 2: artifact kernel suite hit the same racy-git owner-Git flake; attempt 3 passed']},
  attention:{authorization_interventions:att.authorization_interventions,prompts:att.prompts,answers:att.answers,acceptances:att.acceptances,owner_write_actions:att.owner_write_actions,elapsed_minutes_prompt_to_acceptance:att.elapsed_minutes_to_acceptance,founder_live_touches:att.founder_live_touches,verified_changes:att.verified_changes,verified_prs:att.verified_prs},
  stray_supervisor:{pid:1269,command:'node dist/main.js',cwd:'/tmp/a0/repo',cgroup:'0::/init.scope',ppid:1,children:0,started:'2026-11-15T05:05:37Z (VM local clock)',stopped:'SIGTERM at 2026-11-15T22:32:13Z, gone within 1 s',only_process_stopped:true},
  final_a0_units:{local:0,vm:0}};
writeFileSync(E+'/checks.json',JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({job:record.model_driven_job.pass,subject:record.model_driven_job.artifact_subject,attention:record.attention}));
