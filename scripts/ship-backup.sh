#!/usr/bin/env bash
# Ship store backup/verify/restore/rehearse — the practiced procedure, checked
# in as an operator-grade artifact instead of living in private handoff docs.
#
# Two stores, one discipline. The script detects which store the install uses
# (or takes --store / SHIP_STORE, which states the answer and skips
# detection): the writers' own `--store` args and $SHIP_ROOT/teploy.yml are
# CROSS-CHECKED — the two naming different stores is a refusal, never a
# first-source-wins guess — and only when neither config source names a kind
# do the accessory containers and data dirs present settle it.
# Signals that disagree are a refusal, never a guess.
#
# Invariants, all of them load-bearing:
#   - NUCLEUS: a backup is only consistent after the COORDINATED STOP: ship
#     web, ship worker, and the nucleus engine. `backup` refuses while any
#     ship-* container is running and prints the exact stop commands it
#     expects; --i-stopped-writers is the operator's attestation that the stop
#     happened (joined workers are systemd units this box's docker cannot see).
#   - POSTGRES: the default backup is `pg_dump -Fc` run INSIDE the running
#     postgres accessory (docker exec) — one transaction snapshot, consistent
#     while writers run, so no stop is needed. The manifest records per-table
#     row counts read back FROM THE ARCHIVE ITSELF, so they describe exactly
#     what it holds. `--cold` instead tars the pgdata bind dir and has the
#     nucleus rule: writers AND the postgres accessory stopped first.
#   - Existing backups are never overwritten, and nothing in this script ever
#     deletes a backup. Retention is the operator's alone: backups are kept
#     forever unless the operator deletes them. There is no automation for
#     deletion and none will be added. The one removal is a FAILED pg_dump's
#     own partial output — its archive file plus the dir leaf that run just
#     atomically claimed (never anything else the dir may hold) — so a
#     failure does not occupy the label+date slot forever (the same rule
#     `teploy-ship snapshot` has).
#   - `restore` only ever unpacks into an empty, ISOLATED directory (tar
#     archives) or into a NEW scratch postgres container (pg_dump archives),
#     and refuses any target that is — or contains — a live store. Restoring
#     over a live store is not an operation this script offers.
#   - `rehearse` proves an archive in isolation and removes ONLY what it
#     created (its proof container and its own rehearsal directory) — never
#     a backup. Nucleus: isolated nucleus + `teploy-ship preflight --store
#     nucleus`. Postgres dump: scratch postgres (same image), pg_restore, then
#     the restored table set and every row count must equal the manifest's.
#
# Env: SHIP_ROOT (default /deployments/ship), SHIP_BACKUP_DIR (default
# $SHIP_ROOT/_backups), SHIP_STORE (nucleus|postgres; skips detection),
# SHIP_BIN (rehearse's teploy-ship, default teploy-ship), SHIP_NUCLEUS_IMAGE
# (rehearse engine image; default: the image of the ship-nucleus container
# docker knows about — rollback needs the matching image, not a guess),
# SHIP_REHEARSE_TIMEOUT_S (default 300; WAL replay has been observed at ~50s
# on a ~750k-row store and can take minutes), SHIP_TEPLOY_YML (default
# $SHIP_ROOT/teploy.yml). Postgres: SHIP_PG_CONTAINER (default ship-postgres),
# SHIP_PG_DB / SHIP_PG_USER (default: the container's POSTGRES_DB /
# POSTGRES_USER, else ship), SHIP_PG_DATA_DIR (cold tar source; default: the
# container's /var/lib/postgresql/data mount, else
# $SHIP_ROOT/accessories/postgres/pgdata), SHIP_PG_IMAGE (scratch image;
# default: the manifest's pg-image, else the live container's image).
set -euo pipefail

VERSION="1.1.0"
SHIP_ROOT="${SHIP_ROOT:-/deployments/ship}"
SHIP_BACKUP_DIR="${SHIP_BACKUP_DIR:-$SHIP_ROOT/_backups}"
NUCLEUS_DATA_REL="accessories/nucleus/nucleus-data"
ARCHIVE_NAME="nucleus-data-full.tgz"
PG_DATA_REL="accessories/postgres/pgdata"
PG_DUMP_NAME="ship-pg.dump"
PG_COLD_NAME="pgdata-full.tgz"
PG_CONTAINER="${SHIP_PG_CONTAINER:-ship-postgres}"
PG_MOUNT="/var/lib/postgresql/data"

die() { echo "ship-backup: $*" >&2; exit 1; }
say() { echo "$@"; }

