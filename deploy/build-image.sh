#!/usr/bin/env bash
# Build the teploy-ship container image.
#
# Usage:
#   deploy/build-image.sh [image-tag]        # needs docker
#   deploy/build-image.sh --push [version]   # also pushes to GHCR (needs docker login)
#
# There is deliberately no local build step: the Dockerfile's builder stage
# compiles dist/ and web/dist/ from the source in the build context (the
# 2026-10-18 stale-dist fix), and .dockerignore keeps any host-built dist/
# out of that context, so the tag below always labels code compiled from
# this checkout.
#
# --push tags the image as the given version AND as `stable`, then pushes
# both to ghcr.io/useteploy/teploy-ship. The `stable` tag is what the
# community template (useteploy/templates/teploy-ship) deploys, so publishing
# it is the switch that makes `teploy template install teploy-ship` work —
# add the index.json entry in the same change that first pushes it.
set -euo pipefail

cd "$(dirname "$0")/.."

PUSH=0
VERSION=""
for arg in "$@"; do
  case "${arg}" in
    --push) PUSH=1 ;;
    *) VERSION="${arg}" ;;
  esac
done

TAG="teploy-ship:dev"
if [ -n "${VERSION}" ]; then
  TAG="teploy-ship:${VERSION}"
fi

echo "==> docker build ${TAG} (compiles dist/ and web/dist/ in the builder stage)"
docker build -t "${TAG}" .

if [ "${PUSH}" -eq 1 ]; then
  if [ -z "${VERSION}" ]; then
    echo "refusing to --push without a version: deploy/build-image.sh --push v0.2.0" >&2
    exit 1
  fi
  REMOTE="ghcr.io/useteploy/teploy-ship"
  echo "==> pushing ${REMOTE}:${VERSION} and ${REMOTE}:stable"
  docker tag "${TAG}" "${REMOTE}:${VERSION}"
  docker tag "${TAG}" "${REMOTE}:stable"
  docker push "${REMOTE}:${VERSION}"
  docker push "${REMOTE}:stable"
  echo "pushed. If this is the first push, add the teploy-ship entry to"
  echo "useteploy/templates index.json — the template is already waiting."
fi

echo "done: ${TAG}"
