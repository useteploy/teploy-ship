#!/usr/bin/env bash
# Teploy Ship — clean VM to a working Ship, one command.
#
#   ./install.sh --host 203.0.113.10 --user root mybox
#
# In order: provisions the server (teploy setup), collects secrets — generating
# the ones it can, asking for the two it cannot — and deploys Ship with a
# PostgreSQL store, whose image compiles from this directory on the server (no
# local Node/pnpm build; a git clone or an unpacked release tarball both work).
# Sandbox images are built only when a daemon is installed. See QUICKSTART
# for measured timings; the latest minimal path still needs a clean timed pass.
#
# TRUST MODEL without a sandbox daemon (the default): agent commands run
# INSIDE the worker container, as the worker's own user, next to every secret
# the worker holds (git token, model key, database password). Ship refuses
# tasks from webhooks/Slack/issues there, but a task YOU type still reads
# repository content and web pages a prompt injection could hide in. Install
# teploy-sandbox (docs/DEPLOY.md section 3) before trusting it with more.
#
# Moving to a SECOND host — the thing that was impossible before this script,
# because Ship's secrets lived only in teploy's age store on one server and
# there was no way to read them back out:
#
#   ./install.sh --export-secrets ship.env --host <old-ip> --user <u> oldbox
#   ./install.sh --secrets-file  ship.env --host <new-ip> --user <u> newbox
#
# The bundle is a plain env file with real values in it. It is chmod 600 and
# gitignored, and it is yours to delete once the new box is up. Nothing else in
# this repo ever writes a secret to disk.
#
# --export-secrets writes a COMPLETE worker environment: the secret store plus
# the non-secret settings read back off the running worker container, because a
# bundle of secrets alone was never startable (NUCLEUS_URL and friends live in
# teploy.yml, not in the secret store). That is what makes the second command
# below possible — a box that joins an EXISTING fleet as another worker rather
# than standing up a whole second Ship:
#
#   teploy-ship join http://<old-ip>:7460 --secrets ship.env \
#     --nucleus-url postgres://ship@<old-ip>:5432/ship --start
#
# (NUCLEUS_URL is the store URL's historical name; it names the PostgreSQL
# store too. The password travels as PGPASSWORD in the bundle.)
#
# Options:
#   --host <addr>            server address (required)
#   --user <name>            ssh user (default: root)
#   --secrets-file <path>    read/write the secret bundle (default: ./ship-secrets.env)
#   --export-secrets <path>  read every secret off the server, write the bundle,
#                            and STOP. Nothing is built and nothing is deployed.
#   --git-token <t>          forge deploy token       (or $SHIP_GIT_TOKEN)
#   --github-token <t>       github PAT               (or $SHIP_GITHUB_TOKEN)
#   --anthropic-key <k>      model key                (or $ANTHROPIC_API_KEY)
#   --model-url <url>        an Anthropic-COMPATIBLE endpoint instead of
#                            Anthropic (e.g. https://api.z.ai/api/anthropic);
#                            the key becomes AI_GATEWAY_KEY and --model is
#                            sent verbatim (e.g. --model glm-5.3)
#   --allow <origins>        SHIP_REPO_ALLOWLIST, comma separated
#   --model <id>             SHIP_MODEL (default anthropic/claude-sonnet-5)
#   --skip-images            do not build the sandbox images
#   --skip-setup             the server is already provisioned for teploy
#   --yes                    never prompt; fail instead
#
# Ship on Nucleus is no longer installed by this script (production left it
# on 2026-10-14). An existing Nucleus install is detected and left alone:
# docs/MIGRATE_STORE.md moves it, or keep deploying it by hand (the Nucleus
# block in teploy.example.yml).
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd -P)"
cd "${repo}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\ninstall.sh: %s\n' "$*" >&2; exit 1; }