usage() {
  cat <<'EOF'
usage: scripts/ship-backup.sh <command> [options]

  backup [--label NAME] [--ship-root DIR] [--store nucleus|postgres] [--cold]
         [--dry-run] [--i-stopped-writers]
  verify <archive>
  restore <archive> --into <dir>                  (tar archives)
  restore <ship-pg.dump> [--name C] [--image I]   (pg_dump archives)
  rehearse <archive> [--image IMAGE]

backup   nucleus: tar the engine data dir ($SHIP_ROOT/accessories/nucleus/
         nucleus-data) into $SHIP_BACKUP_DIR/<label>-<date>/nucleus-data-full.tgz.
         Refuses while ship-* containers run.
         postgres: pg_dump -Fc inside the running accessory container into
         <label>-<date>/ship-pg.dump — online, consistent, no stop needed — with
         per-table row counts read back from the archive into the manifest.
         postgres --cold: tar the pgdata bind dir into pgdata-full.tgz; refuses
         while ship-* containers (incl. ship-postgres) run.
         Every archive gets a .sha256 sidecar and a manifest.txt.
verify   checksum-match the sidecar, then gzip -t (tar archives) or the PGDMP
         header + pg_restore --list via the live container, its manifest
         image, or a host client — in that order (dumps).
restore  tar: unpack into an empty, isolated dir. dump: pg_restore into a NEW
         scratch postgres container (loopback port), check counts against the
         manifest, and leave it running for inspection. Never the live store.
rehearse nucleus: isolated restore + isolated nucleus + teploy-ship preflight.
         dump: scratch postgres + pg_restore + table set and row counts must
         equal the manifest (+ preflight --store postgres when teploy-ship is
         available). cold pgdata: boot a scratch postgres on an isolated copy
         and read every table's count. Removes only its own container and dir.

env: SHIP_ROOT, SHIP_BACKUP_DIR, SHIP_STORE, SHIP_BIN, SHIP_NUCLEUS_IMAGE,
     SHIP_REHEARSE_TIMEOUT_S, SHIP_TEPLOY_YML, SHIP_PG_CONTAINER, SHIP_PG_DB,
     SHIP_PG_USER, SHIP_PG_DATA_DIR, SHIP_PG_IMAGE
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

is_pg_dump() { [ -f "$1" ] && [ "$(head -c 5 "$1" 2>/dev/null)" = "PGDMP" ]; }

# The manifest beside an archive, as KEY lookups. Empty when absent.
manifest_of() { printf '%s/manifest.txt\n' "$(dirname "$1")"; }
manifest_value() {
  local m; m="$(manifest_of "$1")"
  [ -f "$m" ] || return 0
  awk -v k="$2: " 'index($0, k) == 1 { print substr($0, length(k) + 1); exit }' "$m"
}
# "table<TAB>count" lines from a manifest's tables section.
manifest_tables() {
  local m; m="$(manifest_of "$1")"
  [ -f "$m" ] || return 0
  awk '/^tables/ { on = 1; next } on && /^  \(none\)$/ { next } on && /^  / { sub(/^  /, ""); n = split($0, f, /  +/); print f[1] "\t" f[n]; next } on { exit }' "$m"
}

# ---------------------------------------------------------------------------
# store detection
# ---------------------------------------------------------------------------

# Which store kinds a text names via `--store X` (comment lines ignored).
store_kinds_in() {
  grep -v '^[[:space:]]*#' | grep -Eo -- '--store[ =]+(nucleus|postgres)' | grep -Eo '(nucleus|postgres)$' | sort -u || true
}

# Prints "kind<TAB>evidence". The writers' args are what the store actually
# IS; teploy.yml is what it is configured to be; the two are cross-checked
# and must agree — writers naming one kind and teploy.yml naming the other
# refuses (a stated --store / SHIP_STORE overrides the check). A source
# naming both kinds is itself ambiguous and refuses. Accessories are what is
# left lying around (a burn-in box can hold both) and only settle the
# question when neither config source names a kind.
detect_store() {
  local stated="${1:-}"
  if [ -n "$stated" ]; then
    case "$stated" in
      nucleus|postgres) printf '%s\t%s\n' "$stated" "stated (--store / SHIP_STORE)"; return 0 ;;
      *) die "unknown store: $stated (expected nucleus or postgres)" ;;
    esac
  fi
  local kinds yml_kinds="" evidence=""

  if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
    local writers
    writers="$(running_ship_containers | awk -F'\t' '$1 ~ /^ship-(web|worker)/ {print $1}')"
    if [ -z "$writers" ]; then
      # docker ps -a lists newest first: the last deployed writer, not a
      # rollback leftover from before a store migration.
      writers="$(known_ship_containers | awk -F'\t' '$1 ~ /^ship-(web|worker)/ {print $1; exit}')"
    fi
    if [ -n "$writers" ]; then
      kinds="$(for w in $writers; do docker inspect --format '{{.Path}} {{join .Args " "}}' "$w" 2>/dev/null || true; done | store_kinds_in)"
      evidence="writer args ($(echo $writers))"
      case "$(printf '%s\n' "$kinds" | grep -c .)" in
        1) ;;
        0) kinds="" ;;
        *) die "ambiguous store: $evidence name both nucleus and postgres — pass --store" ;;
      esac
    fi
  fi

  local yml="${SHIP_TEPLOY_YML:-$SHIP_ROOT/teploy.yml}"
  if [ -f "$yml" ]; then
    yml_kinds="$(store_kinds_in <"$yml")"
    case "$(printf '%s\n' "$yml_kinds" | grep -c .)" in
      1) ;;
      0) yml_kinds="" ;;
      *) die "ambiguous store: $yml names both nucleus and postgres — pass --store" ;;
    esac
  fi

  if [ -n "$kinds" ] && [ -n "$yml_kinds" ] && [ "$kinds" != "$yml_kinds" ]; then
    die "store signals disagree: the writers' args say $kinds but $yml says $yml_kinds — pass --store nucleus|postgres to choose"
  fi

  if [ -n "$kinds" ]; then printf '%s\t%s\n' "$kinds" "$evidence"; return 0; fi
  if [ -n "$yml_kinds" ]; then printf '%s\t%s\n' "$yml_kinds" "teploy.yml processes ($yml)"; return 0; fi

  local found="" why=""
  if [ -d "$SHIP_ROOT/$NUCLEUS_DATA_REL" ]; then found="$found nucleus"; why="$why $NUCLEUS_DATA_REL"; fi
  if [ -d "$SHIP_ROOT/$PG_DATA_REL" ]; then found="$found postgres"; why="$why $PG_DATA_REL"; fi
  if command -v docker >/dev/null 2>&1; then
    local known
    known="$(known_ship_containers | awk -F'\t' '{print $1}')" || known=""
    if printf '%s\n' "$known" | grep -q '^ship-nucleus'; then found="$found nucleus"; why="$why ship-nucleus"; fi
    if printf '%s\n' "$known" | grep -qx "$PG_CONTAINER"; then found="$found postgres"; why="$why $PG_CONTAINER"; fi
  fi
  kinds="$(printf '%s\n' $found | sort -u | grep . || true)"
  case "$(printf '%s\n' "$kinds" | grep -c .)" in
    1) printf '%s\t%s\n' "$kinds" "accessories present:$why"; return 0 ;;
    0) die "could not tell which store this install uses: no engine data dir ($SHIP_ROOT/$NUCLEUS_DATA_REL or $SHIP_ROOT/$PG_DATA_REL), no ship-nucleus/$PG_CONTAINER container, no --store in writer args or teploy.yml (set --ship-root / SHIP_ROOT, or pass --store)" ;;
    *) die "ambiguous store: both nucleus and postgres accessories present ($why ) — pass --store nucleus|postgres" ;;
  esac
}

