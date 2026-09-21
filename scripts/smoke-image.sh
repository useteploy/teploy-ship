#!/usr/bin/env bash
# No live credentials, database or worker: prove the production SSR process
# actually serves through Docker's published port, not just inside loopback.
set -euo pipefail
image="${1:?usage: smoke-image.sh IMAGE}"
name="ship-image-check-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -p 127.0.0.1::7460 \
  -e SHIP_WEB_TOKEN=synthetic-image-check \
  "$image" web --store file --port 7460 >/dev/null
port="$(docker port "$name" 7460/tcp)"
for attempt in $(seq 1 45); do
  if curl --fail --silent --max-time 2 "http://$port/login" >/dev/null; then
    curl --fail --silent --max-time 15 \
      -H 'Authorization: Bearer synthetic-image-check' "http://$port/setup" >/dev/null
    echo 'Image passed: login and authenticated setup respond through the published port.'
    exit 0
  fi
  sleep 1
done
docker logs "$name"
echo 'Image failed: no successful response through the published port.' >&2
exit 1