server=""
host=""
ssh_user="root"
secrets_file="${repo}/ship-secrets.env"
export_only=""
git_token="${SHIP_GIT_TOKEN:-}"
github_token="${SHIP_GITHUB_TOKEN:-}"
model_key="${ANTHROPIC_API_KEY:-}"
model_url=""
allowlist="${SHIP_REPO_ALLOWLIST:-}"
model="${SHIP_MODEL:-anthropic/claude-sonnet-5}"
skip_images=0
skip_setup=0
assume_yes=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="${2:?--host needs a value}"; shift 2 ;;
    --user) ssh_user="${2:?--user needs a value}"; shift 2 ;;
    --secrets-file) secrets_file="${2:?}"; shift 2 ;;
    --export-secrets) export_only="${2:?}"; shift 2 ;;
    --git-token) git_token="${2:?}"; shift 2 ;;
    --github-token) github_token="${2:?}"; shift 2 ;;
    --anthropic-key) model_key="${2:?}"; shift 2 ;;
    --model-url) model_url="${2:?}"; shift 2 ;;
    --allow) allowlist="${2:?}"; shift 2 ;;
    --model) model="${2:?}"; shift 2 ;;
    --skip-images) skip_images=1; shift ;;
    --skip-setup) skip_setup=1; shift ;;
    -y|--yes) assume_yes=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) server="$1"; shift ;;
  esac
done
[ -n "${server}" ] || die "name the server: ./install.sh --host <addr> --user <user> <name>"
[ -n "${host}" ] || die "--host <addr> is required"

for tool in teploy ssh openssl; do
  command -v "${tool}" >/dev/null 2>&1 || die "${tool} is not on PATH (teploy: brew install useteploy/tap/teploy)"
done

# teploy's global --host/--user override servers.yml, so every call below names
# the target without this script ever editing a tracked config file.
install_stage=""
tp() {
  if [ -n "${install_stage}" ]; then
    teploy --project-dir "${install_stage}" --host "${host}" --user "${ssh_user}" "$@"
  else
    teploy --host "${host}" --user "${ssh_user}" "$@"
  fi
}
remote() { ssh -o BatchMode=yes "${ssh_user}@${host}" "$@"; }

# --------------------------------------------------------------------------
# Secrets.
#
# The bundle is the whole portability story. Ship's secrets live in teploy's
# age store ON THE SERVER — `teploy secret list` opens an ssh connection to
# read them — so an install had exactly one copy of its own credentials and no
# way to stand up a second host from them. Everything below is
# generate-or-accept; the only two values a human must supply are the two only
# they can have.
#
# Bash 3.2 is what /bin/bash is on macOS, so: no associative arrays. Secrets
# are "KEY=VALUE" strings in a plain array.
# --------------------------------------------------------------------------
secrets=()

sec_get() {
  local prefix="$1="
  local entry
  for entry in ${secrets[@]+"${secrets[@]}"}; do
    case "${entry}" in "${prefix}"*) printf '%s' "${entry#"${prefix}"}"; return 0 ;; esac
  done
  return 1
}

sec_put() {
  local key="$1" value="$2" out=() entry
  for entry in ${secrets[@]+"${secrets[@]}"}; do
    case "${entry}" in "${key}="*) ;; *) out+=("${entry}") ;; esac
  done
  out+=("${key}=${value}")
  secrets=(${out[@]+"${out[@]}"})
}

