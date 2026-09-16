#!/usr/bin/env bash
set -euo pipefail

# Writes the Webamend-specific metrics a generic exporter cannot know, for
# node_exporter's textfile collector, and pings the dead-man's switch.
#
# Everything it reports comes from `ops/status.sh --prom`, so there is exactly
# one implementation of "become each client and ask its daemon" and it stays
# in status.sh. This script's own jobs are the two things status.sh should not
# do: write the file atomically, and decide whether the host is well enough to
# tell an outside service it is alive.
#
# Run from a systemd timer. See ops/MONITORING.md.

TEXTFILE_DIR=/var/lib/node_exporter/textfile
HEARTBEAT_URL="${HEARTBEAT_URL:-}"
FULL=0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
Usage: ops/probe.sh [--full] [--textfile-dir <dir>]

Writes <dir>/webamend.prom from ops/status.sh --prom, then pings HEARTBEAT_URL if
every client is healthy. Run as root, from a systemd timer.

  --full                 Include per-client disk usage (a du over each git
                         mirror; run this on a slower timer than the rest).
  --textfile-dir <dir>   Default: /var/lib/node_exporter/textfile

Environment:
  HEARTBEAT_URL  Dead-man's-switch ping URL. Only the run without --full pings,
                 so stopping the 60s timer is enough to make the check go red. Kept in /etc/webamend/monitoring.env,
                 0600 root — never in a client .env, because a client user can
                 read their own and this token is host-wide.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --textfile-dir) TEXTFILE_DIR="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; echo "probe: unknown option: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "probe: must run as root (it reads every client's 0700 tree)" >&2; exit 1; }

mkdir -p "$TEXTFILE_DIR"

# Atomically, and this is not fussiness: node_exporter reads whatever is in
# the file when its scrape lands, so writing in place produces half-parsed
# scrapes and gaps that look like an outage.
tmp="$(mktemp "${TEXTFILE_DIR}/webamend.prom.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

started="$(date +%s.%N)"
prom_args=(--prom)
[ "$FULL" -eq 1 ] && prom_args+=(--full)

# `--prom` exits 0 even when a client is unhealthy: an unhealthy client is a
# metric to publish, not a reason to publish nothing.
if ! "${SCRIPT_DIR}/status.sh" "${prom_args[@]}" >"$tmp" 2>/dev/null; then
  echo "probe: status.sh failed; leaving the previous metrics in place" >&2
  exit 1
fi

{
  echo '# HELP webamend_probe_duration_seconds How long this collection took.'
  echo '# TYPE webamend_probe_duration_seconds gauge'
  echo "webamend_probe_duration_seconds $(echo "$(date +%s.%N) - ${started}" | bc)"
  echo '# HELP webamend_probe_last_success_timestamp_seconds When this last completed.'
  echo '# TYPE webamend_probe_last_success_timestamp_seconds gauge'
  echo "webamend_probe_last_success_timestamp_seconds $(date +%s)"
} >>"$tmp"

# The admission daemon's own view. Absent socket: no lines, no failure — a
# host without the daemon is not a broken host. A socket that does not answer
# is a fault worth the line below, but still not a reason to publish nothing.
if [ -S /run/webamend/slotd.sock ]; then
  {
    echo '# HELP webamend_slots_up 1 when the admission daemon answered.'
    echo '# TYPE webamend_slots_up gauge'
  } >>"$tmp"
  if python3 "${SCRIPT_DIR}/slotd/webamend_slotd.py" status --socket /run/webamend/slotd.sock --prom >>"$tmp" 2>/dev/null; then
    echo 'webamend_slots_up 1' >>"$tmp"
  else
    echo "probe: webamend-slotd did not answer on /run/webamend/slotd.sock" >&2
    echo 'webamend_slots_up 0' >>"$tmp"
  fi
fi

chmod 644 "$tmp"
mv -- "$tmp" "${TEXTFILE_DIR}/webamend.prom"
trap - EXIT

# The heartbeat is conditional twice over, and both conditions matter.
#
# It depends on every client being healthy: a timer that pings unconditionally
# proves only that the timer runs, not that the thing it watches is well.
#
# And only the 60-second run pings, never `--full`. Both timers call this
# script, so if the slow one pinged too it would keep the check green while the
# fast collection was dead — which is precisely the failure a dead-man's switch
# exists to catch, masked by the switch itself.
if [ "$FULL" -eq 1 ]; then
  : # the attribution run; the fast timer owns the heartbeat
elif [ -n "$HEARTBEAT_URL" ]; then
  if "${SCRIPT_DIR}/status.sh" --quiet; then
    curl -fsS -m 10 --retry 3 "$HEARTBEAT_URL" >/dev/null || echo "probe: heartbeat ping failed" >&2
  else
    echo "probe: not pinging — a client is unhealthy" >&2
  fi
fi
