#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# One line per client, and the one number that is nobody else's job to know.
#
# Under this topology every client has its own rootless daemon, so there is no
# single place to ask "what is running on this box". `docker ps` as root sees
# the registry and nothing else — every application and every agent container
# lives on a daemon root is not talking to. This script is that missing view:
# it asks each client's daemon in turn and adds the answers up.
#
# The agent count matters more than it looks. Each installation serves one
# site and its site lock bounds it to one run at a time, so the host's ceiling
# is the number of clients — every one of them could be running an agent at
# once, and nothing in the application can see across installations to stop
# it. The TOTAL line below is where you find out how close that is. Host-wide
# admission is the lease daemon designed in
# docs/superpowers/specs/2026-09-14-host-admission-queue-design.md.
#
# Read-only. It starts nothing, stops nothing and writes nothing.

usage() {
  cat <<'USAGE'
Usage: ops/status.sh [<slug>] [--logs] [--tail <lines>]

Reports, for every client installation under /srv/lexi (or just <slug>):
whether its rootless daemon is up, whether its app container is running,
whether its loopback port answers HTTP, how many agent containers are running
on its daemon, and which image tag is deployed. Ends with the host-wide agent
total. Run as root.

Arguments:
  <slug>          Report on this client only.

Options:
  --prom      Prometheus text format, for a node_exporter textfile collector.
              Emitted from the same rows as the table, so there is one
              implementation of "become the client and ask its daemon".
  --json      One JSON object per client plus a totals object. This is the
              machine contract ops/probe.sh consumes; the table is for people.
  --quiet     Print nothing; report only through the exit status. For a
              systemd timer or a heartbeat: `ops/status.sh --quiet && ping`.
  --logs          Also print the app container's recent log for each client
                  reported. Startup validation refuses to serve on a bad
                  setting and names it, so this is where a failed roll explains
                  itself.
  --tail <lines>  Log lines per client with --logs (default 50).
  -h, --help      Show this message.
USAGE
}

CLIENT_ROOT=/srv/lexi
ONLY_CLIENT=""
SHOW_LOGS=0
QUIET=0
JSON=0
PROM=0
WITH_DU=0
UNHEALTHY=()
TAIL_LINES=50
TOTAL_AGENTS=0

die() {
  echo "status: $*" >&2
  exit 1
}

parse_args() {
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --logs)
        SHOW_LOGS=1
        shift
        ;;
      --quiet)
        QUIET=1
        shift
        ;;
      --json)
        JSON=1
        shift
        ;;
      --prom)
        PROM=1
        shift
        ;;
      --full)
        WITH_DU=1
        shift
        ;;
      --tail)
        [ $# -ge 2 ] || die "--tail needs a number of lines"
        TAIL_LINES="$2"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*)
        usage >&2
        die "unknown option: $1"
        ;;
      *)
        positional+=("$1")
        shift
        ;;
    esac
  done

  if [ "${#positional[@]}" -gt 1 ]; then
    usage >&2
    die "expected at most one slug, got ${#positional[@]}: ${positional[*]}"
  fi
  [ "${#positional[@]}" -eq 1 ] && ONLY_CLIENT="${positional[0]}"

  case "$TAIL_LINES" in
    '' | *[!0-9]*) die "--tail must be a whole number, got: ${TAIL_LINES}" ;;
  esac
  if [ -n "$ONLY_CLIENT" ] && [ ! -d "${CLIENT_ROOT}/${ONLY_CLIENT}" ]; then
    die "no client at ${CLIENT_ROOT}/${ONLY_CLIENT}"
  fi
  return 0
}

require_root() {
  # Not vanity: reading each client's daemon means becoming each client, and
  # /srv/lexi/<slug> is 0700 for exactly the reason that nobody else can.
  [ "$(id -u)" -eq 0 ] || die "must run as root (it reads every client's 0700 directory and daemon). Try: sudo $0"
}

