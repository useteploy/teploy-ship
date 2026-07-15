#!/usr/bin/env bash
# Build the teploy-ship container image.
#
# Usage:
#   deploy/build-image.sh [image-tag]      # needs docker + pnpm
set -euo pipefail

cd "$(dirname "$0")/.."
TAG="${1:-teploy-ship:dev}"

echo "==> building ship + web"
pnpm run build
(cd web && pnpm run build)

echo "==> docker build ${TAG}"
docker build -t "${TAG}" .
echo "done: ${TAG}"
