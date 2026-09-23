#!/usr/bin/env bash
# Ship store backup/verify/restore/rehearse — the practiced procedure, checked
# in as an operator-grade artifact instead of living in private handoff docs.
#
# Invariants, all of them load-bearing:
#   - A backup is only consistent after the COORDINATED STOP: ship web, ship
#     worker, and the nucleus engine. `backup` refuses while any ship-*
#     container is running and prints the exact stop commands it expects;
#     --i-stopped-writers is the operator's attestation that the stop happened
#     (joined workers are systemd units this box's docker cannot see).
#   - Existing backups are never overwritten, and nothing in this script ever
#     deletes a backup. Retention is the operator's alone: backups are kept
#     forever unless the operator deletes them. There is no automation for
#     deletion and none will be added.
#   - `restore` only ever unpacks into an empty, ISOLATED directory, and
#     refuses any target that is — or contains — the live store. Restoring
#     over a live store is not an operation this script offers.
#   - `rehearse` proves an archive by unpacking it, starting an ISOLATED
#     nucleus container against the copy, and running `teploy-ship preflight
#     --store nucleus` (run counts + step fingerprints). It removes ONLY the
#     proof container and its own rehearsal directory — never a backup.
#
# Env: SHIP_ROOT (default /deployments/ship), SHIP_BACKUP_DIR (default
# $SHIP_ROOT/_backups), SHIP_BIN (rehearse's teploy-ship, default teploy-ship),
# SHIP_NUCLEUS_IMAGE (rehearse engine image; default: the image of the
# ship-nucleus container docker knows about — rollback needs the matching
# image, not a guess), SHIP_REHEARSE_TIMEOUT_S (default 300; WAL replay has
# been observed at ~50s on a ~750k-row store and can take minutes).
set -euo pipefail

VERSION="1.0.0"
SHIP_ROOT="${SHIP_ROOT:-/deployments/ship}"
SHIP_BACKUP_DIR="${SHIP_BACKUP_DIR:-$SHIP_ROOT/_backups}"
NUCLEUS_DATA_REL="accessories/nucleus/nucleus-data"
ARCHIVE_NAME="nucleus-data-full.tgz"

die() { echo "ship-backup: $*" >&2; exit 1; }
say() { echo "$@"; }

usage() {
  cat <<'EOF'
usage: scripts/ship-backup.sh <command> [options]

  backup [--label NAME] [--ship-root DIR] [--dry-run] [--i-stopped-writers]
  verify <archive>
  restore <archive> --into <dir>
  rehearse <archive> [--image nucleus-image]

backup   tar the engine data dir ($SHIP_ROOT/accessories/nucleus/nucleus-data)
         into $SHIP_BACKUP_DIR/<label>-<date>/nucleus-data-full.tgz with a
         .sha256 sidecar and a manifest. Refuses while ship-* containers run.
verify   checksum-match the sidecar, then gzip -t the archive.
restore  unpack into an empty, isolated dir. Never touches the live store.
rehearse isolated restore + isolated nucleus container + teploy-ship preflight,
         then removes only its own proof container and rehearsal dir.

env: SHIP_ROOT, SHIP_BACKUP_DIR, SHIP_BIN, SHIP_NUCLEUS_IMAGE,
     SHIP_REHEARSE_TIMEOUT_S
EOF
}

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | awk '{print $1}'; }
  check_sidecar() { (cd "$(dirname "$1")" && sha256sum -c "$(basename "$1")"); }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 "$1" | awk '{print $1}'; }
  check_sidecar() { (cd "$(dirname "$1")" && shasum -a 256 -c "$(basename "$1")"); }
else
  die "needs sha256sum (or shasum) on PATH"
fi

# Ship containers as "name<TAB>image<TAB>id" lines, filtered from docker's
# own ps output. Any docker failure is the caller's advisory case, not a die:
# a box without docker must still be able to take backups.
running_ship_containers() {
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.ID}}' 2>/dev/null | awk -F'\t' '$1 ~ /^ship-/'
}
known_ship_containers() {
  docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.ID}}' 2>/dev/null | awk -F'\t' '$1 ~ /^ship-/'
}

resolve_path() {
  local p="${1%/}"
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  if command -v realpath >/dev/null 2>&1; then realpath -m "$p" 2>/dev/null || printf '%s\n' "$p"; else printf '%s\n' "$p"; fi
}

verify_archive() {
  local archive="$1" sidecar="${1}.sha256"
  [ -f "$archive" ] || die "no such archive: $archive"
  [ -f "$sidecar" ] || die "missing checksum sidecar: $sidecar (an archive without its recorded sha256 cannot be verified)"
  check_sidecar "$sidecar" >/dev/null || die "checksum mismatch: $archive"
  gzip -t "$archive" || die "gzip integrity failure: $archive"
}