# See provision-client.sh: the same environment, for the same reason.
run_as_client() {
  local slug="$1"
  shift
  local uid
  uid="$(id -u "$slug")"
  # `-C /`: runuser does not change directory, so these commands inherit the
  # caller's cwd. Called from a root-only directory (/root, say), the client
  # user cannot stat `.`, and `docker compose` fails validation with
  # "stat .: permission denied" — which this script would otherwise report as
  # a *stopped* installation. A monitor that says down for a cwd it could not
  # read is worse than no monitor.
  runuser -u "$slug" -- env -C / \
    HOME="$(getent passwd "$slug" | cut -d: -f6)" \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    DOCKER_HOST="unix:///run/user/${uid}/docker.sock" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

read_env_value() {
  local env_file="$1" name="$2"
  [ -f "$env_file" ] || return 0
  grep -E "^${name}=" "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

# Healthy means every layer a client's editing actually needs: the daemon
# answers, the app container is running, and it serves HTTP. Any status code
# counts as serving — `/` legitimately redirects an unauthenticated caller —
# so only literal NO-ANSWER, or no port at all, is dead.
is_healthy() {
  local row="$1" daemon app http
  daemon="$(printf '%s' "$row" | cut -f2)"
  app="$(printf '%s' "$row" | cut -f3)"
  http="$(printf '%s' "$row" | cut -f4)"
  [ "$daemon" = "up" ] || return 1
  [ "$app" = "running" ] || return 1
  case "$http" in
    *NO-ANSWER* | 'no PORT_HOST') return 1 ;;
  esac
  return 0
}

report_client() {
  local slug="$1"
  local dir="${CLIENT_ROOT}/${slug}"
  local env_file="${dir}/.env"
  local daemon="down" app="-" http="-" ready="-" agents="-" image="-"
  local port limit cid running code count ready_body

  if ! id -u "$slug" >/dev/null 2>&1; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$slug" "no-user" "-" "-" "-" "-" "-"
    return 0
  fi

  if run_as_client "$slug" docker info >/dev/null 2>&1; then
    daemon="up"
  fi

  if [ "$daemon" = "up" ]; then
    cid="$(run_as_client "$slug" docker compose -f "${dir}/docker-compose.yml" --project-directory "$dir" ps -q app 2>/dev/null | head -n 1 || true)"
    if [ -n "$cid" ]; then
      running="$(run_as_client "$slug" docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
      if [ "$running" = "true" ]; then app="running"; else app="stopped"; fi
      image="$(run_as_client "$slug" docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || echo '?')"
    else
      app="absent"
    fi

    # The exact label the application filters on; see AGENT_LABEL in
    # src/lib/runner/slots.ts. If that constant ever changes, this line is
    # wrong silently rather than loudly, which is worth knowing.
    count="$(run_as_client "$slug" docker ps --filter 'label=webagent.agent=true' --quiet 2>/dev/null | grep -c . || true)"
    [ -n "$count" ] || count=0

    agents="${count}"
  fi

  port="$(read_env_value "$env_file" PORT_HOST)"
  if [ -n "$port" ]; then
    # /api/health, not `/`. `/` answers 307 to an unauthenticated caller
    # whether the installation is well or wedged, so it cannot distinguish
    # them; the liveness route means exactly one thing and does no I/O.
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}/api/health" || true)"
    if [ -z "$code" ] || [ "$code" = "000" ]; then
      http=":${port} NO-ANSWER"
    elif [ "$code" = "200" ]; then
      http=":${port} ok"
    else
      http=":${port} ${code}"
    fi

    # Readiness is the different question: the process answers, but can it
    # still reach GitHub and the hosting site? 503 names the settings at
    # fault. An installation built before this route existed answers 404, and
    # is reported as unknown rather than as broken.
    ready_body="$(curl -s --max-time 8 "http://127.0.0.1:${port}/api/ready" || true)"
    case "$ready_body" in
      *'"status":"ready"'*) ready="ready" ;;
      *'"faults":'*)
        ready="degraded($(printf '%s' "$ready_body" |
          sed -n 's/.*"faults":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' '))"
        ;;
      *) ready="?" ;;
    esac
  else
    http="no PORT_HOST"
    ready="?"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$slug" "$daemon" "$app" "$http" "$ready" "$agents" "$image"
}

