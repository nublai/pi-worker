set -eu
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
cd /tmp/a0/repo
export A0_SOCKET=/tmp/a0/state/worker.sock
W=51aaf702-e108-4fa9-8492-f0bf95dbf43c
E=7478d362-cdcc-42ce-962b-f9a8b86089fc
node dist/cli.js get "$W" > /tmp/a0/final-worker-before.json
timeout 180 node dist/cli.js watch "$W" --until-settled > /tmp/a0/final-turn-events.jsonl &
WATCH=$!
node dist/cli.js prompt "$W" --command-id final-prompt --message 'Do not delegate. Use the write tool to write /tmp/a0/workspace-final/proof.txt containing exactly A0_SLICE1_FILE_OK followed by a newline. Then reply A0_SLICE1_REPLY_OK.' | tee /tmp/a0/final-prompt-first.json
node dist/cli.js prompt "$W" --command-id final-prompt --message 'Do not delegate. Use the write tool to write /tmp/a0/workspace-final/proof.txt containing exactly A0_SLICE1_FILE_OK followed by a newline. Then reply A0_SLICE1_REPLY_OK.' > /tmp/a0/final-prompt-duplicate.json
cmp /tmp/a0/final-prompt-first.json /tmp/a0/final-prompt-duplicate.json && echo DUPLICATE_RECEIPT_IDENTICAL
wait "$WATCH"
node dist/cli.js history "$W" > /tmp/a0/final-history.json
node dist/cli.js get "$W" > /tmp/a0/final-worker-after-turn.json
node dist/cli.js watch "$W" --max-events 1 > /tmp/a0/final-detach.jsonl
SEQ=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/a0/final-detach.jsonl","utf8")).cursor.seq)')
node dist/cli.js watch "$W" --max-events 1 --worker-epoch "$E" --seq "$SEQ" > /tmp/a0/final-reattach.jsonl
node -e 'const f=require("fs"); const rows=f.readFileSync("/tmp/a0/final-turn-events.jsonl","utf8").trim().split("\n").map(JSON.parse); const h=JSON.parse(f.readFileSync("/tmp/a0/final-history.json"));console.log(JSON.stringify({eventTypes:[...new Set(rows.map(e=>e.type))],first:rows[0].type,last:rows.at(-1).type,historyEntries:h.entries.length,watermark:h.watermark,proof:f.readFileSync("/tmp/a0/workspace-final/proof.txt","utf8")}))'