cmd_backup() {
  local label="manual" ship_root="" dry_run=0 attested=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) [ $# -ge 2 ] || die "--label needs a value"; label="$2"; shift 2 ;;
      --ship-root) [ $# -ge 2 ] || die "--ship-root needs a value"; ship_root="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      --i-stopped-writers) attested=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die "backup: unknown argument: $1" ;;
    esac
  done
  [ -n "$ship_root" ] && SHIP_ROOT="$ship_root"
  local data_dir="$SHIP_ROOT/$NUCLEUS_DATA_REL"
  [ -d "$data_dir" ] || die "engine data dir not found: $data_dir (set --ship-root or SHIP_ROOT)"

  if [ "$attested" -ne 1 ]; then
    local running=""
    if command -v docker >/dev/null 2>&1; then
      running="$(running_ship_containers)" || running=""
      if [ -z "$running" ] && ! docker ps >/dev/null 2>&1; then
        say "# docker present but unreachable — writer check skipped (advisory)" >&2
      fi
    else
      say "# docker unavailable — writer check skipped (advisory)" >&2
    fi
    if [ -n "$running" ]; then
      {
        echo "refusing: ship containers are still running — a tar of a live store is not a consistent backup:"
        echo "$running" | awk -F'\t' '{ printf "  %s  %s\n", $1, $2 }'
        echo "the coordinated stop this script expects:"
        echo "  docker stop $(echo "$running" | awk -F'\t' '{printf "%s%s", sep, $1; sep=" "}')"
        echo "then re-run with --i-stopped-writers"
      } >&2
      exit 1
    fi
  fi

  local stamp
  stamp="$(date +%Y-%m-%d)"
  case "$label" in
    [A-Za-z0-9][A-Za-z0-9._-]*) ;;
    *) die "label must start alphanumeric and contain only [A-Za-z0-9._-]: $label" ;;
  esac
  local dest="$SHIP_BACKUP_DIR/$label-$stamp"

  if [ "$dry_run" -eq 1 ]; then
    say "dry-run: would create $dest/"
    say "  archive   $dest/$ARCHIVE_NAME  (tar czf of $data_dir)"
    say "  sidecar   $dest/$ARCHIVE_NAME.sha256"
    say "  manifest  $dest/manifest.txt"
    say "  then checksum-verify + gzip -t the archive"
    say "no files written"
    exit 0
  fi

  if [ -e "$dest" ]; then die "refusing to overwrite existing backup dir: $dest (backups are never overwritten)"; fi
  mkdir -p "$dest"
  local archive="$dest/$ARCHIVE_NAME"
  tar czf "$archive" -C "$(dirname "$data_dir")" "$(basename "$data_dir")"

  local digest bytes
  digest="$(hash_of "$archive")"
  bytes="$(wc -c <"$archive" | tr -d ' ')"
  printf '%s  %s\n' "$digest" "$ARCHIVE_NAME" >"$archive.sha256"

  {
    echo "ship-backup manifest (script version $VERSION)"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "hostname: $(hostname)"
    echo "ship-root: $SHIP_ROOT"
    echo "data-dir: $NUCLEUS_DATA_REL"
    echo "archive: $ARCHIVE_NAME"
    echo "bytes: $bytes"
    echo "sha256: $digest"
    echo "containers-running (advisory):"
    if command -v docker >/dev/null 2>&1 && running="$(running_ship_containers)" && [ -n "$running" ]; then
      echo "$running" | awk -F'\t' '{ printf "  %s  %s  %s\n", $1, $2, $3 }'
    elif command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
      echo "  none found"
    else
      echo "  docker unavailable — not checked (advisory)"
    fi
    echo "containers-known (docker ps -a, ship-* — rollback wants the matching engine image):"
    if command -v docker >/dev/null 2>&1 && known="$(known_ship_containers)" && [ -n "$known" ]; then
      echo "$known" | awk -F'\t' '{ printf "  %s  %s  %s\n", $1, $2, $3 }'
    else
      echo "  docker unavailable or no ship-* containers (advisory)"
    fi
  } >"$dest/manifest.txt"

  verify_archive "$archive"
  say "backup complete: $archive ($bytes bytes, sha256 $digest)"
  say "verify:   scripts/ship-backup.sh verify $archive"
  say "rehearse: scripts/ship-backup.sh rehearse $archive"
  say "retention is yours: this script never deletes a backup"
}

