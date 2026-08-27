#!/usr/bin/env bash
# Teploy Ship — clean VM to a working Ship, one command.
#
#   ./install.sh --host 203.0.113.10 --user root mybox
#
# In order: provisions the server (teploy setup), collects secrets — generating
# the ones it can, asking for the two it cannot — builds the sandbox images ON
# the server from images/, builds Ship, and deploys. Ten minutes on a cold box,
# most of it the sandbox image.
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
#     --nucleus-url postgres://nucleus:<pw>@<old-ip>:5432/nucleus --start
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
#   --allow <origins>        SHIP_REPO_ALLOWLIST, comma separated
#   --model <id>             SHIP_MODEL (default anthropic/claude-sonnet-5)
#   --skip-images            do not build the sandbox images
#   --skip-setup             the server is already provisioned for teploy
#   --yes                    never prompt; fail instead
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
    --allow) allowlist="${2:?}"; shift 2 ;;
    --model) model="${2:?}"; shift 2 ;;
    --skip-images) skip_images=1; shift ;;
    --skip-setup) skip_setup=1; shift ;;
    -y|--yes) assume_yes=1; shift ;;
    -h|--help) sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
tp() { teploy --host "${host}" --user "${ssh_user}" "$@"; }
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
      echo "# NUCLEUS_URL below is almost certainly a docker network alias, which"
      echo "# only THIS box can resolve. teploy-ship join refuses it and says so;"
      echo "# pass --nucleus-url with the controller's tailnet address."
    } >> "${export_only}"
    # Only the families Ship reads. A blanket dump would carry PATH, NODE_VERSION
    # and the container's own TEPLOY_SHIP_STATE=/data into a bundle that is then
    # sourced on a host where none of them are true.
    remote "docker inspect ${worker} --format '{{range .Config.Env}}{{println .}}{{end}}'" \
      | grep -E '^(NUCLEUS_URL|AI_GATEWAY_URL|OBSERVE_[A-Z_]*|SHIP_[A-Z0-9_]*|ANTHROPIC_BASE_URL)=' \
      | while IFS= read -r line; do
          key="${line%%=*}"
          # Anything already written above came from the secret store, which is
          # authoritative; never write a key twice into a file that gets sourced.
          if grep -q "^${key}=" "${export_only}"; then continue; fi
          printf '%s\n' "${line}" >> "${export_only}"
          note "${key}"
        done
  fi

  chmod 600 "${export_only}"
  say "wrote ${export_only}"
  note "install elsewhere with:"
  note "  ./install.sh --secrets-file ${export_only} --host <new-ip> --user <user> <name>"
  note "or join an EXISTING fleet as a second worker, without deploying a dashboard:"
  note "  teploy-ship join http://${host}:7460 --secrets ${export_only} \\"
  note "    --nucleus-url postgres://nucleus:<pw>@${host}:5432/nucleus"
  exit 0
fi

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

say "secrets"
# Generated, never copied between installs: a second Ship has no business
# sharing the first one's dashboard token or webhook HMAC.
for key in SHIP_WEB_TOKEN SHIP_SESSION_SECRET SHIP_WEBHOOK_SECRET; do
  if sec_get "${key}" >/dev/null; then
    note "${key}: from bundle"
  else
    sec_put "${key}" "$(openssl rand -hex 32)"
    note "${key}: generated"
  fi
done
if [ -n "${git_token}" ]; then sec_put SHIP_GIT_TOKEN "${git_token}"; fi
if [ -n "${github_token}" ]; then sec_put SHIP_GITHUB_TOKEN "${github_token}"; fi
if [ -n "${model_key}" ]; then sec_put ANTHROPIC_API_KEY "${model_key}"; fi
ask SHIP_GIT_TOKEN "forge deploy token (Forgejo/Gitea access token, or a GitHub PAT)"
ask ANTHROPIC_API_KEY "model API key (sk-ant-...)"

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
  sandbox_token="$(remote 'sudo -n cat /var/lib/teploy-sandbox/token 2>/dev/null || cat /var/lib/teploy-sandbox/token' | tr -d '\r\n')"
  say "sandbox daemon: running"
  [ -n "${sandbox_token}" ] || note "WARNING: could not read /var/lib/teploy-sandbox/token — set SHIP_SANDBOX_TOKEN yourself"
