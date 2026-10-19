# teploy-ship — one image, two roles:
#   docker run … teploy-ship web      (dashboard + webhook receiver)
#   docker run … teploy-ship worker   (executes durable runs)
# Built by deploy/build-image.sh.
#
# The teploy CLI, built from a pinned SOURCE COMMIT (see the runtime stage for
# why the image carries it at all).
#
# Why source, not the release download this used to be: the tailnet preview
# mode (the 2026-09-24 preview ruling — `preview deploy --base-domain/--http-only/
# --allow-ip`, advertised as the `preview-exposure` capability) landed in
# teploy-cli de73a22, and no release carries it yet (latest v0.1.37). Ship
# refuses a tailnet preview on a CLI without the capability, so a release pin
# would leave SHIP_PREVIEW_TAILNET_IP unusable. Cutting a CLI release is the
# owner's call, not a Ship deploy's — so the pin is a full commit SHA on the
# public GitHub main, which is as content-addressed as a checksum, and the
# build proves the capability before the image can exist.
#
# Go back to the checksum-verified release download (git history of this
# file, pre-L8) once a release at or after TEPLOY_COMMIT exists.
FROM golang:1.26-bookworm@sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d AS teploy-cli
ARG TEPLOY_COMMIT=2041c615a8a467ef9173d9ba8698a0d73e80a26a
ARG TEPLOY_VERSION_LABEL=0.1.37-next.2041c61
RUN set -eux; \
    git clone --quiet --filter=blob:none --no-checkout https://github.com/useteploy/teploy-cli /src; \
    cd /src; \
    git checkout --quiet --detach "${TEPLOY_COMMIT}"; \
    test "$(git rev-parse HEAD)" = "${TEPLOY_COMMIT}"; \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${TEPLOY_VERSION_LABEL}" -o /out/teploy ./cmd/teploy; \
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
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build \
  && test -f dist/cli.js \
  && test -f dist/worker.js

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
# `preview-exposure` capability — which is why it is built from source in the
# `teploy-cli` stage above rather than downloaded from a release.
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

ENV NODE_ENV=production
ENV SHIP_WEB_HOST=0.0.0.0
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
