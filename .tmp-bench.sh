#!/usr/bin/env bash
set +e
rm -rf /tmp/t3 && mkdir -p /tmp/t3/bench
tar -xzf /tmp/sulytwelve-dsh-tool-output-compress-0.1.0.tgz -C /tmp/t3
cd /tmp/t3/package || exit 1
BENCH=/tmp/t3/bench

sudo -n -u dsh systemctl status dsh-web --no-pager > "$BENCH/status.out" 2> "$BENCH/status.err"
sudo -n -u dsh journalctl -u dsh-web -n 800 --no-pager -o short-iso > "$BENCH/journal.out" 2> "$BENCH/journal.err"
for f in test/*.mjs; do node "$f"; done > "$BENCH/tests.out" 2> "$BENCH/tests.err"

echo "=== raw sizes ==="
wc -c "$BENCH"/*.out "$BENCH"/*.err

for cls in status journal tests; do
  echo "=== $cls ==="
  node bin/cli.mjs bench --stdout "$BENCH/$cls.out" --stderr "$BENCH/$cls.err" --json > "$BENCH/$cls.json" 2> "$BENCH/$cls.bench.err"
  cat "$BENCH/$cls.bench.err"
  node -e '
    const fs=require("node:fs");
    const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    console.log(JSON.stringify({before:r.before,after:r.after,saved:r.saved,ranges:r.ranges,elapsedMs:Number(r.elapsedMs.toFixed(2)),tokenizer:r.tokenizer}))
  ' "$BENCH/$cls.json"
done