print_logs() {
  local slug="$1"
  local dir="${CLIENT_ROOT}/${slug}"
  echo
  echo "--- ${slug}: last ${TAIL_LINES} log lines ---"
  run_as_client "$slug" docker compose \
    -f "${dir}/docker-compose.yml" --project-directory "$dir" \
    logs --tail "$TAIL_LINES" app 2>&1 || echo "(no log; the container may never have started)"
}

# The same rows the table renders, as JSON. Hand-built rather than piped
# through jq: this runs on a freshly bootstrapped host, and requiring jq here
# would mean a monitoring script that fails on exactly the box that most needs
# it. Every value is a controlled shape — slugs, states, integers, image tags
# — so quoting them is the whole escaping problem.
# Prometheus text format. Written from the same rows as everything else.
#
# `lexi_clients_total` is the line this whole file exists to produce: each
# client can run one agent at a time and nothing in the product can see across
# clients, so the number of clients IS the host's agent ceiling, and that
# ceiling against the host's actual memory is a number only this script can
# report. An alert needs it.
#
# Label discipline: `slug` only, and it is bounded by the number of clients.
# The image tag rides a separate info metric with a constant value of 1 — the
# standard pattern — so a release churns one series per client instead of
# multiplying every gauge by every version ever deployed.
emit_prom() {
  local row slug daemon app http ready agents image running healthy state_bytes

  echo '# HELP lexi_client_app_up The client application container is running.'
  echo '# TYPE lexi_client_app_up gauge'
  for row in "${rows[@]}"; do
    slug="$(printf '%s' "$row" | cut -f1)"
    app="$(printf '%s' "$row" | cut -f3)"
    [ "$app" = "running" ] && echo "lexi_client_app_up{slug=\"${slug}\"} 1" || echo "lexi_client_app_up{slug=\"${slug}\"} 0"
  done

  echo '# HELP lexi_client_daemon_up The client rootless Docker daemon answers.'
  echo '# TYPE lexi_client_daemon_up gauge'
  for row in "${rows[@]}"; do
    slug="$(printf '%s' "$row" | cut -f1)"
    daemon="$(printf '%s' "$row" | cut -f2)"
    [ "$daemon" = "up" ] && echo "lexi_client_daemon_up{slug=\"${slug}\"} 1" || echo "lexi_client_daemon_up{slug=\"${slug}\"} 0"
  done

  echo '# HELP lexi_client_health_ok The liveness route answers 200.'
  echo '# TYPE lexi_client_health_ok gauge'
  echo '# HELP lexi_client_ready_ok The installation can still reach everything it needs.'
  echo '# TYPE lexi_client_ready_ok gauge'
  for row in "${rows[@]}"; do
    slug="$(printf '%s' "$row" | cut -f1)"
    http="$(printf '%s' "$row" | cut -f4)"
    ready="$(printf '%s' "$row" | cut -f5)"
    case "$http" in *' ok') echo "lexi_client_health_ok{slug=\"${slug}\"} 1" ;; *) echo "lexi_client_health_ok{slug=\"${slug}\"} 0" ;; esac
    case "$ready" in
      ready) echo "lexi_client_ready_ok{slug=\"${slug}\"} 1" ;;
      # `?` means the route is absent (an older image) — unknown, not broken,
      # and emitting 0 would page someone for a version skew.
      '?') ;;
      *) echo "lexi_client_ready_ok{slug=\"${slug}\"} 0" ;;
    esac
  done

  echo '# HELP lexi_client_agents_running Agent containers on that client daemon.'
  echo '# TYPE lexi_client_agents_running gauge'
  for row in "${rows[@]}"; do
    slug="$(printf '%s' "$row" | cut -f1)"
    running="$(printf '%s' "$row" | cut -f6)"
    case "$running" in '' | *[!0-9]*) running=0 ;; esac
    echo "lexi_client_agents_running{slug=\"${slug}\"} ${running}"
  done

  echo '# HELP lexi_client_info Deployed image and commit, as labels on a constant.'
  echo '# TYPE lexi_client_info gauge'
  for row in "${rows[@]}"; do
    slug="$(printf '%s' "$row" | cut -f1)"
    image="$(printf '%s' "$row" | cut -f7)"
    echo "lexi_client_info{slug=\"${slug}\",image=\"${image}\",sha=\"$(read_env_value "${CLIENT_ROOT}/${slug}/.env" APP_SHA)\"} 1"
  done

  echo '# HELP lexi_client_state_bytes Disk under that client'"'"'s state directory.'
  echo '# TYPE lexi_client_state_bytes gauge'
  for row in "${rows[@]}"; do
    slug="$(printf '%s' "$row" | cut -f1)"
    # Only with --full: du over a git mirror is not free, and the disk ALERT
    # comes from df via node_exporter. This is for attribution — which mirror
    # grew — so a slower cadence is right.
    if [ "$WITH_DU" -eq 1 ]; then
      state_bytes="$(du -sb "${CLIENT_ROOT}/${slug}" 2>/dev/null | cut -f1)"
      [ -n "$state_bytes" ] && echo "lexi_client_state_bytes{slug=\"${slug}\"} ${state_bytes}"
    fi
  done

  echo '# HELP lexi_agents_running_total Agent containers across every client daemon.'
  echo '# TYPE lexi_agents_running_total gauge'
  echo "lexi_agents_running_total ${TOTAL_AGENTS}"
  echo '# HELP lexi_clients_total Clients on this host. Each runs at most one agent, so this is the agent ceiling; compare with free memory.'
  echo '# TYPE lexi_clients_total gauge'
  echo "lexi_clients_total ${#clients[@]}"
  echo '# HELP lexi_clients_unhealthy Clients failing daemon, app or HTTP.'
  echo '# TYPE lexi_clients_unhealthy gauge'
  echo "lexi_clients_unhealthy ${#UNHEALTHY[@]}"
  echo '# HELP lexi_maintenance A release is in progress; app-down alerts should hold.'
  echo '# TYPE lexi_maintenance gauge'
  [ -f /var/lib/lexi/maintenance ] && echo 'lexi_maintenance 1' || echo 'lexi_maintenance 0'
}

