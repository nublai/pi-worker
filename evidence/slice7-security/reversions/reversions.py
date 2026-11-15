"""Targeted reversions of the security fix round. Each one undoes one guard in an
isolated worktree, rebuilds, and runs the tests that should catch it."""
import json, subprocess, os, sys, re, hashlib
WT='/tmp/a0s7f/rev/wt'; OUT=sys.argv[1]
def sub(path, a, b, count=1):
    p=os.path.join(WT,path); s=open(p).read()
    assert s.count(a)>=1, (path, a[:70]); s=s.replace(a,b) if count==0 else s.replace(a,b,count); open(p,'w').write(s)
R=[]
def rev(name, finding, tests, kernel, *patches):
    R.append(dict(name=name, finding=finding, tests=tests, kernel=kernel, patches=patches))
rev('channel-directory-check-removed','B1',['B1: a symlinked'],False,
    ('src/server.ts',"            supervisor.checkChannelChildRoot(channel.workerId, c.cwd);\n",""),
    ('src/supervisor.ts',"const fd = pinned('parent_channel_child_root_not_real_directory', () => openSandboxRoot(cwd, within));","const fd = pinned('parent_channel_child_root_not_real_directory', () => openSandboxRoot(realpathSync(cwd)));"))
rev('channel-uses-owner-grant','B1/m7',['B1: the channel acts'],False,
    ('src/server.ts',"const token = channel ? supervisor.grants.active(channel.grantId).token","const token = channel ? supervisor.grants.active(parent!.grant_source_id ?? 'owner').token"),
    ('src/server.ts',"        if (channel && !receipt.worker_id) throw new Refusal('parent_channel_scope_denied');\n",""))
rev('staging-follows-race-cpSync','B2',['B2: refused launches'],False,
    ('src/supervisor.ts',"""        const source = openPinned(join(channelParent.cwd, '.a0-agent'), 'dir');
        try {
          mkdirSync(fdPath(rootFd, '.a0-agent'), { mode: 0o700 });
          const dest = openUnder(rootFd, ['.a0-agent'], 'dir');
          try { copyTreeAt(source, dest); } finally { closeSync(dest); }
        } finally { closeSync(source); }""","""        void openPinned; void copyTreeAt; void fdPath;
        cpSync(join(channelParent.cwd, '.a0-agent'), join(cwd, '.a0-agent'), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });"""),
    ('src/supervisor.ts',"import { mkdirSync,","import { cpSync, mkdirSync,"))
rev('staging-before-validation','B2',['B2: refused launches','parent channel staging never dereferences'],False,
    ('src/server.ts',"            const create = () => supervisor.create(c, { channelParent: channel.workerId });","            const { cpSync } = await import('node:fs'); cpSync(join(parent!.cwd, '.a0-agent'), join(c.cwd, '.a0-agent.pre'), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });\n            const create = () => supervisor.create(c, { channelParent: channel.workerId });"))
rev('git-pointer-overlays-removed','M1',['M1: sandbox mounts','kernel M1: child cannot'],True,
    ('src/git-sandbox.ts',"    ro(found.dotGit!, join(root, '.git'));\n",""),
    ('src/git-sandbox.ts',"    ro(open(admin, ['gitdir'], 'file'), join(a, 'gitdir'));\n    ro(open(admin, ['commondir'], 'file'), join(a, 'commondir'));\n",""),
    ('src/git-sandbox.ts',"    if (pin.head) ro(open(admin, ['HEAD'], 'file'), join(a, 'HEAD'));\n",""),
    ('src/git-sandbox.ts',"    ro(open(common, ['objects', 'info'], 'dir', true), join(c, 'objects', 'info'));\n",""))
rev('ordinary-checkout-overlays-removed','M1',['M1: sandbox mounts','kernel M1: an ordinary checkout'],True,
    ('src/git-sandbox.ts',"      ro(open(common, ['config'], 'file'), join(git, 'config'));\n      for (const name of ['hooks', 'info']) ro(open(common, [name], 'dir', true), join(git, name));\n      ro(open(common, ['objects', 'info'], 'dir', true), join(git, 'objects', 'info'));\n",""))
rev('owner-pin-compare-removed','M1',['M1: a planted core.fsmonitor','M1: ordinary checkouts refuse'],False,
    ('src/git-safe.ts',"    assertPin(current, expected);\n","    void current; void assertPin;\n"),
    ('src/git-safe.ts',"    try { current = gitPinAt(root, fd); }","    try { current = null; void gitPinAt; }"))
rev('owner-safe-config-removed','M1',['M1: a planted core.fsmonitor'],False,
    ('src/git-safe.ts',"...SAFE_GIT_CONFIG, ...args]","...args]"))
rev('relaunch-pin-ignored','m2',['m2: relaunch refuses'],False,
    ('src/git-sandbox.ts',"    assertPin(found.pin, options.expected);\n",""))