# Read every secret off the target server into a bundle file, then stop.
if [ -n "${export_only}" ]; then
  say "reading secrets from ${host}"
  umask 077
  {
    echo "# Teploy Ship secrets exported from ${host} on $(date -u +%Y-%m-%dT%H:%M:%SZ)."
    echo "# REAL VALUES. chmod 600. Delete once the new host is up."
  } > "${export_only}"
  keys="$(tp secret list | sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p')"
  [ -n "${keys}" ] || die "no secrets found on ${host} — is that the right server?"
  for key in ${keys}; do
    printf '%s=%s\n' "${key}" "$(tp secret get "${key}" | tail -n 1)" >> "${export_only}"
    note "${key}"
  done

  # The NON-secret half of the worker's environment.
  #
  # `teploy secret list` holds credentials only, so a bundle of secrets alone
  # was never a startable configuration: NUCLEUS_URL, AI_GATEWAY_URL, SHIP_MODEL
  # and SHIP_REPO_ALLOWLIST all live in teploy.yml's env block and reach the
  # container that way. `teploy-ship join` needs the whole environment or it
  # cannot verify anything, so read it back off the running worker — which is
  # also the only copy that reflects what the box is ACTUALLY running, rather
  # than what a tracked yml says it should be.
  #
  # Read from the container rather than from teploy.yml on purpose: a value
  # edited on the server, or defaulted by a deploy overlay, is in one place and
  # it is here.
  say "reading the worker's environment from ${host}"
  worker="$(remote 'docker ps --format "{{.Names}}" | grep "^ship-worker-" | head -n 1' || true)"
  if [ -z "${worker}" ]; then
    note "no ship-worker container is running — the bundle carries secrets only."
    note "teploy-ship join will tell you exactly which settings are missing."
  else
    {
      echo ""
      echo "# Non-secret worker settings, read from container ${worker}."
      echo "# NUCLEUS_URL below (the store URL, PostgreSQL or Nucleus) is almost"
      echo "# certainly a docker network alias, which only THIS box can resolve."
      echo "# teploy-ship join refuses it and says so; pass --nucleus-url with the"
      echo "# controller's tailnet address."
    } >> "${export_only}"
    # Only the families Ship reads. A blanket dump would carry PATH, NODE_VERSION
    # and the container's own TEPLOY_SHIP_STATE=/data into a bundle that is then
    # sourced on a host where none of them are true.
    remote "docker inspect '${worker}' --format '{{range .Config.Env}}{{println .}}{{end}}'" \
      | grep -E '^(NUCLEUS_URL|AI_GATEWAY_URL|OBSERVE_[A-Z_]*|SHIP_[A-Z0-9_]*|ANTHROPIC_BASE_URL)=' \
      | while IFS= read -r line; do
          key="${line%%=*}"
          # Anything already written above came from the secret store, which is
          # authoritative; never write a key twice into a file that gets sourced.
          if grep -q "^${key}=" "${export_only}"; then continue; fi
          printf '%s\n' "${line}" >> "${export_only}"
          note "${key}"
        done
    # The store's dialect is a command-line flag (`worker --store postgres`),
    # not an env var, so it is not in the block above. join needs it to start
    # the worker on the same store — a hard-coded nucleus once broke every
    # KV call against a PostgreSQL controller.
    store="$(remote "docker inspect '${worker}' --format '{{range .Config.Cmd}}{{println .}}{{end}}'" \
      | sed -n '/^--store$/{n;p;}' | head -n 1 || true)"
    if [ -n "${store}" ] && ! grep -q '^SHIP_STORE=' "${export_only}"; then
      printf 'SHIP_STORE=%s\n' "${store}" >> "${export_only}"
      note "SHIP_STORE (${store}, from the worker's command line)"
    fi
  fi

  chmod 600 "${export_only}"
  say "wrote ${export_only}"
  note "install elsewhere with:"
  note "  ./install.sh --secrets-file ${export_only} --host <new-ip> --user <user> <name>"
  note "or join an EXISTING fleet as a second worker, without deploying a dashboard:"
  note "  teploy-ship join http://${host}:7460 --secrets ${export_only} \\"
  note "    --nucleus-url postgres://ship@${host}:5432/ship"
  note "  (the store publishes no host port by default: join explains what to open)"
  exit 0
fi