else
  say "sandbox daemon: NOT installed"
  note "Ship will run operator-typed tasks inside the worker container and REFUSE"
  note "tasks arriving from webhooks/Slack/issues, which need an isolated executor."
  note "docs/DEPLOY.md section 3 installs teploy-sandbox; re-run this afterwards."
fi

image="node:22"
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
# Build and deploy.
# --------------------------------------------------------------------------
say "building ship"
for tool in pnpm node; do
  command -v "${tool}" >/dev/null 2>&1 || die "${tool} is not on PATH (needed to build the deploy artefacts)"
done
pnpm install --silent
pnpm run build
(cd web && pnpm install --silent && pnpm run build)

# A generated destination overlay, so the tracked teploy.yml is never edited
# for one operator's box. `teploy deploy -d install` merges it.
say "writing teploy.install.yml"
{
  echo "# Generated by install.sh. Machine-specific, gitignored, safe to delete."
  echo "server: ${server}"
  echo "user: ${ssh_user}"
  echo "env:"
  # teploy.yml's env block points at deploy-test's own gateway and Observe
  # instance. Blanking them is most of what makes this repo installable by
  # someone who is not Tyler: AI_GATEWAY_URL="" means "call the provider
  # directly with ANTHROPIC_API_KEY" (src/cli.ts:314-318), and an empty
  # OBSERVE_URL turns the telemetry leg off rather than putting a stranger's
  # pull requests next to Tyler's metrics.
  echo "  AI_GATEWAY_URL: \"\""
  echo "  SHIP_EMBED_MODEL: \"\""
  echo "  OBSERVE_URL: \"\""
  echo "  OBSERVE_SERVICE: \"\""
  echo "  OBSERVE_REPO: \"\""
  echo "  SHIP_TELEMETRY: \"\""
  # Detection reads the repo's own tree at enqueue (src/test-detect.ts), so a
  # worker-wide command that is wrong for every repo but one is no longer the
  # default. An explicit per-repo entry still wins over both.
  echo "  SHIP_TEST_COMMAND: \"\""
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

say "setting secrets on ${server}"
args=()
for entry in ${secrets[@]+"${secrets[@]}"}; do args+=("${entry}"); done
if [ -n "${sandbox_token}" ]; then args+=("SHIP_SANDBOX_TOKEN=${sandbox_token}"); fi
if [ -n "${allowlist}" ]; then args+=("SHIP_REPO_ALLOWLIST=${allowlist}"); fi
if [ -n "${SHIP_PUBLIC_URL:-}" ]; then args+=("SHIP_PUBLIC_URL=${SHIP_PUBLIC_URL}"); fi
tp secret set "${args[@]}" > /dev/null
note "${#args[@]} secrets set"

say "deploying"
tp deploy -d install

say "Ship is up"
note "dashboard  http://${host}:7460"
note "login      the SHIP_WEB_TOKEN in ${secrets_file}"
note ""
note "Firewall it — ingress: host publishes 7460 with no TLS:"
note "  ufw allow from 100.64.0.0/10 to any port 7460"
note ""
if [ -z "${allowlist}" ]; then
  note "SHIP_REPO_ALLOWLIST is unset, so a repo URL is REFUSED until you add the"
  note "project on the dashboard's Projects page (or pass --allow next time)."
  note ""
fi
note "First run:"
note "  teploy-ship enqueue \"fix the failing test\" --repo <clone-url>"
note "The test command is detected from the repo's own tree; override it per repo"
note "on the Projects page when the guess is wrong."
