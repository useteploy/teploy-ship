# syntax=docker/dockerfile:1
#
# The Rust sandbox image — what a repo run's container boots when the project's
# stack is Rust (Nucleus, in Neutron). Build it with `images/build.sh rust`,
# never by hand: the script reads images/versions.json, the single source of
# truth for the pins below and for which harness binaries get baked in.
#
# NOT the worker default. SHIP_SANDBOX_IMAGE stays on the Go image; a Rust
# project names this one on its project record (`teploy-ship project set <repo>
# --image ship-sandbox-rust:dev`, docs/DEPLOY.md "Sandbox"). A 347k-line crate
# tree is a 30-60 minute cold build on one CPU, so the same record should also
# carry --memory-mb / --cpus / --test-command / --test-timeout-ms sized for it.
#
# The ARG defaults below duplicate images/versions.json so that a plain
# `docker build` still works and so a reader sees the pin without opening
# another file. build.sh asserts the two agree and refuses to build otherwise.

ARG NODE_BASE=node:22-trixie@sha256:2082d2bf902c8835655c6bcfee3594c00ea900498a9f6e2b96d3352536f9e8d8
ARG RUST_BASE=rust:1-trixie

FROM ${NODE_BASE} AS nodejs

# rust:1-trixie carries cargo, rustc and rustup on Debian 13 — the same glibc
# as the node image, so the COPY below is a same-libc copy, not a bet. The tag
# is a moving major (1.x) on purpose: Nucleus's own CI tracks stable, and a
# digest pin here would need bumping every six weeks to keep up with the
# repo's MSRV. Record the resolved version from the image label if that ever
# matters for a replay.
FROM ${RUST_BASE}

COPY --from=nodejs /usr/local/bin/node /usr/local/bin/node
COPY --from=nodejs /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN set -eux; \
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    node -v; npm -v

# ca-certificates + git: the run clones inside this container. python3 and
# gcc/pkg-config: build scripts and -sys crates. curl: harness installers.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 gcc pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# rustfmt + clippy: nucleus/CLAUDE.md's gate is `cargo build && cargo test --lib
# && cargo clippy`, and a sandbox without clippy reports a green gate that
# never ran the third leg.
RUN set -eux; rustup component add rustfmt clippy; cargo --version; rustc --version; cargo clippy --version

# A login shell (`bash -l`, `sh -l`) re-reads /etc/profile and replaces PATH
# with the Debian default, which drops /usr/local/cargo/bin: cargo vanishes
# for exactly the invocation a harness or a person is most likely to use
# when "the plain one" fails. Put the toolchain on PATH for login shells too.
RUN printf 'export PATH=/usr/local/cargo/bin:$PATH\n' > /etc/profile.d/cargo.sh

# Pre-warming the registry is deliberately NOT done here. A cold `cargo test`
# over ~650 crates spends its first minutes on the index and downloads, but a
# baked registry is a snapshot of one repo's Cargo.lock inside an image every
# Rust project shares, and it goes stale the first time that lock moves. The
# supported answer is the worker's warm repo cache (SHIP_WARM_CACHE,
# docs/DEPLOY.md), which keeps the workspace — target/ included — between
# runs of the SAME repo, plus the project's egress allowlist admitting
# crates.io, static.crates.io and index.crates.io so every run can fetch. The
# registry itself lives in CARGO_HOME (/usr/local/cargo), outside the
# workspace, and is re-fetched per run; moving it under /work would put it in
# the tree `git add -A` stages, which is worse than the download.

# The declared harnesses, BAKED — never installed at run time (see
# sandbox-go/Dockerfile for the two structural reasons).
ARG HARNESS_SPECS=""
ARG HARNESS_BINARIES=""
RUN set -eux; \
    if [ -n "${HARNESS_SPECS}" ]; then \
      npm install -g ${HARNESS_SPECS}; \
      npm cache clean --force; \
    fi; \
    for b in ${HARNESS_BINARIES}; do command -v "$b"; "$b" --version; done

ARG HARNESS_LABEL=""
LABEL io.teploy.ship.stack="rust" \
      io.teploy.ship.harnesses="${HARNESS_LABEL}"

WORKDIR /work