# An existing Ship on Nucleus. This script deploys PostgreSQL now, and doing
# that over a Nucleus install would point Ship at an empty database while its
# runs, projects and users sit in the old store. Stop and say what to do.
#
# "No such container" and "ssh could not ask" are different answers. Plain ssh
# in batch mode refuses a host this machine has never connected to, which is
# exactly the state of a new laptop pointed at an old install — so an
# unreachable server is asked again once teploy has enrolled its host key
# (below, after provisioning), instead of being taken for an empty one.
nucleus_state() {
  remote 'if docker inspect ship-nucleus >/dev/null 2>&1; then echo present; else echo absent; fi' 2>/dev/null | tail -n 1 || echo unreachable
}
refuse_nucleus() {
  die "${host} runs Ship on Nucleus (container ship-nucleus). install.sh now deploys a PostgreSQL store and will not
switch an existing install underneath its data. Move it first (docs/MIGRATE_STORE.md: scripts/migrate-store.mjs
copies the data), or keep deploying it by hand from a Nucleus teploy.yml (the commented block in
teploy.example.yml)."
}
nucleus="$(nucleus_state)"
case "${nucleus}" in present) refuse_nucleus ;; absent) ;; *) nucleus="unreachable" ;; esac

if [ -f "${secrets_file}" ]; then
  say "reusing ${secrets_file}"
  while IFS= read -r line; do
    case "${line}" in ''|'#'*) continue ;; esac
    case "${line}" in *=*) sec_put "${line%%=*}" "${line#*=}" ;; esac
  done < "${secrets_file}"
fi

ask() {
  # $1 name, $2 prompt. Never echoes what is typed.
  if sec_get "$1" >/dev/null; then return 0; fi
  [ "${assume_yes}" -eq 1 ] && die "$1 is not set and --yes forbids prompting"
  printf '    %s: ' "$2" >&2
  local value=""
  read -r -s value
  printf '\n' >&2
  [ -n "${value}" ] || die "$1 is required"
  sec_put "$1" "${value}"
}

# One secret from the server's own store, or non-zero when it holds none.
#
# The EXIT STATUS decides, never the output: `teploy secret get` prints a
# "Connecting to user@host..." banner on stdout before the value (hence the
# last line), and for a key that is not set it prints the banner and fails.
# Reading the last line without the status took the banner for the value.
server_secret() {
  local out
  out="$(tp secret get "$1" 2>/dev/null)" || return 1
  out="$(printf '%s\n' "${out}" | tail -n 1)"
  [ -n "${out}" ] || return 1
  printf '%s' "${out}"
}

say "secrets"
# Generated, never copied between installs: a second Ship has no business
# sharing the first one's dashboard token or webhook HMAC. SHIP_CONFIG_KEY
# seals credentials Ship stores (the Akiroo pull token; harness credentials
# are refused without it) — unset, they would sit in the store in the clear.
# Keep it with the bundle: values sealed under it are unreadable without it.
#
# A re-run WITHOUT the bundle (another laptop, a lost file) must not rotate
# them underneath a running install either: a new SHIP_CONFIG_KEY makes every
# credential already sealed under the old one unreadable, and a new
# SHIP_WEBHOOK_SECRET silently breaks the webhooks configured on the forge. So:
# the bundle, else what this server already holds, else a new one.
for key in SHIP_WEB_TOKEN SHIP_SESSION_SECRET SHIP_WEBHOOK_SECRET SHIP_CONFIG_KEY; do
  if sec_get "${key}" >/dev/null; then
    note "${key}: from bundle"
  elif held="$(server_secret "${key}")"; then
    sec_put "${key}" "${held}"
    note "${key}: from ${host}'s secret store"
  else
    sec_put "${key}" "$(openssl rand -hex 32)"
    note "${key}: generated"
  fi
done

# The PostgreSQL password, under the two names that read it: SHIP_DB_PASSWORD
# for the accessory (POSTGRES_PASSWORD: secret:SHIP_DB_PASSWORD in
# teploy.example.yml) and PGPASSWORD for web and worker (the store URL stays
# password-free). Postgres applies it only when it first creates its data
# directory, so a re-run must keep the one already in use: from the bundle,
# else from the server, and only on a server without a database, a new one.
db_password="$(sec_get SHIP_DB_PASSWORD || sec_get PGPASSWORD || true)"
if [ -n "${db_password}" ]; then
  note "SHIP_DB_PASSWORD: from bundle"
