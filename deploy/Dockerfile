# teploy-ship — one image, two roles:
#   docker run … teploy-ship web      (dashboard + webhook receiver)
#   docker run … teploy-ship worker   (executes durable runs)
# Built by deploy/build-image.sh (packs the local SDK tarballs first).
FROM node:22-slim

# git: repo runs clone/push inside this container (worker role, local
# executor path). ca-certificates for https remotes.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app

# SDK tarballs packed from the local Neutron checkout
COPY deploy/vendor/ vendor/

# ship runtime
COPY deploy/package.ship.json package.json
COPY dist/ dist/
RUN pnpm install --prod --no-lockfile

# web app runtime (the web command spawns `pnpm exec neutron-ts preview` here)
COPY deploy/package.web.json web/package.json
COPY web/dist/ web/dist/
# the app-mode preview server SSRs route modules from SOURCE at runtime
COPY web/src/ web/src/
COPY web/index.html web/tsconfig.json web/vite.config.ts web/neutron.config.ts web/
# npm here, not pnpm: pnpm 10 hard-fails on esbuild's postinstall in
# this layout; npm handles the file: tarballs + overrides and runs it.
RUN cd web && npm install --omit=dev --no-package-lock --no-audit --no-fund

ENV NODE_ENV=production
# durable state lives on a volume in file-store mode; nucleus mode needs none
ENV TEPLOY_SHIP_STATE=/data
VOLUME /data

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["web"]
