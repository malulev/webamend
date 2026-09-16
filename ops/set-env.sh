#!/usr/bin/env bash
set -euo pipefail

# Sets (or removes) one variable in every client's .env and recreates the app
# container so the change takes effect. Run as root on the client host.
#
# A client's .env is read by docker compose when the container is CREATED, so
# editing the file changes nothing that is running, and `docker compose
# restart` does not re-read it either. Each client is edited, the file is
# checked, and only then is its container recreated — one client at a time,
# so a mistake stops at the first client instead of taking the host down.
#
# The check matters more than it looks. Compose refuses an .env with a line it
# cannot parse ("invalid environment variable: ="), and by the time it says
# so with --force-recreate the old container is already gone. So the file is
# validated before the recreate, and a file that fails is restored from its
# backup and its container is left alone.
#
# Values are never printed: not in notes, not in the summary, not in errors.

usage() {
  cat <<'USAGE'
Usage: ops/set-env.sh NAME VALUE   [--client <slug>] [--no-recreate] [--dry-run]
       ops/set-env.sh --secret NAME [--client <slug>] [--no-recreate] [--dry-run]
       ops/set-env.sh --unset NAME  [--client <slug>] [--no-recreate] [--dry-run]

Sets NAME=VALUE in each client's /srv/webamend/<slug>/.env (replacing an
existing line or appending one), validates the file, and recreates the app
container. Run as root.

Forms:
  NAME VALUE        Plain value on the command line. Fine for addresses and
                    ids; not for secrets (the value lands in shell history).
  --secret NAME     Prompts for the value with echo off.
  --unset NAME      Removes the line.

Options:
  --client <slug>   Only this client. Default: every client with an .env.
  --no-recreate     Edit the files, restart nothing. The change takes effect
                    on the next `ops/release.sh` or manual recreate.
  --dry-run         Report what would change; write nothing.
  -h, --help        Show this message.

Refused: PORT (never in a client .env), names owned by provisioning or
release (PUBLIC_BASE_URL, WEBAGENT_STATE_DIR, DOCKER_SOCK, PORT_HOST,
APP_IMAGE, AGENT_IMAGE, APP_SHA, SLOT_BROKER_SOCKET), multi-line values
(use `ops/launch-client.sh --values` for a PEM).

Examples:
  ops/set-env.sh SMTP_FROM hello@webamend.com
  ops/set-env.sh --secret OPENROUTER_API_KEY --client acme
  ops/set-env.sh --unset LOG_LEVEL --dry-run
USAGE
}

CLIENT_ROOT="${CLIENT_ROOT:-/srv/webamend}"
HEALTH_TIMEOUT=120
NAME=""
VALUE=""
MODE="set"        # set | unset
ONLY_CLIENT=""
RECREATE=1
DRY_RUN=0

die() {
  echo "set-env: $*" >&2
  exit 1
}
note() {
  echo "set-env: $*"
}