# ---------------------------------------------------------------------------
# shared pieces
# ---------------------------------------------------------------------------

verify_archive() {
  local archive="$1" sidecar="${1}.sha256"
  [ -f "$archive" ] || die "no such archive: $archive"
  [ -f "$sidecar" ] || die "missing checksum sidecar: $sidecar (an archive without its recorded sha256 cannot be verified)"
  check_sidecar "$sidecar" >/dev/null || die "checksum mismatch: $archive"
  gzip -t "$archive" || die "gzip integrity failure: $archive"
}

# The coordinated-stop refusal both tar paths share. Exits on refusal.
require_writers_stopped() {
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
}

manifest_containers() {
  local running known
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
}

check_label() {
  # A regex, not a case glob: a glob's `*` matches '/' too, so pinning the
  # first two characters still let `ab/../../x` through — a label names ONE
  # path segment under $SHIP_BACKUP_DIR, never a path.
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || die "label must start alphanumeric and contain only [A-Za-z0-9._-]: $1"
}

# The dest slot every backup path claims: create the parent, then take the
# leaf ATOMICALLY — plain mkdir (no -p) fails if anything, including a rival
# same-label invocation that won the race, already created the dir, so two
# backups can never both believe they own the slot.
claim_dest() {
  mkdir -p "$SHIP_BACKUP_DIR" || die "cannot create backup dir: $SHIP_BACKUP_DIR"
  mkdir "$1" || die "refusing to overwrite existing backup dir: $1 (backups are never overwritten)"
}

# Remove ONLY what this invocation created: its own partial archive, plus the
# leaf dir it atomically claimed — and rmdir refuses when the dir holds
# anything else, so a failed run can never delete another backup's finished
# output even if files appeared there after the claim.
discard_own_partial() {
  rm -f "$1"
  rmdir "$2" 2>/dev/null || true
}