elif db_password="$(server_secret SHIP_DB_PASSWORD || server_secret PGPASSWORD)"; then
  note "SHIP_DB_PASSWORD: from ${host}'s secret store"
elif remote 'docker inspect ship-postgres >/dev/null 2>&1' 2>/dev/null; then
  die "${host} already runs ship-postgres, but its password is in neither ${secrets_file} nor the server's secret store. Restore the bundle (--secrets-file) rather than letting this script generate a password the existing database would refuse."
else
  db_password="$(openssl rand -hex 32)"
  note "SHIP_DB_PASSWORD: generated"
fi
sec_put SHIP_DB_PASSWORD "${db_password}"
sec_put PGPASSWORD "${db_password}"
if [ -n "${git_token}" ]; then sec_put SHIP_GIT_TOKEN "${git_token}"; fi
if [ -n "${github_token}" ]; then sec_put SHIP_GITHUB_TOKEN "${github_token}"; fi
# An Anthropic-compatible endpoint takes the key as AI_GATEWAY_KEY: Ship's
# direct Anthropic path always calls api.anthropic.com (ANTHROPIC_BASE_URL is
# not read), so the endpoint is wired the gateway way — verified against z.ai
# by the fresh-machine passes (2026-09-23/24).
model_secret="ANTHROPIC_API_KEY"
if [ -n "${model_url}" ]; then model_secret="AI_GATEWAY_KEY"; fi
if [ -n "${model_key}" ]; then sec_put "${model_secret}" "${model_key}"; fi
ask SHIP_GIT_TOKEN "forge deploy token (Forgejo/Gitea access token, or a GitHub PAT)"
ask "${model_secret}" "model API key"

umask 077
{
  echo "# Teploy Ship secrets. REAL VALUES — chmod 600, gitignored, never committed."
  for entry in ${secrets[@]+"${secrets[@]}"}; do printf '%s\n' "${entry}"; done
} > "${secrets_file}"
chmod 600 "${secrets_file}"
note "bundle: ${secrets_file}"

# --------------------------------------------------------------------------
# Server.
# --------------------------------------------------------------------------
if [ "${skip_setup}" -eq 0 ]; then
  say "provisioning ${server} (${ssh_user}@${host})"
  # Idempotent: teploy setup re-runs cleanly on a box it already provisioned.
  teploy setup "${host}" --name "${server}" --user "${ssh_user}" --yes
fi

# The Nucleus check that could not be made before this machine knew the host.
if [ "${nucleus}" = "unreachable" ]; then
  case "$(nucleus_state)" in
    present) refuse_nucleus ;;
    absent) ;;
    *) note "WARNING: plain ssh to ${ssh_user}@${host} does not work from here, so this script could not check"
       note "for an existing Ship on Nucleus (or a sandbox daemon). If this server already runs one, stop now." ;;
  esac
fi

# --------------------------------------------------------------------------
# Sandbox daemon + images.
#
# The daemon is what gives a run its own container with default-deny egress.
# Without it Ship still works for tasks an operator typed, but REFUSES tasks
# that arrived from a webhook — an untrusted task on a non-isolated executor is
# the one thing Ship will not do. That refusal is a feature, so this reports
# the state plainly rather than quietly installing a daemon nobody asked for.
# --------------------------------------------------------------------------
sandbox_url=""
sandbox_token=""
if remote 'systemctl is-active --quiet teploy-sandbox' 2>/dev/null; then
  sandbox_url="http://172.18.0.1:7439"
  sandbox_token="$(remote 'sudo -n cat /var/lib/teploy-sandbox/token 2>/dev/null || cat /var/lib/teploy-sandbox/token' 2>/dev/null | tr -d '\r\n' || true)"
  say "sandbox daemon: running"
  [ -n "${sandbox_token}" ] || note "WARNING: could not read /var/lib/teploy-sandbox/token — set SHIP_SANDBOX_TOKEN yourself"
