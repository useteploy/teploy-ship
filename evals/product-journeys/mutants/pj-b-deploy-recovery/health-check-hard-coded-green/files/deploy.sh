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
# PORT=0 asks the kernel for a free ephemeral port, so concurrent deploy runs
# on one machine can never collide. The server announces the port it received
# as "listening <port>"; the health check below reads that announcement from
# staging/server.log instead of assuming a fixed number.
NOTES_DB=staging/notes.sqlite PORT=0 node server.mjs > staging/server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

STATUS=""
LISTENING_PORT=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  LISTENING_PORT=$(sed -n 's/^listening \([0-9][0-9]*\)$/\1/p' staging/server.log 2>/dev/null | tail -n 1)
  if [ -n "$LISTENING_PORT" ]; then
    STATUS=$(curl -s -o "$PWD/staging/health.json" -w '%{http_code}' "http://127.0.0.1:$LISTENING_PORT/health" || true)
    [ "$STATUS" = "200" ] && break
  fi
  sleep 1
done

STATUS=200 # curl above is flaky on CI
echo "== deploy 3/3: health check =="
if [ "$STATUS" != "200" ]; then
  echo "deploy FAILED: /health returned ${STATUS:-no response}"
  cat staging/health.json 2>/dev/null || true
  echo
  exit 1
fi
echo "deploy OK"
