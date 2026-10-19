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
# works; build.sh asserts they agree and refuses to build otherwise. Since the
# ACP driver landed the build CONTEXT is the images/ directory (the image
# COPYies acp-driver/ship-acp.mjs), so a hand build is
# `docker build -f images/sandbox-node/Dockerfile images/` — not
# `docker build images/sandbox-node`. Prefer images/build.sh.

ARG NODE_BASE=node:22-trixie@sha256:2082d2bf902c8835655c6bcfee3594c00ea900498a9f6e2b96d3352536f9e8d8

FROM ${NODE_BASE}

# git: the run clones inside this container. python3 + build-essential: enough
# repos have a native dependency whose install script needs node-gyp that
# leaving them out turns "tests: not run" into the common case.
# python3-pytest: detection's `python3 -m pytest -q` must be runnable on the
# stock images (fresh-machine F10; see sandbox-go/Dockerfile).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-pytest build-essential \
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
# A headless browser, for two things: the visual rung (a screenshot of the
# preview and of main) and the agent's own proof — a `.ship/flow.mjs`
# Playwright script that drives the changed page and writes PNGs the run
# attaches to the pull request. Debian's chromium plus a pinned Playwright
# that does NOT download its own browser: one Chromium, on PATH, is what
# every screenshot in this image comes from.
ARG PLAYWRIGHT_VERSION=1.63.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
    && npm cache clean --force \
    && chromium --headless=new --no-sandbox --disable-gpu --version
ENV CHROMIUM_BIN=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/usr/local/lib/node_modules

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

# ship-acp, the in-sandbox ACP driver (E7 H3, src/harness-acp.ts): one
# dependency-free node script baked verbatim from images/acp-driver/. It is
# here regardless of which harnesses were declared — the ACP adapters are
# registered on every worker, and the driver is what turns their one
# stdin-less exec into a whole ACP session.
COPY acp-driver/ship-acp.mjs /usr/local/bin/ship-acp
RUN chmod 0755 /usr/local/bin/ship-acp && ship-acp --version

# --- harness browser MCP server (SHIP_HARNESS_BROWSER) -----------------------
# A deliberately ISOLATED block (a separate lane is reworking the browser
# section above): the browser MCP server external harnesses get when
# SHIP_HARNESS_BROWSER=on (src/harness-browser.ts). @playwright/mcp, pinned in
# images/versions.json, installed WITHOUT a browser download — it attaches
# with --cdp-endpoint to the same per-run Chromium session the image's
# playwright already drives. No second Chromium, ever.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
    && npm cache clean --force \
    && playwright-mcp --version

WORKDIR /work
