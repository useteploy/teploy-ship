# teploy-ship — one image, two roles:
#   docker run … teploy-ship web      (dashboard + webhook receiver)
#   docker run … teploy-ship worker   (executes durable runs)
# Built by deploy/build-image.sh.
#
# Pinned by digest, not by tag. `node:22-slim` moves, so two builds of the same
# commit produced different images and "what CI tested" was only loosely
# related to "what production runs". Refresh deliberately:
#   docker pull node:22-slim && docker images --digests node
FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

# git: repo runs clone/push inside this container (worker role, local
# executor path). ca-certificates for https remotes. curl only to fetch the
# teploy CLI below, then removed — it is not part of the runtime.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
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
# No openssh-client: the CLI speaks SSH through Go's crypto/ssh, not by
# shelling out. It does read ~/.ssh/known_hosts and fails closed when it cannot,
# so mount one.
#
# Needs >= v0.1.27, the first release carrying `teploy build`. Before that the
# only way to produce a runnable image was `teploy deploy`, which replaces
# production — exactly what a preview must not do.
ARG TEPLOY_VERSION=0.1.27
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=amd64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/useteploy/teploy-cli/releases/download/v${TEPLOY_VERSION}"; \
    cd /tmp; \
    curl -fsSL -o teploy.tar.gz "${base}/teploy_linux_${arch}.tar.gz"; \
    curl -fsSL -o checksums.txt "${base}/checksums.txt"; \
    # Verify before extracting, not after — the CLI's own install docs were
    # changed to do this for the same reason (26dab76).
    grep " teploy_linux_${arch}.tar.gz\$" checksums.txt | sed "s|  .*|  teploy.tar.gz|" | sha256sum -c -; \
    tar -xzf teploy.tar.gz teploy; \
    install -m 0755 teploy /usr/local/bin/teploy; \
    rm -f teploy.tar.gz checksums.txt teploy; \
    # Prove the binary runs here rather than discovering it at deploy time —
    # a release binary that could not start inside a slim base is a mistake
    # this stack has shipped before.
    teploy version; \
    apt-get purge -y --auto-remove curl

WORKDIR /app

# ship runtime. deploy/package.ship.json pins EXACT versions (no ^ ranges), so
# this install resolves the same tree every time even without a lockfile —
# which is what the vendored @neutron-build tarballs make awkward to carry.
COPY deploy/package.ship.json package.json
COPY dist/ dist/
RUN pnpm install --prod --no-lockfile

# web app runtime (the web command spawns `pnpm exec neutron-ts preview` here)
COPY deploy/package.web.json web/package.json
COPY web/dist/ web/dist/
# the app-mode preview server SSRs route modules from SOURCE at runtime
COPY web/src/ web/src/
COPY web/index.html web/tsconfig.json web/vite.config.ts web/neutron.config.ts web/
# npm here, not pnpm: pnpm 10 hard-fails on esbuild's postinstall in this
# layout, while npm runs the required postinstall correctly.
RUN cd web && npm install --omit=dev --no-package-lock --no-audit --no-fund

ENV NODE_ENV=production
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
