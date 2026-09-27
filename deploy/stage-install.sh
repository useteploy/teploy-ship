#!/usr/bin/env bash
# Stage the minimal deployment and only the image's runtime build inputs.
set -euo pipefail
source_dir=${1:?source checkout required}
stage_dir=${2:?empty staging directory required}
[[ -d "$stage_dir" && -z "$(ls -A "$stage_dir")" ]] || { echo 'Staging directory must be empty' >&2; exit 1; }
cp "$source_dir/teploy.example.yml" "$stage_dir/teploy.yml"
cp "$source_dir/teploy.install.yml" "$stage_dir/teploy.install.yml"
cp "$source_dir/Dockerfile" "$source_dir/.teployignore" "$stage_dir/"
cp -R "$source_dir/deploy" "$source_dir/dist" "$stage_dir/"
mkdir "$stage_dir/web"
cp -R "$source_dir/web/dist" "$source_dir/web/src" "$stage_dir/web/"
for file in index.html tsconfig.json vite.config.ts neutron.config.ts; do
  cp "$source_dir/web/$file" "$stage_dir/web/"
done