parse_args() {
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --secret)
        [ $# -ge 2 ] || die "--secret needs a NAME"
        NAME="$2"
        MODE="secret"
        shift 2
        ;;
      --unset)
        [ $# -ge 2 ] || die "--unset needs a NAME"
        NAME="$2"
        MODE="unset"
        shift 2
        ;;
      --client)
        [ $# -ge 2 ] || die "--client needs a slug"
        ONLY_CLIENT="$2"
        shift 2
        ;;
      --no-recreate) RECREATE=0; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help) usage; exit 0 ;;
      --*) die "unknown option $1" ;;
      *) positional+=("$1"); shift ;;
    esac
  done

  case "$MODE" in
    set)
      [ ${#positional[@]} -eq 2 ] || { usage >&2; exit 1; }
      NAME="${positional[0]}"
      VALUE="${positional[1]}"
      ;;
    secret | unset)
      [ ${#positional[@]} -eq 0 ] || die "unexpected argument '${positional[0]}'"
      ;;
  esac
}

validate_name() {
  [[ "$NAME" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "'${NAME}' is not a variable name (A-Z, 0-9 and _; starts with a letter)"
  case "$NAME" in
    PORT) die "PORT must never be set in a client .env; PORT_HOST is filled in by provisioning" ;;
    PUBLIC_BASE_URL | WEBAGENT_STATE_DIR | DOCKER_SOCK | PORT_HOST | APP_IMAGE | AGENT_IMAGE | APP_SHA | SLOT_BROKER_SOCKET)
      die "${NAME} is owned by provisioning and release; edit it through those scripts"
      ;;
  esac
}

read_value() {
  if [ "$MODE" = "secret" ]; then
    read -rsp "Value for ${NAME}: " VALUE
    echo
    MODE="set"
  fi
  [ "$MODE" = "unset" ] && return 0
  [ -n "$VALUE" ] || die "an empty value is not a setting; use --unset to remove ${NAME}"
  case "$VALUE" in
    *$'\n'*) die "multi-line values are not supported here; use ops/launch-client.sh --values" ;;
  esac
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root to recreate containers (it acts as every client user). Try: sudo $0 ..., or add --no-recreate"
}

# See provision-client.sh and release.sh: the same environment, for the same reasons.
run_as_client() {
  local slug="$1"
  shift
  local uid
  uid="$(id -u "$slug")"
  runuser -u "$slug" -- env -C / \
    HOME="$(getent passwd "$slug" | cut -d: -f6)" \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    DOCKER_HOST="unix:///run/user/${uid}/docker.sock" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

# The file stays owned by the client user at 0600. Unprivileged runs (the
# tests, or an operator doing a --no-recreate edit on a copy) skip the chown.
own_like_client() {
  local path="$1" slug="$2"
  chmod 0600 "$path"
  if [ "$(id -u)" -eq 0 ] && id -u "$slug" >/dev/null 2>&1; then
    chown "${slug}:${slug}" "$path"
  fi
}

# Prints the number of the first line that is neither blank, a comment, a
# NAME=value line, nor the continuation of a double-quoted multi-line value
# (the shape a PEM arrives in). Prints nothing when the file is clean.
first_bad_line() {
  awk '
    open { if ($0 ~ /"$/) open = 0; next }
    /^[[:space:]]*$/ || /^#/ { next }
    /^[A-Z][A-Z0-9_]*=/ {
      rest = substr($0, index($0, "=") + 1)
      if (rest ~ /^"/ && rest !~ /^".*"$/) open = 1
      next
    }
    { print NR; exit }
  ' "$1"
}

# What the edit would do to this file: replace | add | remove | absent.
plan_for() {
  local env_file="$1"
  if grep -qE "^${NAME}=" "$env_file"; then
    [ "$MODE" = "unset" ] && echo remove || echo replace
  else
    [ "$MODE" = "unset" ] && echo absent || echo add
  fi
}

# Rewrites through a temp file in the same directory so the swap is atomic
# and the file is never half-written. awk reads the value from the
# environment, not from -v, so backslashes in it survive untouched. A name
# that appears more than once collapses to one line.
write_edit() {
  local env_file="$1" tmp="$2"
  if [ "$MODE" = "unset" ]; then
    NAME="$NAME" awk '
      index($0, ENVIRON["NAME"] "=") == 1 { next }
      { print }
    ' "$env_file" >"$tmp"
  else
    NAME="$NAME" VALUE="$VALUE" awk '
      BEGIN { n = ENVIRON["NAME"]; v = ENVIRON["VALUE"]; done = 0 }
      index($0, n "=") == 1 { if (!done) { print n "=" v; done = 1 }; next }
      { print }
      END { if (!done) print n "=" v }
    ' "$env_file" >"$tmp"
  fi
}

wait_for_http() {
  local port="$1" deadline code
  deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}/api/health" || true)"
    case "$code" in 200 | 404) return 0 ;; esac
    sleep 3
  done
  return 1
}

recreate_client() {
  local slug="$1" dir="$2" env_file="$3" port
  port="$(grep -E '^PORT_HOST=' "$env_file" | tail -n 1 | cut -d= -f2- || true)"
  [ -n "$port" ] || { echo "PORT_HOST is not set"; return 1; }
  if ! run_as_client "$slug" docker compose -f "${dir}/docker-compose.yml" --project-directory "$dir" \
      up -d --force-recreate app >/dev/null 2>&1; then
    echo "'docker compose up -d --force-recreate' failed"
    return 1
  fi
  if ! wait_for_http "$port"; then
    echo "not answering on 127.0.0.1:${port}/api/health after ${HEALTH_TIMEOUT}s; see docker logs"
    return 1
  fi
  return 0
}

RESULTS=()
FAILED=0
record() { RESULTS+=("$(printf '%-16s %s' "$1" "$2")"); }

# One client: plan, edit, validate (restore on failure), recreate.
apply_to_client() {
  local slug="$1"
  local dir="${CLIENT_ROOT}/${slug}" env_file="${CLIENT_ROOT}/${slug}/.env"
  local plan tmp backup bad reason

  plan="$(plan_for "$env_file")"

  if [ "$DRY_RUN" -eq 1 ]; then
    case "$plan" in
      absent) note "${slug}: ${NAME} not set; nothing to remove" ;;
      *) note "${slug}: would ${plan} ${NAME}" ;;
    esac
    record "$slug" "dry run: would ${plan}"
    return 0
  fi

  if [ "$plan" = "absent" ]; then
    record "$slug" "unchanged (${NAME} not set)"
    return 0
  fi

  backup="$(mktemp "${dir}/.env.bak.XXXXXX")"
  cp -p "$env_file" "$backup"
  own_like_client "$backup" "$slug"

  tmp="$(mktemp "${dir}/.env.new.XXXXXX")"
  write_edit "$env_file" "$tmp"
  own_like_client "$tmp" "$slug"
  mv -- "$tmp" "$env_file"

  bad="$(first_bad_line "$env_file")"
  if [ -n "$bad" ]; then
    mv -- "$backup" "$env_file"
    reason=".env line ${bad} is not NAME=value; restored, not restarted"
    echo "  ${slug}: ${reason}" >&2
    record "$slug" "FAILED: ${reason}"
    FAILED=1
    return 0
  fi
  rm -f -- "$backup"

  if [ "$RECREATE" -eq 0 ]; then
    record "$slug" "${plan}d ${NAME}; not restarted"
    return 0
  fi

  note "${slug}: ${NAME} ${plan}d; recreating app"
  if reason="$(recreate_client "$slug" "$dir" "$env_file")"; then
    record "$slug" "${plan}d ${NAME}; restarted, healthy"
  else
    echo "  ${slug}: ${reason}" >&2
    record "$slug" "FAILED after edit: ${reason}"
    FAILED=1
  fi
}

client_slugs() {
  local dir
  if [ -n "$ONLY_CLIENT" ]; then
    [ -f "${CLIENT_ROOT}/${ONLY_CLIENT}/.env" ] || die "no client '${ONLY_CLIENT}' under ${CLIENT_ROOT}"
    echo "$ONLY_CLIENT"
    return 0
  fi
  for dir in "${CLIENT_ROOT}"/*/; do
    [ -f "${dir}.env" ] || continue
    basename "$dir"
  done
}

print_summary() {
  local line
  echo
  printf '%-16s %s\n' CLIENT RESULT
  for line in "${RESULTS[@]}"; do
    echo "$line"
  done
}

main() {
  parse_args "$@"
  validate_name
  read_value
  if [ "$RECREATE" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
    require_root
  fi

  local slugs slug
  slugs="$(client_slugs)"
  [ -n "$slugs" ] || die "no clients under ${CLIENT_ROOT}"

  for slug in $slugs; do
    apply_to_client "$slug"
  done

  print_summary
  [ "$FAILED" -eq 0 ] || exit 1
}

main "$@"
