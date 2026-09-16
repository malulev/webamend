#!/usr/bin/env bash
set -euo pipefail

# Installs the monitoring side of a Webamend host: the textfile collector timers,
# the dead-man's-switch heartbeat, and optionally Grafana Alloy.
#
# Idempotent, and it refuses rather than guesses. Run as root on a host already
# prepared by bootstrap-host.sh.
#
# It deliberately does NOT create any account. Grafana Cloud and the heartbeat
# service are things a person signs up for; this script wires up what they hand
# back. See ops/MONITORING.md for the order.

CONFIG_DIR=/etc/webamend
ENV_FILE="${CONFIG_DIR}/monitoring.env"
TEXTFILE_DIR=/var/lib/node_exporter/textfile
ALLOY_CONFIG_DIR=/etc/alloy
WITH_ALLOY=0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"

usage() {
  cat <<'USAGE'
Usage: ops/install-monitoring.sh [--with-alloy]

Installs:
  - /etc/webamend/monitoring.env       (0600 root, from ops/monitoring/alloy/env.example)
  - the webamend-probe timers          (metrics every 60s, disk usage every 15min)
  - journald retention caps
  - Docker json-file log rotation for the host daemon

With --with-alloy it also installs Grafana Alloy and its config. Leave that off
until ops/MONITORING.md's phase 1 is running: the heartbeat alone takes this
host from no coverage to "someone learns within 20 minutes", for no memory.

Nothing here creates an account or a token.
USAGE
}

die() { echo "install-monitoring: $*" >&2; exit 1; }
note() { echo "install-monitoring: $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --with-alloy) WITH_ALLOY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root. Try: sudo $0"
[ -x "${SCRIPT_DIR}/probe.sh" ] || die "${SCRIPT_DIR}/probe.sh is missing or not executable"

# --- the secret file -------------------------------------------------------
install -d -m 700 "$CONFIG_DIR"
if [ -f "$ENV_FILE" ]; then
  note "${ENV_FILE} exists; left as is"
else
  install -m 600 "${SCRIPT_DIR}/monitoring/alloy/env.example" "$ENV_FILE"
  note "wrote ${ENV_FILE} — fill it in before enabling anything that needs it"
fi
# Names only, never values: the same rule check-env.ts follows.
note "variables it expects: $(grep -oE '^[A-Z_]+=' "$ENV_FILE" | tr -d '=' | tr '\n' ' ')"
note "no value from that file is printed by this script"

# --- textfile collector directory ------------------------------------------
install -d -m 755 "$TEXTFILE_DIR"

# --- timers ----------------------------------------------------------------
# The units ship with a placeholder path because a host may keep the checkout
# anywhere — this one has it at /opt/webamend/src, a name older than the product.
for unit in webamend-probe.service webamend-probe.timer webamend-probe-full.service webamend-probe-full.timer; do
  sed "s#/opt/webamend/src#${REPO_ROOT}#g" "${SCRIPT_DIR}/monitoring/systemd/${unit}" \
    >"/etc/systemd/system/${unit}"
done
systemctl daemon-reload
systemctl enable --now webamend-probe.timer webamend-probe-full.timer
note "timers enabled; first collection within two minutes"

# --- bound what grows without limit ----------------------------------------
install -d -m 755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/webamend.conf <<'JOURNAL'
# The default ceiling is 10% of the filesystem, which on this box is several
# gigabytes shared with /srv/webamend and every client's image store.
[Journal]
SystemMaxUse=500M
RuntimeMaxUse=100M
MaxRetentionSec=2week
JOURNAL
systemctl restart systemd-journald
note "journald capped at 500M"

if [ -f /etc/docker/daemon.json ]; then
  note "/etc/docker/daemon.json exists; not touching it. Ensure it sets log-opts max-size and max-file."
else
  install -d -m 755 /etc/docker
  cat >/etc/docker/daemon.json <<'DOCKERD'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
DOCKERD
  note "wrote /etc/docker/daemon.json (restart dockerd to apply: systemctl restart docker)"
  note "note: each CLIENT's rootless daemon has its own config; the compose file caps those per service."
fi

# --- alloy, only if asked --------------------------------------------------
if [ "$WITH_ALLOY" -eq 1 ]; then
  command -v alloy >/dev/null 2>&1 || die "alloy is not installed. See ops/MONITORING.md for the one-line install, then re-run."
  install -d -m 755 "$ALLOY_CONFIG_DIR"
  install -m 644 "${SCRIPT_DIR}/monitoring/alloy/config.alloy" "${ALLOY_CONFIG_DIR}/config.alloy"

  install -d -m 755 /etc/systemd/system/alloy.service.d
  cat >/etc/systemd/system/alloy.service.d/webamend.conf <<'OVERRIDE'
# Bounded rather than hoped for. The summed agent ceiling across clients can
# exceed free memory, so the monitoring must not be the thing that tips it:
# MemoryMax makes Alloy the process the kernel kills, instead of Caddy or a
# client's app.
#
# `User=root` is deliberate and is the one real privilege decision here. Each
# client's home is 0750 <slug>:<slug>, and its rootless Docker data-root sits
# inside it, so the packaged `alloy` user cannot traverse to the container
# logs. It would not fail loudly — `loki.source.file` would simply match no
# files, metrics would keep flowing, and the application logs that every
# request metric is derived from would silently never arrive. A collector that
# reads several users' logs needs privilege over all of them; the alternative
# is adding `alloy` to every client's group, which must then be repeated on
# every provision and is forgotten exactly once.
[Service]
User=root
Group=root
EnvironmentFile=-/etc/webamend/monitoring.env
Environment=GOMEMLIMIT=120MiB
MemoryHigh=150M
MemoryMax=200M
Nice=10
IOSchedulingClass=idle
OVERRIDE

  systemctl daemon-reload
  # Not `enable --now`: that leaves an Alloy that is already running on the
  # config and environment it started with, and both were just rewritten. A
  # restart loses nothing — file positions are persisted, and the metrics
  # queue has a write-ahead log.
  systemctl enable alloy
  systemctl restart alloy
  note "alloy installed and restarted on this config"
  note "check it: systemctl status alloy; journalctl -u alloy -n 30"
  note "then CONFIRM LOGS ARRIVE: in Grafana, {job=\"webamend\"} must return lines."
  note "  metrics flowing while logs stay empty means Alloy cannot read the"
  note "  client container logs — check it is running as root."

fi

echo
note "done. Next: fill in ${ENV_FILE}, then read ops/MONITORING.md."
