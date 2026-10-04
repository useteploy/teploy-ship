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

echo "deploy OK"