# The live postgres data dir: the accessory's mount, else the teploy layout.
pg_live_data_dir() {
  if [ -n "${SHIP_PG_DATA_DIR:-}" ]; then printf '%s\n' "$SHIP_PG_DATA_DIR"; return 0; fi
  local src=""
  if command -v docker >/dev/null 2>&1; then
    src="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$PG_MOUNT"'"}}{{.Source}}{{end}}{{end}}' "$PG_CONTAINER" 2>/dev/null || true)"
  fi
  case "$src" in /*) printf '%s\n' "$src" ;; *) printf '%s\n' "$SHIP_ROOT/$PG_DATA_REL" ;; esac
}

pg_container_env() {
  docker exec "$PG_CONTAINER" printenv "$1" 2>/dev/null || true
}

# Same lookups via docker inspect, so they also work when the accessory is
# STOPPED — exactly the cold-tar case that must record database/user for the
# rehearse to use.
pg_config_env() {
  command -v docker >/dev/null 2>&1 || return 0
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PG_CONTAINER" 2>/dev/null \
    | awk -F= -v k="$1" '$1 == k { print substr($0, length(k) + 2) }'
}

# Exact per-table row counts of a custom-format dump, read from the dump:
# pg_restore renders data as COPY blocks, one line per row (text COPY escapes
# embedded newlines). Reads the dump on stdin, runs pg_restore in $1 (a
# container) via `docker exec -i`.
dump_row_counts() {
  docker exec -i "$1" pg_restore --data-only -f - | awk '
    /^COPY .* FROM stdin;$/ { t = $0; sub(/^COPY /, "", t); sub(/ (\(.*)?FROM stdin;$/, "", t); n = 0; on = 1; next }
    on && $0 == "\\." { printf "%s\t%d\n", t, n; on = 0; next }
    on { n++ }
  ' | sort
}

# ---------------------------------------------------------------------------
# backup
# ---------------------------------------------------------------------------

cmd_backup() {
  local label="manual" ship_root="" dry_run=0 attested=0 store="${SHIP_STORE:-}" cold=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) [ $# -ge 2 ] || die "--label needs a value"; label="$2"; shift 2 ;;
      --ship-root) [ $# -ge 2 ] || die "--ship-root needs a value"; ship_root="$2"; shift 2 ;;
      --store) [ $# -ge 2 ] || die "--store needs a value"; store="$2"; shift 2 ;;
      --cold) cold=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      --i-stopped-writers) attested=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die "backup: unknown argument: $1" ;;
    esac
  done
  [ -n "$ship_root" ] && SHIP_ROOT="$ship_root"
  local detected kind
  detected="$(detect_store "$store")" || exit 1
  kind="${detected%%$'\t'*}"
  if [ "$kind" = "postgres" ]; then
    say "# store: postgres — ${detected#*$'\t'}" >&2
    if [ "$cold" -eq 1 ]; then backup_pg_cold "$label" "$dry_run" "$attested"; else backup_pg_dump "$label" "$dry_run"; fi
    return 0
  fi
  [ "$cold" -eq 0 ] || die "--cold is the postgres cold-tar mode; the nucleus backup is always a cold tar"
  backup_nucleus "$label" "$dry_run" "$attested"
}

backup_nucleus() {
  local label="$1" dry_run="$2" attested="$3"
  local data_dir="$SHIP_ROOT/$NUCLEUS_DATA_REL"
  [ -d "$data_dir" ] || die "engine data dir not found: $data_dir (set --ship-root or SHIP_ROOT)"

  if [ "$attested" -ne 1 ]; then require_writers_stopped; fi

  local stamp
  stamp="$(date +%Y-%m-%d)"
  check_label "$label"
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

  claim_dest "$dest"
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
    manifest_containers
  } >"$dest/manifest.txt"

  verify_archive "$archive"
  say "backup complete: $archive ($bytes bytes, sha256 $digest)"
  say "verify:   scripts/ship-backup.sh verify $archive"
  say "rehearse: scripts/ship-backup.sh rehearse $archive"
  say "retention is yours: this script never deletes a backup"
}

backup_pg_dump() {
  local label="$1" dry_run="$2"
  command -v docker >/dev/null 2>&1 || die "the postgres backup runs pg_dump inside the $PG_CONTAINER container and needs docker (writers stopped and no docker? use --cold)"
  docker ps >/dev/null 2>&1 || die "docker is not reachable"
  local state
  state="$(docker inspect --format '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)"
  [ "$state" = "true" ] || die "postgres accessory container $PG_CONTAINER is not running (pg_dump needs it up; set SHIP_PG_CONTAINER, or stop writers + the accessory and use --cold)"

  local db user image
  db="${SHIP_PG_DB:-$(pg_container_env POSTGRES_DB)}"; db="${db:-ship}"
  user="${SHIP_PG_USER:-$(pg_container_env POSTGRES_USER)}"; user="${user:-ship}"
  image="$(docker inspect --format '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || true)"

  local stamp dest
  stamp="$(date +%Y-%m-%d)"
  check_label "$label"
  dest="$SHIP_BACKUP_DIR/$label-$stamp"

  if [ "$dry_run" -eq 1 ]; then
    say "dry-run: would create $dest/"
    say "  archive   $dest/$PG_DUMP_NAME  (docker exec $PG_CONTAINER pg_dump -Fc -U $user -d $db — online, one consistent snapshot)"
    say "  sidecar   $dest/$PG_DUMP_NAME.sha256"
    say "  manifest  $dest/manifest.txt  (incl. per-table row counts read back from the archive)"
    say "  then checksum-verify + PGDMP header + pg_restore --list"
    say "no files written"
    exit 0
  fi

  claim_dest "$dest"
  local archive="$dest/$PG_DUMP_NAME"
  # Unix-socket connection inside the container: the official image trusts
  # local connections, so no password crosses this script.
  if ! docker exec "$PG_CONTAINER" pg_dump -Fc -U "$user" -d "$db" >"$archive"; then
    discard_own_partial "$archive" "$dest"
    die "pg_dump failed inside $PG_CONTAINER (removed only this run's own partial output)"
  fi
  is_pg_dump "$archive" || { discard_own_partial "$archive" "$dest"; die "pg_dump produced no custom-format archive (removed only this run's own partial output)"; }

  local counts server_version digest bytes
  if ! counts="$(dump_row_counts "$PG_CONTAINER" <"$archive")"; then
    discard_own_partial "$archive" "$dest"
    die "could not read row counts back from the dump (removed only this run's own partial output)"
  fi
  server_version="$(docker exec "$PG_CONTAINER" psql -U "$user" -d "$db" -tAc 'SHOW server_version' 2>/dev/null | tr -d '\r' || true)"
  digest="$(hash_of "$archive")"
  bytes="$(wc -c <"$archive" | tr -d ' ')"
  printf '%s  %s\n' "$digest" "$PG_DUMP_NAME" >"$archive.sha256"

  {
    echo "ship-backup manifest (script version $VERSION)"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "hostname: $(hostname)"
    echo "ship-root: $SHIP_ROOT"
    echo "store: postgres"
    echo "method: pg_dump -Fc (online; one consistent snapshot, writers may run)"
    echo "pg-container: $PG_CONTAINER"
    echo "pg-image: ${image:-unknown}"
    echo "pg-server-version: ${server_version:-unknown}"
    echo "database: $db"
    echo "user: $user"
    echo "archive: $PG_DUMP_NAME"
    echo "bytes: $bytes"
    echo "sha256: $digest"
    echo "tables (row counts read back from the archive itself — exactly what it holds):"
    if [ -n "$counts" ]; then
      printf '%s\n' "$counts" | awk -F'\t' '{ printf "  %s  %s\n", $1, $2 }'
    else
      echo "  (none)"
    fi
    manifest_containers
  } >"$dest/manifest.txt"

  verify_pg_dump "$archive"
  say "backup complete: $archive ($bytes bytes, sha256 $digest, $(printf '%s\n' "$counts" | grep -c .) tables)"
  say "verify:   scripts/ship-backup.sh verify $archive"
  say "rehearse: scripts/ship-backup.sh rehearse $archive"
  say "retention is yours: this script never deletes a backup"
}

backup_pg_cold() {
  local label="$1" dry_run="$2" attested="$3"
  local data_dir
  data_dir="$(pg_live_data_dir)"
  [ -d "$data_dir" ] || die "postgres data dir not found: $data_dir (set SHIP_PG_DATA_DIR, --ship-root or SHIP_ROOT)"

  # A cold tar is only consistent with the ENGINE stopped too: the writer
  # check sees ship-postgres as a ship-* container and refuses while it runs.
  if [ "$attested" -ne 1 ]; then require_writers_stopped; fi

  local stamp dest
  stamp="$(date +%Y-%m-%d)"
  check_label "$label"
  dest="$SHIP_BACKUP_DIR/$label-$stamp"

  if [ "$dry_run" -eq 1 ]; then
    say "dry-run: would create $dest/"
    say "  archive   $dest/$PG_COLD_NAME  (tar czf of $data_dir — writers and $PG_CONTAINER stopped)"
    say "  sidecar   $dest/$PG_COLD_NAME.sha256"
    say "  manifest  $dest/manifest.txt"
    say "  then checksum-verify + gzip -t the archive"
    say "no files written"
    exit 0
  fi

  claim_dest "$dest"
  local archive="$dest/$PG_COLD_NAME" image=""
  # Rooted at "pgdata/" whatever the source dir is called, so restore and
  # rehearse find it in one place.
  if [ "$(basename "$data_dir")" = "pgdata" ]; then
    tar czf "$archive" -C "$(dirname "$data_dir")" pgdata
  elif tar --version 2>/dev/null | grep -q 'GNU tar'; then
    tar czf "$archive" --transform 's,^\.,pgdata,' -C "$data_dir" .
  else
    tar czf "$archive" -s ',^\.,pgdata,' -C "$data_dir" .
  fi
  if command -v docker >/dev/null 2>&1; then
    image="$(docker inspect --format '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || true)"
  fi

  local digest bytes
  digest="$(hash_of "$archive")"
  bytes="$(wc -c <"$archive" | tr -d ' ')"
  printf '%s  %s\n' "$digest" "$PG_COLD_NAME" >"$archive.sha256"

  # The rehearse of a cold archive cannot ask a RUNNING accessory who it is;
  # the manifest must carry it (inspect still sees a stopped container).
  local db user
  db="${SHIP_PG_DB:-$(pg_config_env POSTGRES_DB)}"; db="${db:-ship}"
  user="${SHIP_PG_USER:-$(pg_config_env POSTGRES_USER)}"; user="${user:-ship}"

  {
    echo "ship-backup manifest (script version $VERSION)"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "hostname: $(hostname)"
    echo "ship-root: $SHIP_ROOT"
    echo "store: postgres"
    echo "method: cold tar of the pgdata dir (writers and the engine stopped)"
    echo "data-dir: $data_dir"
    echo "pg-container: $PG_CONTAINER"
    echo "pg-image: ${image:-unknown}"
    echo "database: $db"
    echo "user: $user"
    echo "archive: $PG_COLD_NAME"
    echo "bytes: $bytes"
    echo "sha256: $digest"
    manifest_containers
  } >"$dest/manifest.txt"

  verify_archive "$archive"
  say "backup complete: $archive ($bytes bytes, sha256 $digest)"
  say "verify:   scripts/ship-backup.sh verify $archive"
  say "rehearse: scripts/ship-backup.sh rehearse $archive"
  say "retention is yours: this script never deletes a backup"
}

# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------

# Checksum, the PGDMP header, and — when a pg_restore is at hand — the
# archive's table of contents. Prints how far it got. The pg_restore ORDER is
# load-bearing: the LIVE container's client first (it matches the server the
# dump came from — an older HOST client can reject a valid newer dump and
# fail a backup that is actually fine), then the manifest image's client,
# and only then whatever pg_restore happens to be on the host.
verify_pg_dump() {
  local archive="$1" sidecar="${1}.sha256"
  [ -f "$archive" ] || die "no such archive: $archive"
  [ -f "$sidecar" ] || die "missing checksum sidecar: $sidecar (an archive without its recorded sha256 cannot be verified)"
  check_sidecar "$sidecar" >/dev/null || die "checksum mismatch: $archive"
  is_pg_dump "$archive" || die "not a pg_dump custom-format archive (no PGDMP header): $archive"
  local image
  image="${SHIP_PG_IMAGE:-$(manifest_value "$archive" pg-image)}"
  if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1 \
    && [ "$(docker inspect --format '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" = "true" ]; then
    docker exec -i "$PG_CONTAINER" pg_restore --list <"$archive" >/dev/null \
      || die "pg_restore (inside $PG_CONTAINER) cannot read the archive's table of contents: $archive"
    VERIFY_DEPTH="pg_restore --list (docker exec $PG_CONTAINER)"
  elif command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1 && [ -n "$image" ] && [ "$image" != "unknown" ] \
    && docker image inspect "$image" >/dev/null 2>&1; then
    docker run --rm -i --entrypoint pg_restore "$image" --list <"$archive" >/dev/null \
      || die "pg_restore ($image) cannot read the archive's table of contents: $archive"
    VERIFY_DEPTH="pg_restore --list ($image)"
  elif command -v pg_restore >/dev/null 2>&1; then
    pg_restore --list "$archive" >/dev/null || die "pg_restore cannot read the archive's table of contents: $archive"
    VERIFY_DEPTH="pg_restore --list (host pg_restore — may be older than the dump's server)"
  else
    VERIFY_DEPTH="header only — no pg_restore available to list the contents"
  fi
}

cmd_verify() {
  [ $# -ge 1 ] || { usage >&2; die "verify needs an archive path"; }
  local archive="$1"; shift
  [ $# -eq 0 ] || { usage >&2; die "verify takes one argument"; }
  if is_pg_dump "$archive"; then
    verify_pg_dump "$archive"
    say "verified: $archive (sha256 sidecar match + PGDMP header + $VERIFY_DEPTH)"
    return 0
  fi
  verify_archive "$archive"
  say "verified: $archive (sha256 sidecar match + gzip -t)"
}

# ---------------------------------------------------------------------------
# scratch postgres (restore + rehearse of pg archives)
# ---------------------------------------------------------------------------

pg_scratch_image() {
  local archive="$1" image="$2"
  [ -n "$image" ] || image="${SHIP_PG_IMAGE:-}"
  [ -n "$image" ] || image="$(manifest_value "$archive" pg-image)"
  [ "$image" != "unknown" ] || image=""
  [ -n "$image" ] || image="$(docker inspect --format '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || true)"
  [ -n "$image" ] || die "could not discover the postgres image (no pg-image in the manifest, no $PG_CONTAINER container); pass --image <postgres-image>"
  printf '%s\n' "$image"
}

# A scratch container name is ours only if nothing by that name exists yet,
# and it is never the live accessory.
pg_scratch_name_ok() {
  [ "$1" != "$PG_CONTAINER" ] || die "refusing: $1 IS the live postgres accessory"
  case "$1" in ship-postgres*|ship-nucleus*|ship-web*|ship-worker*) die "refusing: scratch container name $1 collides with ship's own container names" ;; esac
  if docker inspect "$1" >/dev/null 2>&1; then die "refusing: a container named $1 already exists (scratch containers are always new)"; fi
}

# Start a new scratch postgres; $3 non-empty = an existing data dir to boot on.
pg_scratch_up() {
  local name="$1" image="$2" datadir="${3:-}" db="$4" user="$5" password="$6"
  local mount=()
  [ -z "$datadir" ] || mount=(-v "$datadir:$PG_MOUNT")
  docker run -d --name "$name" -p 127.0.0.1::5432 \
    -e POSTGRES_DB="$db" -e POSTGRES_USER="$user" -e POSTGRES_PASSWORD="$password" \
    ${mount[@]+"${mount[@]}"} "$image" >/dev/null
  local timeout="${SHIP_REHEARSE_TIMEOUT_S:-300}" elapsed=0
  # TCP inside the container: the image's init server listens on the socket
  # only, so a TCP answer means the FINAL server is up, not the init pass.
  until docker exec "$name" psql -h 127.0.0.1 -U "$user" -d "$db" -tAc 'SELECT 1' >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      docker logs "$name" || true
      die "scratch postgres did not answer SQL within ${timeout}s (see logs above)"
    fi
  done
}

pg_scratch_tables() {
  docker exec "$1" psql -h 127.0.0.1 -U "$2" -d "$3" -tA -F $'\t' -c "
    SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY 1" | tr -d '\r' | grep . | sort || true
}

# A manifest is data: its table names go into SQL, so they must be plain
# identifiers — [A-Za-z_][A-Za-z0-9_]*, optionally schema-qualified with the
# same shape — and nothing else is ever executed.
pg_table_name_ok() {
  local re='^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$'
  [[ $1 =~ $re ]] || die "refusing: table name from the manifest is not a plain (optionally schema-qualified) identifier: $1"
}

pg_scratch_count() {
  # Defence in depth on top of the call-site checks: never build SQL from a
  # name that is not a plain identifier.
  pg_table_name_ok "$4"
  docker exec "$1" psql -h 127.0.0.1 -U "$2" -d "$3" -tAc "SELECT count(*) FROM $4" | tr -d '\r'
}

# Restored table set and every row count must equal the manifest's. Prints a
# per-table line; returns non-zero on any mismatch.
pg_compare_counts() {
  local name="$1" user="$2" db="$3" archive="$4"
  local expected restored bad=0 table want got
  expected="$(manifest_tables "$archive")"
  [ -n "$expected" ] || { echo "no table counts in the manifest beside $archive — nothing to compare against" >&2; return 1; }
  restored="$(pg_scratch_tables "$name" "$user" "$db")"
  if [ "$(printf '%s\n' "$expected" | cut -f1 | sort)" != "$(printf '%s\n' "$restored" | sort)" ]; then
    echo "table set differs from the manifest:" >&2
    diff <(printf '%s\n' "$expected" | cut -f1 | sort) <(printf '%s\n' "$restored" | sort) >&2 || true
    bad=1
  fi
  while IFS=$'\t' read -r table want; do
    [ -n "$table" ] || continue
    # Validate in the MAIN shell: a die inside the $( ) below would exit only
    # the subshell (and its message is dropped by 2>/dev/null), turning a
    # refusal into a mere count mismatch.
    pg_table_name_ok "$table"
    got="$(pg_scratch_count "$name" "$user" "$db" "$table" 2>/dev/null || echo "?")"
    if [ "$got" = "$want" ]; then
      say "  ok        $table  $got"
    else
      say "  MISMATCH  $table  manifest $want, restored $got" >&2
      bad=1
    fi
  done <<<"$expected"
  return "$bad"
}

pg_restore_into() {
  local name="$1" user="$2" db="$3" archive="$4"
  # --no-owner: the scratch role is the dump's role by default, but a dump
  # taken under another user must still restore. --exit-on-error: a partial
  # restore is not a proof.
  docker exec -i "$name" pg_restore --exit-on-error --no-owner -U "$user" -d "$db" <"$archive"
}

# ---------------------------------------------------------------------------
# restore
# ---------------------------------------------------------------------------

cmd_restore() {
  local into="" name="" image=""
  local archive="${1:-}"; shift || true
  [ -n "$archive" ] || { usage >&2; die "restore needs an archive path"; }
  while [ $# -gt 0 ]; do
    case "$1" in
      --into) [ $# -ge 2 ] || die "--into needs a directory"; into="$2"; shift 2 ;;
      --name) [ $# -ge 2 ] || die "--name needs a value"; name="$2"; shift 2 ;;
      --image) [ $# -ge 2 ] || die "--image needs a value"; image="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die "restore: unknown argument: $1" ;;
    esac
  done
  if is_pg_dump "$archive"; then
    [ -z "$into" ] || die "a pg_dump archive restores into a NEW scratch postgres container, not a directory (drop --into; --name picks the container name)"
    restore_pg_dump "$archive" "$name" "$image"
    return 0
  fi
  [ -z "$name" ] || die "--name applies to pg_dump archives only"
  [ -n "$into" ] || die "restore requires --into <dir> (an empty, ISOLATED directory — never the live store)"
  verify_archive "$archive"

  if [ -d "$into" ] && [ -n "$(ls -A "$into")" ]; then
    die "refusing: target is not empty: $into (restore only ever unpacks into an empty, isolated dir)"
  fi

  local live target resolved_live resolved_target
  target="$(resolve_path "$into")"
  for live in "$SHIP_ROOT/$NUCLEUS_DATA_REL" "$SHIP_ROOT/$PG_DATA_REL" ${SHIP_PG_DATA_DIR:+"$SHIP_PG_DATA_DIR"}; do
    if [ -e "$live" ] || [ -d "$(dirname "$live")" ]; then
      resolved_live="$(resolve_path "$live")"
      resolved_target="$target"
      if [ "$resolved_target" = "$resolved_live" ]; then
        die "refusing: target IS the live store: $target"
      fi
      case "$resolved_live" in "$resolved_target"/*) die "refusing: target contains the live store ($resolved_live)"; esac
      case "$resolved_target" in "$resolved_live"/*) die "refusing: target is inside the live store ($resolved_live)"; esac
    fi
  done

  local root
  root="$(basename "$NUCLEUS_DATA_REL")"
  [ "$(basename "$archive")" != "$PG_COLD_NAME" ] || root="pgdata"
  mkdir -p "$into"
  tar xzf "$archive" -C "$into"
  say "restored into isolation: $target/$root"
  say "this is a proof copy. To prove it boots and answers: scripts/ship-backup.sh rehearse $archive"
  say "never unpack over the live store; a real recovery is a deliberate, writers-stopped operation"
}

restore_pg_dump() {
  local archive="$1" name="$2" image="$3"
  command -v docker >/dev/null 2>&1 || die "restoring a pg_dump needs docker (it starts a NEW scratch postgres container)"
  docker ps >/dev/null 2>&1 || die "docker is not reachable"
  verify_pg_dump "$archive"
  image="$(pg_scratch_image "$archive" "$image")"
  [ -n "$name" ] || name="ship-backup-restore-$$"
  pg_scratch_name_ok "$name"
  local db user password
  db="$(manifest_value "$archive" database)"; db="${db:-ship}"
  user="$(manifest_value "$archive" user)"; user="${user:-ship}"
  password="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  pg_scratch_up "$name" "$image" "" "$db" "$user" "$password"
  pg_restore_into "$name" "$user" "$db" "$archive" || { docker logs "$name" | tail -20 || true; die "pg_restore failed into scratch container $name (left in place for inspection: docker rm -f $name)"; }
  say "restored into a NEW scratch container: $name ($image), on $(docker port "$name" 5432/tcp | head -1)"
  if pg_compare_counts "$name" "$user" "$db" "$archive"; then
    say "table set and every row count match the manifest"
  else
    die "restored copy does NOT match the manifest (container $name left for inspection: docker rm -f $name)"
  fi
  say "connect: docker exec -it $name psql -U $user -d $db   (or PGPASSWORD=$password via the port above)"
  say "it stays running for inspection; remove it yourself: docker rm -f $name"
  say "never restore over the live accessory; a real recovery is a deliberate, writers-stopped operation"
}

# ---------------------------------------------------------------------------
# rehearse
# ---------------------------------------------------------------------------

cmd_rehearse() {
  local archive="${1:-}" image="${SHIP_NUCLEUS_IMAGE:-}" image_flag=""
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --image) [ $# -ge 2 ] || die "--image needs a value"; image="$2"; image_flag="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die "rehearse: unknown argument: $1" ;;
    esac
  done
  [ -n "$archive" ] || { usage >&2; die "rehearse needs an archive path"; }
  if is_pg_dump "$archive"; then rehearse_pg_dump "$archive" "$image_flag"; return 0; fi
  if [ "$(basename "$archive")" = "$PG_COLD_NAME" ]; then rehearse_pg_cold "$archive" "$image_flag"; return 0; fi
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
  # Same ownership check as the pg paths, BEFORE arming the trap: never
  # arm a cleanup for a container name this run does not exclusively own.
  pg_scratch_name_ok "$name"
  mkdir -p "$rehearsal"
  cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
    rm -rf "$rehearsal"
  }
  trap cleanup EXIT
  tar xzf "$archive" -C "$rehearsal"

  # Same posture as the teploy.yml accessory: no-auth pgwire, no clustering,
  # and the engine memory budget set above the 512 MB default so a real store
  # is not rejected on load during the proof. Explicitly name the restored
  # mount and local non-TLS transport: image defaults enable TLS, while the
  # rehearsal client uses plain pgwire on its loopback-only published port.
  docker run -d --name "$name" \
    -p 127.0.0.1::5432 \
    -v "$rehearsal/$(basename "$NUCLEUS_DATA_REL"):/data" \
    -e NUCLEUS_ALLOW_NO_AUTH=1 \
    -e NUCLEUS_ALLOW_INSECURE_CLUSTER=1 \
    -e NUCLEUS_ALLOW_INSECURE_REPLICATION=1 \
    -e NUCLEUS_MAX_MEMORY_MB="${SHIP_REHEARSE_MAX_MEMORY_MB:-1024}" \
    "$image" start --data /data --host 0.0.0.0 --no-tls \
      --max-memory "${SHIP_REHEARSE_MAX_MEMORY_MB:-1024}" >/dev/null

  local endpoint timeout elapsed=0
  endpoint="$(docker port "$name" 5432/tcp | head -1)"
  [ -n "$endpoint" ] || { docker logs "$name" || true; die "proof container published no port"; }
  timeout="${SHIP_REHEARSE_TIMEOUT_S:-300}"
  # Docker can accept TCP through its published-port proxy before Nucleus
  # finishes recovery. Require an actual SQL response inside the container;
  # an open proxy socket is not database readiness.
  until docker exec "$name" nucleus shell --host 127.0.0.1 --port 5432 \
    --command "SELECT 1" --json >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      docker logs "$name" || true
      die "proof engine did not answer SQL within ${timeout}s (see logs above)"
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

rehearse_pg_dump() {
  local archive="$1" image="$2"
  command -v docker >/dev/null 2>&1 || die "rehearse needs docker (it starts a scratch postgres proof container)"
  docker ps >/dev/null 2>&1 || die "docker is not reachable"
  verify_pg_dump "$archive"
  image="$(pg_scratch_image "$archive" "$image")"
  [ -n "$(manifest_tables "$archive")" ] || die "no table counts in the manifest beside $archive — a dump without its manifest cannot be proven against anything"
  local db user password
  db="$(manifest_value "$archive" database)"; db="${db:-ship}"
  user="$(manifest_value "$archive" user)"; user="${user:-ship}"
  password="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  # Global on purpose: the EXIT trap fires after this function has returned.
  name="ship-backup-proof-$$"
  pg_scratch_name_ok "$name"
  cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  pg_scratch_up "$name" "$image" "" "$db" "$user" "$password"
  if ! pg_restore_into "$name" "$user" "$db" "$archive"; then
    docker logs "$name" | tail -20 || true
    die "pg_restore failed into the scratch container — this archive is not proven"
  fi
  local endpoint
  endpoint="$(docker port "$name" 5432/tcp | head -1)"
  say "scratch postgres up on $endpoint ($image) — comparing the restored copy against the manifest"
  pg_compare_counts "$name" "$user" "$db" "$archive" || die "restored copy does NOT match the manifest — this archive is not proven"

  if command -v "${SHIP_BIN:-teploy-ship}" >/dev/null 2>&1; then
    say "running teploy-ship preflight --store postgres against the restored copy"
    if ! NUCLEUS_URL="postgres://${user}@${endpoint}/${db}?sslmode=disable" PGPASSWORD="$password" "${SHIP_BIN:-teploy-ship}" preflight --store postgres; then
      die "preflight failed against the restored copy — this archive is not proven"
    fi
  else
    say "# preflight skipped: no teploy-ship on PATH (set SHIP_BIN) — the table set and row counts are the proof" >&2
  fi
  say "rehearsal passed: dump restores into a scratch postgres, table set and every row count match the manifest"
  say "cleaning up: removing only the proof container ($name)"
}

rehearse_pg_cold() {
  local archive="$1" image="$2"
  command -v docker >/dev/null 2>&1 || die "rehearse needs docker (it starts a scratch postgres proof container)"
  docker ps >/dev/null 2>&1 || die "docker is not reachable"
  verify_archive "$archive"
  image="$(pg_scratch_image "$archive" "$image")"

  rehearsal="$SHIP_BACKUP_DIR/rehearsals/rehearse-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  name="ship-backup-proof-$$"
  pg_scratch_name_ok "$name"
  mkdir -p "$rehearsal"
  cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
    # The engine chowns the data dir to its own uid; remove through a
    # container when the host user cannot.
    rm -rf "$rehearsal" 2>/dev/null \
      || docker run --rm -v "$rehearsal:/r" --entrypoint rm "$image" -rf /r/pgdata >/dev/null 2>&1 || true
    rm -rf "$rehearsal" 2>/dev/null || true
  }
  trap cleanup EXIT
  tar xzf "$archive" -C "$rehearsal"
  [ -f "$rehearsal/pgdata/PG_VERSION" ] || die "archive holds no pgdata/PG_VERSION — not a postgres data dir"

  # The copy keeps the live store's own roles and pg_hba; loopback inside the
  # container is trusted by the official image, which is all the probes use.
  local db user
  db="$(manifest_value "$archive" database)"; db="${db:-${SHIP_PG_DB:-ship}}"
  user="$(manifest_value "$archive" user)"; user="${user:-${SHIP_PG_USER:-ship}}"
  pg_scratch_up "$name" "$image" "$rehearsal/pgdata" "$db" "$user" "unused-existing-cluster"
  say "scratch postgres booted on the isolated copy ($image) — reading every table's count"
  local tables table n total=0
  tables="$(pg_scratch_tables "$name" "$user" "$db")"
  [ -n "$tables" ] || die "the restored cluster has no user tables in $db — this archive is not proven"
  while read -r table; do
    pg_table_name_ok "$table"   # main shell: the die must refuse, not vanish in a $( )
    n="$(pg_scratch_count "$name" "$user" "$db" "$table")" || die "could not count $table in the restored copy"
    say "  $table  $n"
    total=$((total + 1))
  done <<<"$tables"
  say "rehearsal passed: cold pgdata archive boots and answers ($total tables counted; a cold manifest carries no counts to compare)"
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