emit_json() {
  local row slug daemon app http ready agents image first=1
  printf '{"clients":['
  for row in "${rows[@]}"; do
    slug="$(printf '%s' "$row" | cut -f1)"
    daemon="$(printf '%s' "$row" | cut -f2)"
    app="$(printf '%s' "$row" | cut -f3)"
    http="$(printf '%s' "$row" | cut -f4)"
    ready="$(printf '%s' "$row" | cut -f5)"
    agents="$(printf '%s' "$row" | cut -f6)"
    image="$(printf '%s' "$row" | cut -f7)"
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"slug":"%s","daemon":"%s","app":"%s","http":"%s","ready":"%s","agents_running":%s,"image":"%s","healthy":%s}' \
      "$slug" "$daemon" "$app" "${http#*\ }" "$ready" \
      "$(printf '%s' "$agents" | grep -E '^[0-9]+$' || echo 0)" \
      "$image" \
      "$(is_healthy "$row" && echo true || echo false)"
  done
  printf '],"totals":{"clients":%s,"agents_running":%s,"unhealthy":%s}}\n' \
    "${#clients[@]}" "$TOTAL_AGENTS" "${#UNHEALTHY[@]}"
}

main() {
  parse_args "$@"
  require_root
  [ -d "$CLIENT_ROOT" ] || die "${CLIENT_ROOT} does not exist. Run ops/bootstrap-host.sh first."

  local dir slug row agents_field rows=() clients=()
  for dir in "$CLIENT_ROOT"/*/; do
    [ -d "$dir" ] || continue
    slug="$(basename -- "$dir")"
    [ -n "$ONLY_CLIENT" ] && [ "$slug" != "$ONLY_CLIENT" ] && continue
    clients+=("$slug")
    # Captured in a subshell, so report_client cannot add to a running total
    # itself — the AGENTS column is parsed back out below instead. Worth the
    # small indirection: the alternative is a temporary file for one integer.
    row="$(report_client "$slug")"
    rows+=("$row")
    agents_field="$(printf '%s' "$row" | cut -f6)"
    case "$agents_field" in
      '' | *[!0-9]*) ;;
      *) TOTAL_AGENTS=$((TOTAL_AGENTS + agents_field)) ;;
    esac
    is_healthy "$row" || UNHEALTHY+=("$slug")
  done

  if [ "${#clients[@]}" -eq 0 ]; then
    [ "$QUIET" -eq 1 ] && exit 0
    echo "status: no clients under ${CLIENT_ROOT}. Provision one: ops/provision-client.sh <slug> <hostname> <port>"
    exit 0
  fi

  if [ "$PROM" -eq 1 ]; then
    emit_prom
    exit 0
  fi

  if [ "$JSON" -eq 1 ]; then
    emit_json
    [ "${#UNHEALTHY[@]}" -eq 0 ] || exit 1
    exit 0
  fi

  # --quiet reports only through the exit status, for a timer or an `&&`.
  if [ "$QUIET" -eq 1 ]; then
    [ "${#UNHEALTHY[@]}" -eq 0 ] || die "unhealthy: ${UNHEALTHY[*]}"
    exit 0
  fi

  {
    printf 'CLIENT\tDAEMON\tAPP\tHTTP\tREADY\tAGENTS\tIMAGE\n'
    printf '%s\n' "${rows[@]}"
  } | column -t -s $'\t' 2>/dev/null || printf '%s\n' "${rows[@]}"

  echo
  echo "TOTAL agent containers running across ${#clients[@]} client daemon(s): ${TOTAL_AGENTS}"
  echo "Each holds roughly 400 MB of RAM. Every client can run one at a time, so ${#clients[@]} is this host's ceiling."
  if [ -S /run/lexi/slotd.sock ]; then
    if slots_json="$(python3 "${SCRIPT_DIR}/slotd/lexi_slotd.py" status --socket /run/lexi/slotd.sock 2>/dev/null)"; then
      # Plain %-formatting, and no backslashes: the program is already inside
      # single quotes, so a double quote needs no escaping, and an escaped one
      # reaches Python as a backslash — which inside an f-string expression is
      # a SyntaxError, so this line printed a traceback and a bare "SLOTS".
      echo "SLOTS $(printf '%s' "$slots_json" | python3 -c 'import json, sys
status = json.load(sys.stdin)
print("capacity %s, leased %s, queued %s, braked %s, refused %s" % (
    status["capacity"], status["leased"], status["queued"],
    "yes" if status["braked"] else "no",
    sum(status["refused"].values())))')"
    else
      echo "SLOTS daemon socket present but not answering — systemctl status lexi-slotd"
    fi
  else
    echo "SLOTS no admission daemon on this host (ops/bootstrap-host.sh installs it); ceiling is the client count above"
  fi

  if [ "$SHOW_LOGS" -eq 1 ]; then
    for slug in "${clients[@]}"; do print_logs "$slug"; done
  fi

  # The exit status is the machine-readable half of this script: a timer, a
  # heartbeat ping or an `&&` can act on it. Reporting trouble and exiting 0
  # — what this did until now — makes every one of those silently useless.
  if [ "${#UNHEALTHY[@]}" -gt 0 ]; then
    echo
    echo "status: NOT healthy: ${UNHEALTHY[*]}"
    exit 1
  fi
}

main "$@"
