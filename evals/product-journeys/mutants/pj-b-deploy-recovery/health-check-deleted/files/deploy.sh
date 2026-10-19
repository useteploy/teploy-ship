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
# as "listening <port>" into staging/server.log.
NOTES_DB=staging/notes.sqlite PORT=0 node server.mjs > staging/server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

echo "deploy OK"
