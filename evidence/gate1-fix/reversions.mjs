/** Task-owned isolated reversion runner for the Gate 1 fix round. Each case
 * applies ONE exact source replacement to a fresh `git archive` of HEAD, builds,
 * and runs the fix-round regressions (real bwrap enabled). A case is killed only
 * when it compiles and a named guard test fails by assertion. */
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const repo=process.cwd(),out=resolve(process.argv[2]??'evidence/gate1-fix/reversions'),scratch='/tmp/a0g1f/rev';
mkdirSync(out,{recursive:true});rmSync(scratch,{recursive:true,force:true});mkdirSync(scratch,{recursive:true});
const cases=[
  {name:'d1-copy-whole-profile',defect:'D1',file:'src/pinned-fs.ts',from:"0, 'recreate', { prefix: [], found }); return found; }",to:"0, 'recreate'); return found; }",guards:['D1: a real-size profile','kernel D1:']},
  {name:'d1-dependency-bind-writable',defect:'D1',file:'src/sandbox.ts',from:"bind('ro-bind', dep.fd, join(root, '.a0-agent', ...dep.dest));",to:"bind('bind', dep.fd, join(root, '.a0-agent', ...dep.dest));",guards:['D1: a real-size profile','kernel D1:']},
  {name:'d2-refusal-default-no-effect',defect:'D2',file:'src/receipts.ts',from:"const noEffect = current.state === 'intent' || error instanceof ProvenNoEffect;",to:"const noEffect = current.state === 'intent' || (error instanceof Refusal && error.effect === 'no_effect');",guards:['D2: after the dispatch record']},
  {name:'d2-no-cleanup',defect:'D2',file:'src/supervisor.ts',from:"try { this.stagingCleanup(rootFd); } catch { /* the descriptor check below decides */ }",to:"/* reverted: no cleanup */",guards:['D1: the copied part keeps','D2+D3:']},
  {name:'d2-no-verification',defect:'D2',file:'src/supervisor.ts',from:"if (absentAt(rootFd, '.a0-agent')) throw new ProvenNoEffect",to:"if (absentAt(rootFd, '.a0-agent') || true) throw new ProvenNoEffect",guards:['D2: an unverified staging cleanup']},
  {name:'d3-row-left-starting',defect:'D3',file:'src/supervisor.ts',from:"        await this.launchFailed(live, c.command_id, error);\n",to:"",guards:['D2+D3:']},
];
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const results=[];
for(const c of cases){
  const dir=join(scratch,c.name);mkdirSync(dir);
  execFileSync('sh',['-c',`git archive HEAD | tar -x -C ${dir}`]);
  symlinkSync(join(repo,'node_modules'),join(dir,'node_modules'));
  const path=join(dir,c.file),src=readFileSync(path,'utf8');
  if(src.split(c.from).length!==2)throw new Error('reversion anchor not unique: '+c.name);
  writeFileSync(path,src.replace(c.from,c.to));
  const diff=spawnSync('git',['diff','--no-index','--',join(repo,c.file),path],{encoding:'utf8'}).stdout;
  writeFileSync(join(out,c.name+'.diff'),diff);
  const build=spawnSync(join(repo,'node_modules/.bin/tsc'),['-p','tsconfig.json'],{cwd:dir,encoding:'utf8'});
  let log='BUILD exit '+build.status+'\n'+build.stdout+build.stderr+'\n';
  let test={status:null,stdout:'',stderr:''};
  if(build.status===0)test=spawnSync(process.execPath,['--test','dist/test/gate1-fix.test.js'],{cwd:dir,encoding:'utf8',env:{...process.env,A0_TEST_BWRAP:'1',TMPDIR:'/tmp/a0g1f/tmp'},timeout:600000});
  log+=test.stdout+test.stderr;writeFileSync(join(out,c.name+'.log'),log);
  const failed=[...new Set(log.split('\n').filter(l=>/^✖ /.test(l)&&!/failing tests/.test(l)).map(l=>l.replace(/ \([\d.]+ms\)$/,'')))];
  const guardFailed=c.guards.every(g=>failed.some(f=>f.includes(g)));
  const assertion=/AssertionError/.test(log);
  results.push({name:c.name,defect:c.defect,file:c.file,compiled:build.status===0,exit_code:test.status,guard_tests:c.guards,failed_tests:failed,assertion_failure:assertion,killed:build.status===0&&test.status!==0&&guardFailed&&assertion,log:c.name+'.log',log_sha256:sha(join(out,c.name+'.log')),diff:c.name+'.diff'});
  console.log(c.name,results.at(-1).killed);
}
writeFileSync(join(out,'..','reversions.json'),JSON.stringify({producer:'gate1-fix-isolated-reversion-runner',subject_commit:head,test_file:'src/test/gate1-fix.test.ts',env:'A0_TEST_BWRAP=1 (real bwrap), no cgroup delegation needed',reversions:results,killed:results.filter(r=>r.killed).length,total:results.length},null,2)+'\n');
rmSync(scratch,{recursive:true,force:true});