cmd_verify() {
  [ $# -ge 1 ] || { usage >&2; die "verify needs an archive path"; }
  local archive="$1"; shift
  [ $# -eq 0 ] || { usage >&2; die "verify takes one argument"; }
  verify_archive "$archive"
  say "verified: $archive (sha256 sidecar match + gzip -t)"
}

cmd_restore() {
  local into=""
  local archive="${1:-}"; shift || true
  [ -n "$archive" ] || { usage >&2; die "restore needs an archive path"; }
  while [ $# -gt 0 ]; do
    case "$1" in
      --into) [ $# -ge 2 ] || die "--into needs a directory"; into="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die "restore: unknown argument: $1" ;;
    esac
  done
  [ -n "$into" ] || die "restore requires --into <dir> (an empty, ISOLATED directory — never the live store)"
  verify_archive "$archive"

  if [ -d "$into" ] && [ -n "$(ls -A "$into")" ]; then
    die "refusing: target is not empty: $into (restore only ever unpacks into an empty, isolated dir)"
  fi

  local live="$SHIP_ROOT/$NUCLEUS_DATA_REL" target resolved_live resolved_target
  target="$(resolve_path "$into")"
  if [ -e "$live" ] || [ -d "$(dirname "$live")" ]; then
    resolved_live="$(resolve_path "$live")"
    resolved_target="$target"
    if [ "$resolved_target" = "$resolved_live" ]; then
      die "refusing: target IS the live store: $target"
    fi
    case "$resolved_live" in "$resolved_target"/*) die "refusing: target contains the live store ($resolved_live)"; esac
    case "$resolved_target" in "$resolved_live"/*) die "refusing: target is inside the live store ($resolved_live)"; esac
  fi

  mkdir -p "$into"
  tar xzf "$archive" -C "$into"
  say "restored into isolation: $target/$(basename "$NUCLEUS_DATA_REL")"
  say "this is a proof copy. To prove it boots and answers: scripts/ship-backup.sh rehearse $archive"
  say "never unpack over the live store; a real recovery is a deliberate, writers-stopped operation"
}

cmd_rehearse() {
  local archive="${1:-}" image="${SHIP_NUCLEUS_IMAGE:-}"
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --image) [ $# -ge 2 ] || die "--image needs a value"; image="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die "rehearse: unknown argument: $1" ;;
    esac
  done
  [ -n "$archive" ] || { usage >&2; die "rehearse needs an archive path"; }
  command -v docker >/dev/null 2>&1 || die "rehearse needs docker (it starts an isolated nucleus proof container)"
  docker ps >/dev/null 2>&1 || die "docker is not reachable"
  command -v "${SHIP_BIN:-teploy-ship}" >/dev/null 2>&1 \
    || die "rehearse needs a teploy-ship binary on PATH (or set SHIP_BIN) to run preflight"
  verify_archive "$archive"

  if [ -z "$image" ]; then
    # Rollback needs the image the backup was TAKEN UNDER (teploy.yml pins it;
    # v1.1.1's WAL v2 is the worked example of why an image swap is not a
    # rollback). Prefer the engine container docker still knows about.
    image="$(known_ship_containers | awk -F'\t' '$1 ~ /^ship-nucleus/ {print $2; exit}')"
    [ -n "$image" ] || die "could not discover the nucleus image (no ship-nucleus container known to docker); pass --image <nucleus-image>"
  fi

  # Globals on purpose: the EXIT trap fires after this function has returned,
  # when its locals no longer exist (same shape as scripts/smoke-image.sh).
  rehearsal="$SHIP_BACKUP_DIR/rehearsals/rehearse-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  name="ship-backup-proof-$$"
  mkdir -p "$rehearsal"
  cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
    rm -rf "$rehearsal"
  }
  trap cleanup EXIT
  tar xzf "$archive" -C "$rehearsal"

  # Same posture as the teploy.yml accessory: no-auth pgwire, no clustering,
  # and the engine memory budget set above the 512 MB default so a real store
  # is not rejected on load during the proof.
  docker run -d --name "$name" \
    -p 127.0.0.1::5432 \
    -v "$rehearsal/$(basename "$NUCLEUS_DATA_REL"):/data" \
    -e NUCLEUS_ALLOW_NO_AUTH=1 \
    -e NUCLEUS_ALLOW_INSECURE_CLUSTER=1 \
    -e NUCLEUS_ALLOW_INSECURE_REPLICATION=1 \
    -e NUCLEUS_MAX_MEMORY_MB="${SHIP_REHEARSE_MAX_MEMORY_MB:-1024}" \
    "$image" >/dev/null

  local endpoint timeout elapsed=0
  endpoint="$(docker port "$name" 5432/tcp | head -1)"
  [ -n "$endpoint" ] || { docker logs "$name" || true; die "proof container published no port"; }
  timeout="${SHIP_REHEARSE_TIMEOUT_S:-300}"
  # The engine refuses connections while it replays its WAL, so wait on the
  # socket, not on the container state.
  until (exec 3<>"/dev/tcp/${endpoint%:*}/${endpoint##*:}") 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      docker logs "$name" || true
      die "proof engine did not accept connections within ${timeout}s (see logs above)"
    fi
  done

  say "proof engine up on $endpoint — running teploy-ship preflight against the restored copy"
  if ! NUCLEUS_URL="postgres://nucleus@${endpoint}/nucleus" "${SHIP_BIN:-teploy-ship}" preflight --store nucleus; then
    docker logs "$name" || true
    die "preflight failed against the restored copy — this archive is not proven"
  fi
  say "rehearsal passed: archive restores, engine boots, preflight reads run counts and fingerprints"
  say "cleaning up: removing only the proof container ($name) and the rehearsal dir"
}

case "${1:-}" in
  backup) shift; cmd_backup "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  rehearse) shift; cmd_rehearse "$@" ;;
  --help|-h|help|"") usage ;;
  *) usage >&2; die "unknown command: $1" ;;
esac
