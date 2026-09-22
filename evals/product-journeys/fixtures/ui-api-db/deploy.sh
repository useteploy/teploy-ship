#!/bin/sh
# Local staging deploy: smoke tests, boot against a FRESH staging database,
# require /health 200, shut down cleanly. No network beyond loopback.
#
# Note: migrations run in the weekly window (see README); this script does
# not run them.
set -eu
cd "$(dirname "$0")"

echo "== deploy 1/3: staging smoke tests =="
node --test tests/health.test.mjs tests/roundtrip.test.mjs

echo "== deploy 2/3: boot on fresh staging database =="
rm -rf staging
mkdir -p staging
NOTES_DB=staging/notes.sqlite PORT=8901 node server.mjs &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

STATUS=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  STATUS=$(curl -s -o "$PWD/staging/health.json" -w '%{http_code}' http://127.0.0.1:8901/health || true)
  [ "$STATUS" = "200" ] && break
  sleep 1
done

echo "== deploy 3/3: health check =="
if [ "$STATUS" != "200" ]; then
  echo "deploy FAILED: /health returned ${STATUS:-no response}"
  cat staging/health.json 2>/dev/null || true
  echo
  exit 1
fi
echo "deploy OK"
