# teploy-ship — one image, two roles:
#   docker run … teploy-ship web      (dashboard + webhook receiver)
#   docker run … teploy-ship worker   (executes durable runs)
# Built by deploy/build-image.sh.
#
# The teploy CLI, from a checksum-pinned RELEASE (see the runtime stage for
# why the image carries it at all).
#
# 2026-09-24 to 2026-11: this stage built the CLI from a pinned source commit
# (de73a22's tailnet preview mode — `preview deploy --base-domain/--http-only/
# --allow-ip`, the `preview-exposure` capability — was in no release yet).
# v0.1.55 carries it, so the image is back on the release download. The
# sha256 of each archive is pinned HERE, not read from the release's own
# checksums.txt: a checksum fetched from the same place as the archive proves
# only that the download was not truncated. To bump: take the two
# teploy_linux_*.tar.gz lines from the new release's checksums.txt.
# Ship's argv against the CLI (build, preview deploy/list/destroy, deploy,
# rollback, status, version --json) was checked against v0.1.55's flags.
# Same pinned base as the other stages (a Debian bookworm slim), so no new
# digest enters the build; curl is installed in this throwaway stage only.
FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS teploy-cli
ARG TEPLOY_VERSION=0.1.55
ARG TEPLOY_SHA256_AMD64=fbcb8cb5378c163b50c539452025fb3ce58b41d403d6dc2f6be537be41dbee39
ARG TEPLOY_SHA256_ARM64=48d83c2e38921f20dd4245d23778fe00ad5c830d6963268dc976ab6d97c127ff
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=amd64; sum="${TEPLOY_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${TEPLOY_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o teploy.tar.gz "https://github.com/useteploy/teploy-cli/releases/download/v${TEPLOY_VERSION}/teploy_linux_${arch}.tar.gz"; \
    # Verify before extracting, not after.
    echo "${sum}  teploy.tar.gz" | sha256sum -c -; \
    tar -xzf teploy.tar.gz teploy; \
    install -D -m 0755 teploy /out/teploy; \
    /out/teploy version --json | grep -q "\"version\":\"${TEPLOY_VERSION}\""; \
    /out/teploy version --json | grep -q '"preview-exposure"'

# ---------------------------------------------------------------------------
# Builder: compile dist/ and web/dist/ from the source in this build context.
#
# 2026-10-18 incident: the runtime stage used to COPY a locally pre-built
# dist/ and web/dist/, and nothing tied those outputs to the source beside
# them. Four production deploys in a row shipped a dist built hours earlier
# while the image label carried the new git revision, so merged features were
# silently absent and post-deploy smoke tests passed against old code. A
# builder stage makes the correspondence structural: the only dist/ that can
# reach the runtime stage is the one compiled here, from these files, by the
# same commands CI runs (`pnpm run build`, then the web build). A stale
# dist/ on the host cannot enter the image even accidentally — .dockerignore
# keeps it out of the context entirely.
#
# Same pinned digest as the runtime stage, for the same reason.
FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS builder

# pnpm pinned through corepack, exactly like images/sandbox-node: an exact
# version means the lockfile resolves the same way in the image as on a
# developer's machine. pnpm (not npm) because the patches in
# pnpm.patchedDependencies and the lockfile's patch hash are pnpm concepts;
# npm would silently install the unpatched SDK the suites never tested.
ARG PNPM_VERSION=10.26.1
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate && pnpm -v

WORKDIR /app

# Manifests and patches first, so the two dependency installs cache on their
# own layers and a source edit does not re-resolve anything.
COPY package.json pnpm-lock.yaml ./
COPY patches/ patches/
RUN pnpm install --frozen-lockfile
COPY web/package.json web/pnpm-lock.yaml web/
# web depends on the root package through `link:..`, so its install must come
# after the root one; the link is what makes the web build resolve
# teploy-ship's exports (the root dist/ built below).
RUN pnpm --dir web install --frozen-lockfile

# The CLI: same command CI runs, `tsc` against the copied src/ and tsconfig.
#
# Then dist/VERSION, the one place the running version is read from
# (src/version.ts: /health, the discovery document, `teploy-ship --version`).
# The release workflow and deploy/build-image.sh pass SHIP_VERSION; a source
# build through `teploy deploy` cannot pass a build arg, and .git never enters
# the build context, so it falls back to package.json's version — real code,
# not "dev" (SHIP-05: every published image up to 0.5.0 reported "dev").
COPY tsconfig.json ./
COPY src/ src/
ARG SHIP_VERSION=""
RUN pnpm run build \
  && test -f dist/cli.js \
  && test -f dist/worker.js \
  && node -e 'const v = (process.env.SHIP_VERSION || "").trim(); const out = v !== "" && v !== "dev" ? v.replace(/^v(?=[0-9])/, "") : require("./package.json").version; require("fs").writeFileSync("dist/VERSION", out + "\n"); console.log("ship version: " + out)' \
  && test -s dist/VERSION

# The web app: `neutron-ts build` per web/package.json (which also drops
# dist/index.html — the runtime stage ships web/index.html from source for the
# preview server). Needs no env: neutron.config.ts reads host/port at run
# time, not build time. Depends on the root dist/ through the link above.
COPY web/index.html web/tsconfig.json web/vite.config.ts web/neutron.config.ts web/
COPY web/public/ web/public/
COPY web/src/ web/src/
RUN cd web && pnpm run build && test -d dist/assets

