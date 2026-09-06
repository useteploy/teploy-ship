#!/usr/bin/env bash
# Build Ship's sandbox images from the pins in images/versions.json.
#
# Run this ON the machine whose docker daemon the teploy-sandbox service uses —
# a run's container is created there, and an image that only exists on your
# laptop is an image Ship cannot boot. `install.sh` does this for you.
#
#   images/build.sh                       # go + node, every harness baked, :dev
#   images/build.sh go                    # just the Go image
#   images/build.sh rust                  # the Rust image (never the default; per project)
#   images/build.sh --harness none node   # a plain pnpm sandbox, native runs only
#   images/build.sh --tag v3 --harness claude-code go
#
# Produces:
#   ship-sandbox-go:<tag>       Go 1.25 + node/npm (+ declared harnesses)
#   ship-sandbox-node:<tag>     node 22 + pnpm     (+ declared harnesses)
#   ship-sandbox-rust:<tag>     rust stable + node/npm (+ declared harnesses), on request only
#   ship-sandbox-harness:<tag>  alias of ship-sandbox-go when harnesses are baked
#
# The alias is not decoration: the deployed worker on deploy-test has carried
# SHIP_SANDBOX_IMAGE=ship-sandbox-harness:dev since before this repo owned the
# Dockerfiles, and renaming the image out from under a running worker is not a
# thing a build script gets to do.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
versions="${here}/versions.json"

die() { printf 'images/build.sh: %s\n' "$*" >&2; exit 1; }

# JSON without jq. python3 is on every Debian/Ubuntu host that runs docker;
# node is the fallback for a machine that somehow has one and not the other.
# The argument is an expression over `d`, the parsed document.
if command -v python3 >/dev/null 2>&1; then
  json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$versions" "$1"; }
elif command -v node >/dev/null 2>&1; then
  json() { node --input-type=module -e 'import {readFileSync} from "node:fs"; const d=JSON.parse(readFileSync(process.argv[1],"utf8")); console.log(eval(process.argv[2]));' "$versions" "$1"; }
else
  die "need python3 or node to read versions.json"
fi

stacks=()
tag="dev"
harness_arg=""
no_alias=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
    --harness) harness_arg="${2:?--harness needs a value}"; shift 2 ;;
    --no-alias) no_alias=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    go|node|rust) stacks+=("$1"); shift ;;
    all) stacks+=(go node rust); shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
# `test && assign` would abort under `set -e` whenever the test is false.
if [ ${#stacks[@]} -eq 0 ]; then stacks=(go node); fi

command -v docker >/dev/null 2>&1 || die "docker is not on PATH — run this on the sandbox host"

go_base="$(json 'd["bases"]["go"]')"
node_base="$(json 'd["bases"]["node"]')"
rust_base="$(json 'd["bases"]["rust"]')"
pnpm_version="$(json 'd["pnpm"]')"
playwright_version="$(json "d['playwright']")"

# Which harnesses to bake. Default: every one versions.json knows about, which
# is also every one src/harness.ts has an adapter for.
all_ids="$(json '" ".join(k for k in d["harnesses"] if not k.startswith("$"))')"
case "${harness_arg}" in
  "")   ids="${all_ids}" ;;
  none) ids="" ;;
  *)    ids="$(printf '%s' "${harness_arg}" | tr ',' ' ')" ;;
esac

specs=""; binaries=""; label=""
for id in ${ids}; do
  case " ${all_ids} " in *" ${id} "*) ;; *) die "unknown harness \"${id}\"; known: ${all_ids}" ;; esac
  pkg="$(json "d[\"harnesses\"][\"${id}\"][\"npm\"]")"
  ver="$(json "d[\"harnesses\"][\"${id}\"][\"version\"]")"
  bin="$(json "d[\"harnesses\"][\"${id}\"][\"binary\"]")"
  specs="${specs}${specs:+ }${pkg}@${ver}"
  binaries="${binaries}${binaries:+ }${bin}"
  label="${label}${label:+,}${id}@${ver}"
done

# The Dockerfiles carry the same pins as ARG defaults so they read standalone.
# Assert the copies agree instead of trusting them to: a Dockerfile whose
# default has drifted from versions.json would build a different image for
# anyone who ran `docker build` directly.
assert_pin() {
  grep -qxF "ARG $2=$3" "$1" || die "$1: ARG $2 does not match versions.json ($3) — fix one of them"
}
assert_pin "${here}/sandbox-go/Dockerfile"   GO_BASE      "${go_base}"
assert_pin "${here}/sandbox-go/Dockerfile"   NODE_BASE    "${node_base}"
assert_pin "${here}/sandbox-node/Dockerfile" NODE_BASE    "${node_base}"
assert_pin "${here}/sandbox-node/Dockerfile" PNPM_VERSION "${pnpm_version}"
assert_pin "${here}/sandbox-go/Dockerfile"   PLAYWRIGHT_VERSION "${playwright_version}"
assert_pin "${here}/sandbox-node/Dockerfile" PLAYWRIGHT_VERSION "${playwright_version}"
assert_pin "${here}/sandbox-rust/Dockerfile" RUST_BASE     "${rust_base}"
assert_pin "${here}/sandbox-rust/Dockerfile" NODE_BASE     "${node_base}"

echo "==> harnesses: ${label:-none}"

build() {
  stack="$1"
  image="ship-sandbox-${stack}:${tag}"
  echo "==> building ${image}"
  set -- --tag "${image}" --build-arg "NODE_BASE=${node_base}"
  if [ "${stack}" = go ]; then set -- "$@" --build-arg "GO_BASE=${go_base}"; fi
  if [ "${stack}" = node ]; then set -- "$@" --build-arg "PNPM_VERSION=${pnpm_version}"; fi
  if [ "${stack}" = node ] || [ "${stack}" = go ]; then set -- "$@" --build-arg "PLAYWRIGHT_VERSION=${playwright_version}"; fi
  if [ "${stack}" = rust ]; then set -- "$@" --build-arg "RUST_BASE=${rust_base}"; fi
  set -- "$@" \
    --build-arg "HARNESS_SPECS=${specs}" \
    --build-arg "HARNESS_BINARIES=${binaries}" \
    --build-arg "HARNESS_LABEL=${label}" \
    "${here}/sandbox-${stack}"
  docker build "$@"
  echo "built ${image}"
}

for stack in "${stacks[@]}"; do
  build "${stack}"
  if [ "${stack}" = go ] && [ -n "${label}" ] && [ "${no_alias}" -eq 0 ]; then
    docker tag "ship-sandbox-go:${tag}" "ship-sandbox-harness:${tag}"
    echo "tagged ship-sandbox-harness:${tag} (legacy name; see the header)"
  fi
done

echo
echo "Point a worker at one of these with SHIP_SANDBOX_IMAGE, or a single repo"
echo "with: teploy-ship project set <repo> --image ship-sandbox-node:${tag}"