rev('root-bound-by-path','B1',['kernel B1: bwrap binds'],True,
    ('src/sandbox.ts',"    bind('bind', rootFd, root);\n","    mounts.push('--bind', root, root);\n"))
rev('credential-bind-follows-links','minor',['bwrap profile: --die-with-parent'],False,
    ('src/sandbox.ts',"      let fd: number;\n      try { fd = openUnder(rootFd, ['.a0-agent', name], 'file'); }\n      catch (error) { if (isMissing(error)) continue; throw new Refusal('sandbox_credential_not_regular_file'); }\n      opened.push(fd); bind('ro-bind', fd, join(root, '.a0-agent', name));",
     "      void openUnder; void isMissing; const path = join(root, '.a0-agent', name); if (existsSync(path)) mounts.push('--ro-bind', path, path);"))
rev('die-with-parent-removed','minor',['bwrap profile: --die-with-parent','kernel: --die-with-parent'],True,
    ('src/sandbox.ts',"const mounts = ['--die-with-parent', '--clearenv',","const mounts = ['--clearenv',"))
rev('clearenv-removed','minor',['bwrap profile: --die-with-parent'],False,
    ('src/sandbox.ts',"const mounts = ['--die-with-parent', '--clearenv', ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]),","const mounts = ['--die-with-parent',"))
rev('channel-retry-lookup-removed','m1',['m1: an exact channel launch retry'],False,
    ('src/server.ts',"            if (supervisor.receipts.all.has(c.command_id)) return json(res, await run('workers.create', create, channel.workerId));\n",""))
rev('native-move-reconcile-removed','m4',['m4: a native move'],False,
    ('src/supervisor.ts',"      live.moveTimer = setTimeout(() => { live.moveTimer = undefined; void this.reconcileNativeMove(live, host); }, this.nativeMoveTimeoutMs);","      void host; live.moveTimer = setTimeout(() => { live.moveTimer = undefined; }, this.nativeMoveTimeoutMs);"))
rev('rpc-premove-signal-removed','m3',['m3: RPC refuses'],False,
    ('src/rpc-audit.ts',"  pi.on('session_shutdown', (_event, ctx) => ctx.ui.notify('A0_HOST_BINDING_CHANGING'));\n",""))
rev('channel-git-containment-removed','B1',['B1: a channel child may be a linked worktree'],False,
    ('src/supervisor.ts',"      try { pinned('sandbox_git_metadata_unreadable', () => gitPinAt(cwd, fd, dirname(within!))); } catch (error) { closeSync(fd); throw error; }\n",""),
    ('src/supervisor.ts',"gitPinAt(cwd, rootFd, channelParent?.cwd)","gitPinAt(cwd, rootFd, undefined)"),
    ('src/sandbox.ts',"{ within: options.within && dirname(options.within), expected: options.gitPin }","{ expected: options.gitPin }"))
results=[]
only=sys.argv[2:] 
for r in R:
    if only and r['name'] not in only: continue
    subprocess.run(['git','-C',WT,'checkout','--','.'],check=True)
    for path,a,b in r['patches']: sub(path,a,b)
    diff=subprocess.run(['git','-C',WT,'diff'],capture_output=True,text=True).stdout
    open(f"{OUT}/{r['name']}.diff",'w').write(diff)
    b=subprocess.run(['npx','tsc','-p','tsconfig.json'],cwd=WT,capture_output=True,text=True)
    if b.returncode: results.append(dict(name=r['name'],finding=r['finding'],compiled=False,log=b.stdout[-2000:])); print(r['name'],'COMPILE FAIL',b.stdout[-800:]); continue
    files=['dist/test/security-fix.test.js','dist/test/gate1-parent.test.js']
    env={**os.environ,'TMPDIR':'/tmp/a0s7f/tmp'}
    if r['kernel']: env['A0_TEST_BWRAP']='1'
    pat='|'.join(re.escape(t) for t in r['tests'])
    t=subprocess.run(['node','--test','--test-name-pattern',pat,*files],cwd=WT,capture_output=True,text=True,env=env,timeout=600)
    log=t.stdout+t.stderr; open(f"{OUT}/{r['name']}.log",'w').write(log)
    fails=[l for l in log.splitlines() if l.startswith('✖ ') and 'failing tests' not in l]
    failed=sorted(set(fails)); assertion='AssertionError' in log or 'ERR_ASSERTION' in log
    res=dict(name=r['name'],finding=r['finding'],compiled=True,guard_tests=r['tests'],kernel=r['kernel'],exit_code=t.returncode,failed_tests=failed,assertion_failure=assertion,killed=t.returncode!=0 and assertion,log=f"{r['name']}.log",log_sha256=hashlib.sha256(log.encode()).hexdigest(),diff=f"{r['name']}.diff")
    results.append(res); print(r['name'],'KILLED' if res['killed'] else 'SURVIVED',failed[:3])
subprocess.run(['git','-C',WT,'checkout','--','.'],check=True)
json.dump(results,open(f"{OUT}/reversions-run.json",'w'),indent=2)
