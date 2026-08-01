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
# executor path). ca-certificates for https remotes.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

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
