#!/usr/bin/env bash
set -euo pipefail

# Pushes the dashboards in this directory to a Grafana instance, replacing
# the copies that carry the same uid.
#
# Upload-by-hand works exactly once. After that every change to the JSON here
# — a renamed metric, a new panel — has to be re-uploaded by someone who
# remembers, and the copy in Grafana quietly stops matching the one in git.
# The product rename is the case in point: the dashboards imported as Lexi
# kept asking for lexi_* and {job="lexi"} after nothing fed them any more.
# This makes the files in the repository the source of truth.
#
# Needs a service account token with the Editor role (Administration →
# Users and access → Service accounts → Add service account → Add token).
# The token is read from the environment and sent only as a header; nothing
# here prints it.
#
#   GRAFANA_URL=https://<stack>.grafana.net GRAFANA_TOKEN=glsa_... \
#     ops/monitoring/grafana/push-dashboards.sh [--remove-old] [--dry-run]

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARDS=("${SCRIPT_DIR}"/dashboard-*.json)
# Imported under the pre-rename name; nothing has fed them since 2026-09-16.
OLD_UIDS=(lexi-health lexi-requests)
REMOVE_OLD=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: ops/monitoring/grafana/push-dashboards.sh [--remove-old] [--dry-run]

Pushes every dashboard-*.json in this directory to $GRAFANA_URL, overwriting
the dashboard with the same uid. Creates it when there is none.

  --remove-old   Also delete the dashboards imported under the pre-rename
                 uids (lexi-health, lexi-requests). Absent ones are skipped.
  --dry-run      Print what would be sent; send nothing. Needs no token.

Environment:
  GRAFANA_URL    The stack, e.g. https://<name>.grafana.net (no trailing /api).
  GRAFANA_TOKEN  A service account token with the Editor role. Never printed.
USAGE
}

die() { echo "push-dashboards: $*" >&2; exit 1; }
note() { echo "push-dashboards: $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --remove-old) REMOVE_OLD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

command -v python3 >/dev/null 2>&1 || die "python3 is needed to build the request body"
[ "${#DASHBOARDS[@]}" -gt 0 ] && [ -f "${DASHBOARDS[0]}" ] || die "no dashboard-*.json next to this script"

if [ "$DRY_RUN" -eq 0 ]; then
  [ -n "${GRAFANA_URL:-}" ] || die "GRAFANA_URL is not set"
  [ -n "${GRAFANA_TOKEN:-}" ] || die "GRAFANA_TOKEN is not set"
fi
GRAFANA_URL="${GRAFANA_URL:-https://example.grafana.net}"
GRAFANA_URL="${GRAFANA_URL%/}"

# Grafana's import body: the dashboard with `id` cleared (an id from another
# instance is refused), `overwrite` so the same uid is replaced rather than
# rejected as a duplicate, and the commit as the version message so the
# dashboard's own history says which checkout it came from.
request_body() {
  local file="$1" message="$2"
  python3 - "$file" "$message" <<'PY'
import json, sys
dashboard = json.load(open(sys.argv[1]))
dashboard["id"] = None
print(json.dumps({"dashboard": dashboard, "overwrite": True, "message": sys.argv[2]}))
PY
}

# One request; prints "<http status>\t<body>" so a failure can be told apart
# from a success without a second call. The token goes only in the header.
call() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -m 30 -X "$method" "${GRAFANA_URL}${path}" \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    -H 'Accept: application/json' -w '\n%{http_code}')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary @-)
  local out
  out="$(printf '%s' "$body" | curl "${args[@]}")" || die "curl failed against ${GRAFANA_URL}${path}"
  printf '%s\t%s\n' "${out##*$'\n'}" "${out%$'\n'*}"
}

message="pushed from $(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo 'a checkout without git')"

for file in "${DASHBOARDS[@]}"; do
  uid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uid"])' "$file")"
  title="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["title"])' "$file")"
  body="$(request_body "$file" "$message")"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would POST ${GRAFANA_URL}/api/dashboards/db: uid=${uid} title=\"${title}\" ($(printf '%s' "$body" | wc -c | tr -d ' ') bytes)"
    continue
  fi
  out="$(call POST /api/dashboards/db "$body")"
  status="${out%%$'\t'*}"; reply="${out#*$'\t'}"
  case "$status" in
    200) note "pushed \"${title}\" -> ${GRAFANA_URL}$(printf '%s' "$reply" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')" ;;
    401 | 403) die "Grafana refused the token for \"${title}\" (HTTP ${status}): it needs the Editor role" ;;
    *) die "pushing \"${title}\" failed (HTTP ${status}): ${reply}" ;;
  esac
done

if [ "$REMOVE_OLD" -eq 1 ]; then
  for uid in "${OLD_UIDS[@]}"; do
    if [ "$DRY_RUN" -eq 1 ]; then
      note "would DELETE ${GRAFANA_URL}/api/dashboards/uid/${uid}"
      continue
    fi
    out="$(call DELETE "/api/dashboards/uid/${uid}")"
    status="${out%%$'\t'*}"; reply="${out#*$'\t'}"
    case "$status" in
      200) note "removed the pre-rename dashboard ${uid}" ;;
      404) note "no dashboard ${uid} to remove" ;;
      *) die "removing ${uid} failed (HTTP ${status}): ${reply}" ;;
    esac
  done
fi

[ "$DRY_RUN" -eq 1 ] && note "dry run; nothing was sent" || note "done. Open Dashboards in Grafana; both carry the version message \"${message}\"."