# ---------------------------------------------------------------------------
# Runtime. Pinned by digest, not by tag. `node:22-slim` moves, so two builds
# of the same commit produced different images and "what CI tested" was only
# loosely related to "what production runs". Refresh deliberately:
#   docker pull node:22-slim && docker images --digests node
FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

# Sibling identity (Programme B, plan DASH_AUTOCONFIG 10.1): Teploy Dash finds
# candidate instances by this label, then confirms them with
# GET /.well-known/teploy.json before doing anything. The teploy-cli builder
# stage above does not need it — only the image a fleet can see does.
LABEL dev.teploy.product=ship

# git: repo runs clone/push inside this container (worker role, local
# executor path). ca-certificates for https remotes. rsync + openssh-client:
# `teploy build` syncs the build context through a LOCAL rsync that shells
# out to `ssh` for its transport (the CLI's own SSH is Go-native, but the
# rsync path is not), so the worker role needs both for preview deploys and
# delivery execution (found live 2026-09-22: the shipped CLI could not build
# from inside the image).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates rsync openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# The teploy CLI, for the preview-deploy step.
#
# Without this the image can do everything EXCEPT put a fix on a URL: the
# preview step shells out to `teploy build` and `teploy preview deploy`, and a
# worker that cannot find the binary records the step as disabled. That made
# every preview a source-built-CLI-on-a-laptop affair, which is not a product.
#
# It runs on the WORKER, deliberately, and never in the agent's sandbox: it
# holds the credentials that reach your servers, and the sandbox executes
# model-authored commands. Two more things must be mounted for a preview to
# actually happen — a clone of the repo being fixed at SHIP_PREVIEW_DIR, and an
# SSH key plus known_hosts for the deploy target. Neither belongs in an image.
#
# The CLI speaks SSH through Go's crypto/ssh for its own connections, but
# `teploy build`'s rsync transport shells out to `ssh` — hence the
# openssh-client in the apt list above. It reads ~/.ssh/known_hosts either
# way and fails closed when it cannot, so mount one.
#
# Needs >= v0.1.36 (host-bind volume keys for the delivery-copy mounts, the
# known_hosts mismatch diagnostics) and, for tailnet previews, the
# `preview-exposure` capability — the `teploy-cli` stage above refuses a
# binary without it.
COPY --from=teploy-cli /out/teploy /usr/local/bin/teploy
# Prove the binary runs here rather than discovering it at deploy time — a
# binary that could not start inside a slim base is a mistake this stack has
# shipped before.
RUN teploy version --json

WORKDIR /app

# Production lockfiles freeze transitive dependencies as well as direct pins.
# Keep both deployment manifests aligned with the versions tested locally.
COPY deploy/package.ship.json package.json
COPY deploy/package-lock.ship.json package-lock.json
# Compiled by the builder stage above from the src/ in this same build
# context — never from a dist/ built on the host before `teploy deploy`.
COPY --from=builder /app/dist/ dist/
RUN npm ci --omit=dev --no-audit --no-fund
# The patches pnpm applies locally (package.json pnpm.patchedDependencies).
# npm ci does not read them, so without this step the image would run the
# unpatched SDK the suites never tested: @neutron-build/agents' sandbox exec
# would drop per-exec env, and every credential that travels by exec env
# (SHIP_GIT_CREDENTIAL=env) would silently arrive empty.
COPY patches/@neutron-build__agents.patch /tmp/agents.patch
RUN cd node_modules/@neutron-build/agents && git apply /tmp/agents.patch && rm /tmp/agents.patch

# web app runtime (the web command spawns `pnpm exec neutron-ts preview` here)
COPY deploy/package.web.json web/package.json
COPY deploy/package-lock.web.json web/package-lock.json
# Built by the builder stage from web/src/ in this build context.
COPY --from=builder /app/web/dist/ web/dist/
# the app-mode preview server SSRs route modules from SOURCE at runtime
COPY web/src/ web/src/
COPY web/index.html web/tsconfig.json web/vite.config.ts web/neutron.config.ts web/
# npm here, not pnpm: pnpm 10 hard-fails on esbuild's postinstall in this
# layout, while npm runs the required postinstall correctly.
RUN cd web && npm ci --omit=dev --no-audit --no-fund
# neutron-ts 0.5 also emits a server bundle (dist/server/start + its manifest)
# whose externals are symlinks into the BUILDER's pnpm store
# (node_modules/.pnpm/...). This stage installs with npm, so every link dangles
# and preview dies at boot with ERR_MODULE_NOT_FOUND. Without the manifest,
# preview SSRs route modules from web/src through Vite against this npm tree,
# exactly as it did on core 0.3.2.
RUN rm -rf web/dist/.neutron-server-bundle.json web/dist/server

ENV NODE_ENV=production
ENV SHIP_WEB_HOST=0.0.0.0
# No ENV SHIP_VERSION: the version is dist/VERSION, written by the builder
# stage (an env var set here would shadow it, and used to say "dev"). Prove
# the CLI reads it before the image can exist.
RUN node dist/cli.js --version
# durable state lives on a volume in file-store mode; nucleus mode needs none
ENV TEPLOY_SHIP_STATE=/data
VOLUME /data

# Drop root.
#
# The web process, the worker, and the local-executor path all ran as uid 0
# inside the container — so a web-route bug, or an agent command doing more
# than intended, did so with every capability the container had. `node` (uid
# 1000) ships with the base image and owns nothing it does not need.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["web"]
