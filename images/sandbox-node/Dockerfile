# syntax=docker/dockerfile:1
#
# The Node/pnpm sandbox image — what a repo run's container boots when the
# project's stack is JavaScript or TypeScript. Build it with
# `images/build.sh node`; images/versions.json holds the pins.
#
# Replaces ~/ship-sandbox-node/Dockerfile on deploy-test, which existed nowhere
# else. See images/sandbox-go/Dockerfile for the full argument.
#
# The ARG default duplicates images/versions.json so a plain `docker build`
# works; build.sh asserts they agree and refuses to build otherwise.

ARG NODE_BASE=node:22-trixie@sha256:2082d2bf902c8835655c6bcfee3594c00ea900498a9f6e2b96d3352536f9e8d8

FROM ${NODE_BASE}

# git: the run clones inside this container. python3 + build-essential: enough
# repos have a native dependency whose install script needs node-gyp that
# leaving them out turns "tests: not run" into the common case.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# pnpm pinned through corepack. Not `npm i -g pnpm`: corepack is what a repo's
# own packageManager field goes through, and an exact version here means a
# lockfile resolves the same way in the sandbox as on a developer's machine.
ARG PNPM_VERSION=10.26.1
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate && pnpm -v

# The declared harnesses, BAKED — never installed at run time. Same argument as
# images/sandbox-go/Dockerfile: run-time installation needs sandbox egress, and
# a binary that drifts under a running worker breaks replay
# (selectAdapter, src/harness.ts).
ARG HARNESS_SPECS=""
ARG HARNESS_BINARIES=""
RUN set -eux; \
    if [ -n "${HARNESS_SPECS}" ]; then \
      npm install -g ${HARNESS_SPECS}; \
      npm cache clean --force; \
    fi; \
    for b in ${HARNESS_BINARIES}; do command -v "$b"; "$b" --version; done

ARG HARNESS_LABEL=""
LABEL io.teploy.ship.stack="node" \
      io.teploy.ship.harnesses="${HARNESS_LABEL}"

WORKDIR /work
