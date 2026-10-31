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
# another file. build.sh asserts the two agree and refuses to build otherwise,
# so the duplication cannot rot. One caveat since the ACP driver landed: the
# build CONTEXT is the images/ directory (every image COPYies
# acp-driver/ship-acp.mjs, which a stack-subdir context cannot reach), so a
# hand build is `docker build -f images/sandbox-rust/Dockerfile images/` —
# not `docker build images/sandbox-rust`. Prefer images/build.sh.

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
# sudo: the sandbox user's way to root (after the toolchain, below).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 gcc pkg-config libssl-dev sudo \
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

# The sandbox user. teploy-sandbox runs every run as `ship` (uid 1000) unless
# the project opts into root (`teploy-ship project set <repo> --sandbox-user
# root`), the way GitHub Actions runners and devcontainers work: a suite whose
# permission tests root would ignore (chmod 000, then expect EACCES) behaves,
# and root is one passwordless `sudo` away. No USER line: the daemon picks the
# user per run (`docker run --user`), and anything else that boots this image
# keeps getting root exactly as before. /work is handed to the user here and
# again by the daemon at create (warm volumes land as root).
# `!fqdn`: without it sudo resolves the container's hostname on every call and,
# on the default network-less tier, prints "unable to resolve host" each time.
#
# CARGO_HOME (/usr/local/cargo: the registry and git checkouts a run fetches)
# and RUSTUP_HOME belong to the user. After the component install above, so
# those files are handed over too.
RUN set -eux; \
    groupadd --gid 1000 ship; \
    useradd --uid 1000 --gid 1000 --create-home --home-dir /home/ship --shell /bin/bash ship; \
    printf 'Defaults !fqdn\nship ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/ship; \
    chmod 0440 /etc/sudoers.d/ship; \
    visudo -cf /etc/sudoers.d/ship; \
    mkdir -p /work; \
    chown -R ship:ship /work "${CARGO_HOME}" "${RUSTUP_HOME}"; \
    runuser -u ship -- sh -c 'test -w "$CARGO_HOME" && sudo -n true && cargo --version'

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

# ship-acp, the in-sandbox ACP driver (E7 H3, src/harness-acp.ts): one
# dependency-free node script baked verbatim from images/acp-driver/. It is
# here regardless of which harnesses were declared — the ACP adapters are
# registered on every worker, and the driver is what turns their one
# stdin-less exec into a whole ACP session.
COPY acp-driver/ship-acp.mjs /usr/local/bin/ship-acp
RUN chmod 0755 /usr/local/bin/ship-acp && ship-acp --version

WORKDIR /work