else
  say "sandbox daemon: NOT installed"
  note "Ship will run operator-typed tasks inside the worker container and REFUSE"
  note "tasks arriving from webhooks/Slack/issues, which need an isolated executor."
  note "Without one, agent commands run AS THE WORKER, beside every secret it holds"
  note "(git token, model key, database password) — a prompt injection in a repo or"
  note "page a task reads can reach them. docs/DEPLOY.md section 3 installs"
  note "teploy-sandbox; re-run this afterwards."
fi

image="node:22"
# The images are what the sandbox DAEMON boots; without one nothing uses them,
# and on a cold box they are most of the install's wall clock (the 2026-09-24
# fresh-machine rerun measured it). Built when the daemon is there; re-run this
# after installing it, exactly as the note above says.
if [ -z "${sandbox_url}" ] && [ "${skip_images}" -eq 0 ]; then
  note "skipping the sandbox images: no daemon to boot them (re-run after installing it)"
  skip_images=1
fi
if [ "${skip_images}" -eq 0 ]; then
  say "building sandbox images on ${host}"
  # The images must exist on the machine whose docker daemon creates run
  # containers — the server, not this laptop. The build context goes over ssh
  # rather than anyone copying a Dockerfile by hand, which is exactly how the
  # old images came to exist on one box and nowhere else.
  remote 'rm -rf ~/.teploy-ship-images && mkdir -p ~/.teploy-ship-images'
  tar -cf - -C "${repo}" images | remote 'tar -xf - -C ~/.teploy-ship-images'
  remote 'bash ~/.teploy-ship-images/images/build.sh'
  image="ship-sandbox-go:dev"
  note "SHIP_SANDBOX_IMAGE=${image}; ship-sandbox-node:dev is there too — set it"
  note "per repo on the Projects page for a pnpm project."
fi

# --------------------------------------------------------------------------
# Deploy.
# --------------------------------------------------------------------------
# No local build: teploy syncs the SOURCE of this checkout (see
# .teployignore) and the image's builder stage compiles dist/ and web/dist/
# on the server, so what ships is tied to the code being deployed rather
# than to whatever was last built on this laptop (2026-10-18 incident).
say "deploying ship"

# The destination overlay is applied to the minimal example in a private
# staging directory, never to the maintainer's production teploy.yml.
say "writing teploy.install.yml"
{
  echo "# Generated by install.sh. Machine-specific, gitignored, safe to delete."
  echo "server: ${server}"
  echo "user: ${ssh_user}"
  echo "env:"
  # A blank gateway selects the direct provider. Optional telemetry and
  # delivery stay disabled until this installation configures them.
  if [ -n "${model_url}" ]; then
    echo "  AI_GATEWAY_URL: \"${model_url}\""
    # The endpoint receives the id verbatim; this prefix makes Ship speak
    # Anthropic's wire to it (src/model-id.ts usesAnthropicWire).
    echo "  SHIP_ANTHROPIC_WIRE_PREFIXES: \"${model}\""
  else
    echo "  AI_GATEWAY_URL: \"\""
  fi
  echo "  SHIP_REPO_ALLOWLIST: \"${allowlist}\""
  echo "  SHIP_EMBED_MODEL: \"\""
  # OBSERVE_ENDPOINT is the family's standard name (OBSERVE_URL, the old one,
  # still works on installs that set it).
  echo "  OBSERVE_ENDPOINT: \"\""
  echo "  OBSERVE_SERVICE: \"\""
  echo "  OBSERVE_REPO: \"\""
  echo "  SHIP_TELEMETRY: \"\""
  # Detection reads the repo's own tree at enqueue (src/test-detect.ts), so a
  # worker-wide command that is wrong for every repo but one is no longer the
  # default. An explicit per-repo entry still wins over both.
  echo "  SHIP_TEST_COMMAND: \"\""
  # Trusted delivery is opt-in for a new installation.
  echo "  SHIP_DELIVERY_DIR: \"\""
  echo "  SHIP_TESTS: \"1\""
  echo "  SHIP_MODEL: \"${model}\""
  echo "  SHIP_SANDBOX_IMAGE: \"${image}\""
  if [ -n "${sandbox_url}" ]; then
    echo "  SHIP_SANDBOX_URL: \"${sandbox_url}\""
    echo "  SHIP_SANDBOX_NETWORK: \"egress\""
  else
    echo "  SHIP_SANDBOX_URL: \"\""
  fi
} > "${repo}/teploy.install.yml"

