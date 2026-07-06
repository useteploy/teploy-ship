#!/usr/bin/env bash
# Build the teploy-ship container image.
#
# The @neutron-build SDK packages Ship depends on are ahead of their npm
# releases, so the image installs them from tarballs packed out of the
# local Neutron checkout (NEUTRON_TS defaults to the sibling layout).
# Usage:
#   deploy/build-image.sh [image-tag]      # needs docker + pnpm
set -euo pipefail

cd "$(dirname "$0")/.."
TAG="${1:-teploy-ship:dev}"
NEUTRON_TS="${NEUTRON_TS:-../../Neutron/typescript/packages}"

echo "==> building ship + web"
pnpm run build
(cd web && pnpm run build)

echo "==> packing SDK tarballs from ${NEUTRON_TS}"
rm -rf deploy/vendor && mkdir -p deploy/vendor
for p in neutron-ai neutron-workflow neutron-agents neutron neutron-cli; do
  (cd "${NEUTRON_TS}/${p}" && pnpm pack --pack-destination "$(pwd -P)/../../../../Teploy/teploy-ship/deploy/vendor" > /dev/null)
done
ls deploy/vendor

echo "==> docker build ${TAG}"
docker build -f deploy/Dockerfile -t "${TAG}" .
echo "done: ${TAG}"
