# syntax=docker/dockerfile:1
#
# The Go sandbox image — what a repo run's container boots when the project's
# stack is Go. Build it with `images/build.sh go`, never by hand: the script
# reads images/versions.json, which is the single source of truth for the pins
# below and for which harness binaries get baked in.
#
# This file exists because the image it replaces did not. Until 2026-08-26 the
# production sandbox (`ship-sandbox-harness:dev`) was built from a Dockerfile
# that lived only in ~/ship-harness-sbx on deploy-test. If that box died, Ship
# could not run — there was nothing to rebuild from.
#
# The ARG defaults below duplicate images/versions.json so that a plain
# `docker build` still works and so a reader sees the pin without opening
# another file. build.sh asserts the two agree and refuses to build otherwise,
# so the duplication cannot rot. One caveat since the ACP driver landed: the
# build CONTEXT is the images/ directory (every image COPYies
# acp-driver/ship-acp.mjs, which a stack-subdir context cannot reach), so a
# hand build is `docker build -f images/sandbox-go/Dockerfile images/` — not
# `docker build images/sandbox-go`, which stopped working the day the driver
# was added. Prefer images/build.sh.

ARG NODE_BASE=node:22-trixie@sha256:2082d2bf902c8835655c6bcfee3594c00ea900498a9f6e2b96d3352536f9e8d8
ARG GO_BASE=golang:1.27.3-trixie@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385

FROM ${NODE_BASE} AS nodejs

# Go 1.25 or newer, deliberately NOT 1.24. Three repos need 1.25, and on a 1.24 sandbox
# every Go pull request arrived marked `tests: failed` on 2026-08-26 — a
# base-image mismatch that reviewers read as the agent's fault (the incident
# src/tests.ts:preExisting was written for). Do not pin this back.
# Go 1.27 since 2026-10-30: GOTOOLCHAIN=local means a `go 1.26` module cannot
# fetch its toolchain, and six of the projects Ship works on declare 1.26.
FROM ${GO_BASE}

# Node comes from the pinned official node image, not from NodeSource's
# `setup_22.x`. The old hand-built image piped that installer into bash at
# build time, which meant (a) whatever 22.x npm happened to serve that day and
# (b) a build that fails when deb.nodesource.com does. A digest-pinned COPY is
# reproducible and needs no third-party apt repo.
#
# Both bases are Debian 13 (trixie), so this is a same-glibc copy, not a
# forward-compatibility bet.
COPY --from=nodejs /usr/local/bin/node /usr/local/bin/node
COPY --from=nodejs /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN set -eux; \
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    node -v; npm -v

# ca-certificates + git: the run clones inside this container. python3: repos
# whose suites shell out to it. curl: the same, and harness installers.
# python3-pytest: test detection (src/tests.ts) turns a root pytest.ini,
# conftest.py, tox.ini or [tool.pytest] into `python3 -m pytest -q`, and an
# image without pytest made that promise unrunnable (fresh-machine F10).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-pytest \
    && rm -rf /var/lib/apt/lists/*

# The declared harnesses, BAKED — never installed at run time.
#
# Two reasons run-time installation is the wrong answer, both structural:
#   1. It needs the sandbox to reach npm, i.e. the egress hole the default-deny
#      sandbox design exists to close (docs/DEPLOY.md, "Sandbox").
#   2. selectAdapter (src/harness.ts) refuses to replay a run under a harness
#      version other than the one its log recorded. A binary resolved at run
#      time drifts under a running worker, and drift breaks replay.
#
# HARNESS_SPECS is a space-separated list of exact npm specs ("pkg@1.2.3"),
# HARNESS_BINARIES the executables they must put on PATH. build.sh derives both
# from images/versions.json; empty means a plain Go sandbox for native runs.
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
    # Prove every declared binary is here and runnable NOW rather than
    # discovering it as a failed `harness-preflight` step on a real run.
    for b in ${HARNESS_BINARIES}; do command -v "$b"; "$b" --version; done

# What this image carries, readable with `docker image inspect`. A worker that
# cannot explain which program edited a tree is not auditable.
ARG HARNESS_LABEL=""
LABEL io.teploy.ship.stack="go" \
      io.teploy.ship.harnesses="${HARNESS_LABEL}"

# ship-acp, the in-sandbox ACP driver (E7 H3, src/harness-acp.ts): one
# dependency-free node script baked verbatim from images/acp-driver/. It is
# here regardless of which harnesses were declared — the ACP adapters are
# registered on every worker, and the driver is what turns their one
# stdin-less exec into a whole ACP session.
COPY acp-driver/ship-acp.mjs /usr/local/bin/ship-acp
RUN chmod 0755 /usr/local/bin/ship-acp && ship-acp --version

# ship-browser, the acting half of the ```look session (S12, src/look.ts):
# a tiny dependency-free module baked verbatim from images/browser-helper/
# that agent code imports (by absolute path) to drive the SAME browser
# session ```look observes — page() joins the session, byRef() turns a
# snapshot's [ref=eN] into a Playwright locator. It sits in /usr/local/lib
# so its own bare playwright import resolves against the global install
# above, with no node_modules symlink. The import probe proves the baked
# copy parses and exports page/byRef — and that importing it needs no
# browser and no network.
COPY browser-helper/ship-browser.mjs /usr/local/lib/ship-browser.mjs
RUN node -e 'import("/usr/local/lib/ship-browser.mjs").then((m) => { if (typeof m.page !== "function" || typeof m.byRef !== "function") throw new Error("ship-browser.mjs lost its exports"); })'

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
