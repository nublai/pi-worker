set -eu
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
cd /tmp/a0/repo
export A0_SOCKET=/tmp/a0/state/worker.sock
W=51aaf702-e108-4fa9-8492-f0bf95dbf43c
node dist/cli.js hello > /tmp/a0/final-hello-recovered.json
node dist/cli.js receipt final-crash | tee /tmp/a0/final-crash-receipt-after.json
MESSAGE=$(python3 -c 'print(open("/tmp/a0/final-crash-message.txt").read(),end="")')
node dist/cli.js prompt "$W" --command-id final-crash --message "$MESSAGE" > /tmp/a0/final-crash-duplicate.json
cmp /tmp/a0/final-crash-receipt-after.json /tmp/a0/final-crash-duplicate.json && echo RECOVERED_DUPLICATE_RECEIPT_IDENTICAL
node dist/cli.js prompt "$W" --command-id final-fenced --message 'Must be refused without effect' | tee /tmp/a0/final-fenced.json
node dist/cli.js get "$W" > /tmp/a0/final-worker-recovered.json
node dist/cli.js history "$W" > /tmp/a0/final-history-recovered.json
node dist/cli.js watch "$W" --max-events 1 --worker-epoch 7478d362-cdcc-42ce-962b-f9a8b86089fc --seq 33 > /tmp/a0/final-attach-recovered.jsonl
node dist/cli.js stop "$W" --command-id final-stop | tee /tmp/a0/final-stop.json
node dist/cli.js create --command-id final-replacement --cwd /tmp/a0/workspace-final --provider exe-dev-anthropic --model claude-sonnet-4-6@llm --thinking off | tee /tmp/a0/final-replacement.json
node - <<'JS'
const fs=require('fs');
const r=JSON.parse(fs.readFileSync('/tmp/a0/final-crash-receipt-after.json'));
const f=JSON.parse(fs.readFileSync('/tmp/a0/final-fenced.json'));
const w=JSON.parse(fs.readFileSync('/tmp/a0/final-worker-recovered.json'));
const h=JSON.parse(fs.readFileSync('/tmp/a0/final-history-recovered.json'));
const log=fs.readFileSync('/tmp/a0/state/journal.jsonl','utf8');
const rows=log.trim().split('\n').map(JSON.parse).map(x=>x.record);
const states=rows.filter(x=>x.kind==='receipt'&&x.value.command_id==='final-crash').map(x=>x.value.state);
const crashPrompts=h.entries.filter(e=>e.type==='message'&&e.message?.role==='user'&&JSON.stringify(e.message.content).includes('CRASH_BLOCK_STARTED')).length;
const start=fs.readFileSync('/tmp/a0/workspace-final/crash-start.txt','utf8');
if(r.state!=='outcome_unknown'||f.effect!=='no_effect'||f.uncertain_command_id!=='final-crash'||w.fence.command_id!=='final-crash'||start!=='ONCE\n'||crashPrompts!==1) throw Error('verification failed');
if(fs.existsSync('/tmp/a0/workspace-final/crash-finished.txt'))throw Error('blocking tool finished unexpectedly');
if(log.includes('CRASH_BLOCK_STARTED'))throw Error('prompt values leaked into control journal');
console.log(JSON.stringify({journalStates:states,fence:w.fence,cleanup:w.cleanup,startEffectCount:start.trim().split('\n').length,crashPromptsInPiHistory:crashPrompts,finishedFileExists:false,controlJournalContainsPromptText:false}));
JS
stat -c '%a %n' /tmp/a0/state /tmp/a0/state/worker.sock /tmp/a0/state/journal.jsonl
# Show process identities only, not unrelated command lines or environment values.
ps -eo comm | sort | uniq -c | grep -E 'pi$|node$' || true
tailscale status --json | jq '{tags:.Self.Tags,online:.Self.Online}'
sudo tailscale debug prefs | jq '{RunSSH:.RunSSH}'
