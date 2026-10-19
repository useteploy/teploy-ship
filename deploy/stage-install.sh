#!/usr/bin/env bash
# Stage the minimal deployment and only the image's build inputs.
#
# Source, not build output (2026-10-18): the Dockerfile's builder stage
# compiles dist/ and web/dist/ from what this script stages, so a dist/
# built hours before the deploy can no longer ship under the new
# revision's label. Staged inputs must satisfy every host-path COPY in the
# Dockerfile — scripts/install-stage.test.mjs enforces exactly that.
set -euo pipefail
source_dir=${1:?source checkout required}
stage_dir=${2:?empty staging directory required}
[[ -d "$stage_dir" && -z "$(ls -A "$stage_dir")" ]] || { echo 'Staging directory must be empty' >&2; exit 1; }
cp "$source_dir/teploy.example.yml" "$stage_dir/teploy.yml"
cp "$source_dir/teploy.install.yml" "$stage_dir/teploy.install.yml"
cp "$source_dir/Dockerfile" "$source_dir/.teployignore" "$source_dir/.dockerignore" "$stage_dir/"
# What the builder stage compiles from: manifests, lockfiles, patches,
# tsconfig and the full source of both trees.
cp "$source_dir/package.json" "$source_dir/pnpm-lock.yaml" "$source_dir/tsconfig.json" "$stage_dir/"
cp -R "$source_dir/deploy" "$source_dir/patches" "$source_dir/src" "$stage_dir/"
mkdir "$stage_dir/web"
cp "$source_dir/web/package.json" "$source_dir/web/pnpm-lock.yaml" "$stage_dir/web/"
cp -R "$source_dir/web/src" "$source_dir/web/public" "$stage_dir/web/"
for file in index.html tsconfig.json vite.config.ts neutron.config.ts; do
  cp "$source_dir/web/$file" "$stage_dir/web/"
done