# Keep the caller's checkout/config untouched. Only image inputs enter this
# temporary context; no secret bundles, node_modules, or production mounts.
install_stage=$(mktemp -d "${TMPDIR:-/tmp}/ship-install.XXXXXXXX")
trap 'rm -rf -- "${install_stage}"' EXIT
bash "${repo}/deploy/stage-install.sh" "${repo}" "${install_stage}"
# The deploy's version label: the git revision in a clone; in an unpacked
# release tarball (no .git) the package version plus a timestamp, so two
# deploys of the same tarball are still told apart.
if install_version="$(git -C "${repo}" rev-parse --short HEAD 2>/dev/null)"; then
  :
else
  pkg_version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "${repo}/package.json" | head -n 1)"
  install_version="${pkg_version:-source}-$(date -u +%Y%m%d%H%M%S)"
fi

say "setting secrets on ${server}"
args=()
for entry in ${secrets[@]+"${secrets[@]}"}; do args+=("${entry}"); done
if [ -n "${sandbox_token}" ]; then args+=("SHIP_SANDBOX_TOKEN=${sandbox_token}"); fi
if [ -n "${allowlist}" ]; then args+=("SHIP_REPO_ALLOWLIST=${allowlist}"); fi
if [ -n "${SHIP_PUBLIC_URL:-}" ]; then args+=("SHIP_PUBLIC_URL=${SHIP_PUBLIC_URL}"); fi
tp secret set "${args[@]}" > /dev/null
note "${#args[@]} secrets set"

# teploy creates the `ship-data` volume's host directory owned by root, and
# the image runs as uid 1000 (node): without a sandbox daemon the worker's run
# workspaces live there, and every run died at its first step with EACCES
# (fresh-machine rerun, 2026-09-24). Create it with the right owner first.
remote 'd=/deployments/ship/volumes/ship-data; if [ "$(id -u)" = 0 ]; then mkdir -p "$d" && chown 1000:1000 "$d"; else sudo -n mkdir -p "$d" && sudo -n chown 1000:1000 "$d"; fi' \
  || note "WARNING: could not chown /deployments/ship/volumes/ship-data to 1000:1000 — do it yourself before the first run"

say "deploying"
tp deploy -d install --version "${install_version}"

say "Ship is up"
note "dashboard  http://${host}:7460"
note "login      the SHIP_WEB_TOKEN in ${secrets_file}"
note ""
note "Firewall it — ingress: host publishes 7460 on every interface with no TLS,"
note "and Docker-published ports bypass ordinary ufw rules: use a Docker-aware"
note "firewall (docs/DEPLOY.md) or bind the port to a private address."
note ""
if [ -z "${allowlist}" ]; then
  note "SHIP_REPO_ALLOWLIST is unset: a repo URL you type yourself is allowed, but"
  note "one arriving from a webhook, Slack or an issue is REFUSED until you add the"
  note "project on the dashboard's Projects page (or pass --allow next time)."
  note ""
fi
note "First run: open the dashboard and compose the task on the Inbox. From a"
note "terminal, the CLI is inside the worker container (not on this machine):"
note "  ssh ${ssh_user}@${host} 'docker exec \$(docker ps -qf name=ship-worker) node /app/dist/cli.js \\"
note "    enqueue \"fix the failing test\" --repo <clone-url> --store postgres'"
note "The test command is detected from the repo's own tree; override it per repo"
note "on the Projects page when the guess is wrong."
