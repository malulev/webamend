#!/usr/bin/env bash
set -euo pipefail

# Prepares one VPS to host many client installations. Run once, as root, on a
# fresh Ubuntu 22.04/24.04 box; safe to run again afterwards.
#
# What it establishes, and why each piece is here rather than in
# provision-client.sh:
#
#   - Docker itself, plus the three packages rootless mode needs. Those are
#     installed HERE because they are host-wide apt state: installing them
#     twenty times, once per client, would be twenty identical no-ops with
#     twenty chances to fail halfway.
#   - /srv/webamend, the parent of every client's directory. Mode 0755 and
#     root-owned on purpose: each client subdirectory underneath is 0700 and
#     owned by that client, so the parent only needs to be traversable.
#   - A registry on 127.0.0.1:5000. Twenty clients must not each run
#     `npm ci && npm run build` on a shared 2 vCPU box, so release.sh builds
#     each image once on the root daemon and every client pulls it from here.
#     Bound to loopback: Docker treats 127.0.0.1 registries as insecure by
#     default, which is exactly why there is no TLS to configure and exactly
#     why it must never be reachable from off-box.
#
# It does NOT create clients, mint secrets, or start any application.

usage() {
  cat <<'USAGE'
Usage: ops/bootstrap-host.sh [--registry-port <port>]

Prepares a fresh VPS to host Webamend client installations. Run as root, once.
Idempotent: re-running repairs a partial run and changes nothing else.

Options:
  --registry-port <port>  Loopback port for the image registry (default 5000).
  --swap-size <size>      Swapfile size, in fallocate's units (default 2G).
  --no-swap               Do not create a swapfile.
  --no-monitoring         Do not install the metrics timers and log caps.
  --no-harden             Do not run ops/harden-host.sh (sshd, upgrades,
                          firewall, sysctl).
  -h, --help              Show this message.

After this, create a client with:
  ops/provision-client.sh <slug> <hostname> <port>
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

REGISTRY_PORT=5000
SWAP_SIZE=2G
WITH_SWAP=1
WITH_MONITORING=1
WITH_HARDEN=1
REGISTRY_NAME=webamend-registry
REGISTRY_VOLUME=webamend-registry-data
CLIENT_ROOT=/srv/webamend

# Compose v2.17 is the floor because docker-compose.yml builds the app image
# from `dockerfile_inline`, which does not exist before it. An older Compose
# does not warn — it fails to parse the service, which reads as a broken file.
COMPOSE_MIN_MAJOR=2
COMPOSE_MIN_MINOR=17

die() {
  echo "bootstrap-host: $*" >&2
  exit 1
}

note() {
  echo "bootstrap-host: $*"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --registry-port)
        [ $# -ge 2 ] || die "--registry-port needs a value"
        REGISTRY_PORT="$2"
        shift 2
        ;;
      --swap-size)
        [ $# -ge 2 ] || die "--swap-size needs a size, e.g. 2G"
        SWAP_SIZE="$2"
        shift 2
        ;;
      --no-swap)
        WITH_SWAP=0
        shift
        ;;
      --no-monitoring)
        WITH_MONITORING=0
        shift
        ;;
      --no-harden)
        WITH_HARDEN=0
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown argument: $1"
        ;;
    esac
  done

  case "$REGISTRY_PORT" in
    '' | *[!0-9]*) die "--registry-port must be a whole number, got: ${REGISTRY_PORT}" ;;
  esac
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root (creating users and installing packages). Try: sudo $0"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    note "docker already installed, skipping the convenience script"
  else
    note "installing docker via get.docker.com"
    command -v curl >/dev/null 2>&1 || die "curl is missing and is needed to fetch the Docker installer. Install it: apt-get install -y curl"
    curl -fsSL https://get.docker.com | sh
  fi

  systemctl enable --now docker >/dev/null 2>&1 ||
    die "the root Docker daemon did not start. Check: systemctl status docker"
}

# uidmap supplies newuidmap/newgidmap, without which a rootless daemon cannot
# map container UID 0 to the client user's subordinate range and fails with a
# message about /etc/subuid that does not say "install uidmap".
# dbus-user-session is what makes `systemctl --user` work for a user with no
# login session, which is precisely the case for a lingering service account.
# docker-ce-rootless-extras carries dockerd-rootless-setuptool.sh itself.
install_rootless_prerequisites() {
  local missing=()
  local pkg
  for pkg in uidmap dbus-user-session docker-ce-rootless-extras; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done

  if [ ${#missing[@]} -eq 0 ]; then
    note "rootless prerequisites already present"
    return
  fi

  note "installing rootless prerequisites: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" ||
    die "could not install: ${missing[*]}. On a non-Debian host install the equivalents by hand, then re-run."
}

# Compared numerically rather than with a string test, because "2.9" sorts
# after "2.17" webamendcally and would pass a check that should fail.
verify_compose_version() {
  local raw major minor
  raw="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$raw" ] ||
    die "'docker compose version' produced nothing. The Compose v2 plugin is missing; install docker-compose-plugin."

  # Some builds print "v2.17.0" and some "2.29.7"; the leading v would make
  # every arithmetic comparison below a syntax error rather than a version test.
  raw="${raw#v}"

  major="${raw%%.*}"
  minor="${raw#*.}"
  minor="${minor%%.*}"
  # A version with no dot at all leaves major and minor identical; treat the
  # minor as 0 rather than comparing the major against itself.
  [ "$minor" = "$raw" ] && minor=0

  case "${major}${minor}" in
    '' | *[!0-9]*) die "could not read a version number from 'docker compose version --short': ${raw}" ;;
  esac

  if [ "$major" -lt "$COMPOSE_MIN_MAJOR" ] ||
    { [ "$major" -eq "$COMPOSE_MIN_MAJOR" ] && [ "$minor" -lt "$COMPOSE_MIN_MINOR" ]; }; then
    die "Docker Compose ${raw} is too old. docker-compose.yml uses dockerfile_inline, which needs v${COMPOSE_MIN_MAJOR}.${COMPOSE_MIN_MINOR} or newer. Upgrade docker-compose-plugin and re-run."
  fi

  note "docker compose ${raw} (need >= ${COMPOSE_MIN_MAJOR}.${COMPOSE_MIN_MINOR})"
}

create_client_root() {
  mkdir -p "$CLIENT_ROOT"
  # Traversable, not readable-into: every client directory beneath is 0700 and
  # owned by its own user, and that is where the isolation actually lives.
  chown root:root "$CLIENT_ROOT"
  chmod 0755 "$CLIENT_ROOT"
  note "${CLIENT_ROOT} ready"
}

start_registry() {
  if docker volume inspect "$REGISTRY_VOLUME" >/dev/null 2>&1; then
    note "registry volume ${REGISTRY_VOLUME} exists"
  else
    docker volume create "$REGISTRY_VOLUME" >/dev/null
    note "created registry volume ${REGISTRY_VOLUME}"
  fi

  # Re-created rather than reconfigured when it already exists: a container's
  # port binding and restart policy cannot be changed in place, so a second run
  # after --registry-port changed would otherwise silently keep the old port.
  # The volume outlives this, so nothing pushed is lost.
  if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
    note "replacing existing ${REGISTRY_NAME} container (the volume is kept)"
    docker rm -f "$REGISTRY_NAME" >/dev/null
  fi

  docker run -d \
    --name "$REGISTRY_NAME" \
    --restart always \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    -v "${REGISTRY_VOLUME}:/var/lib/registry" \
    registry:2 >/dev/null ||
    die "could not start the registry container. Check: docker logs ${REGISTRY_NAME}"

  note "registry listening on 127.0.0.1:${REGISTRY_PORT} (insecure by default, which is why it must stay on loopback)"
}

verify_registry() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null "http://127.0.0.1:${REGISTRY_PORT}/v2/" 2>/dev/null; then
      note "registry answered /v2/ after ${attempt} attempt(s)"
      return 0
    fi
    sleep 1
  done
  die "the registry did not answer http://127.0.0.1:${REGISTRY_PORT}/v2/ within 10s. Check: docker logs ${REGISTRY_NAME}"
}

# A host with no swap resolves memory pressure by killing something, and the
# kernel picks by size. Every client can run one agent at a time (~400 MB
# each, measured) and nothing in the product admits across clients, so the
# ceiling is the client count and nothing stops that exceeding RAM. Swap turns
# an overshoot into slowness instead of a kill. Whether that trade is right is
# arguable — a 2026-09-14 stress test recovered in a minute *because* there was
# no swap to thrash through — so this is opt-out (--no-swap) rather than law.
# Host-wide admission is the lease daemon designed in
# docs/superpowers/specs/2026-09-14-host-admission-queue-design.md.
ensure_swap() {
  if [ "$WITH_SWAP" -eq 0 ]; then
    note "skipping swap (--no-swap)"
    return 0
  fi
  if [ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]; then
    note "swap already active; leaving it alone"
    return 0
  fi
  if [ -e /swapfile ]; then
    note "/swapfile exists but is not active; leaving it alone rather than guessing"
    return 0
  fi

  note "creating a ${SWAP_SIZE} swapfile"
  fallocate -l "$SWAP_SIZE" /swapfile || die "could not allocate /swapfile (disk full?)"
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null || die "mkswap failed"
  swapon /swapfile || die "swapon failed"
  # Survives a reboot, and only added once.
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  note "swap active: $(swapon --show --noheadings | awk '{print $3}')"
}

# The metrics timers, journald caps and Docker log rotation. Deliberately
# without Alloy: that needs Grafana Cloud credentials a fresh host does not
# have, and install-monitoring.sh takes --with-alloy for later.
install_monitoring() {
  if [ "$WITH_MONITORING" -eq 0 ]; then
    note "skipping monitoring (--no-monitoring)"
    return 0
  fi
  [ -x "${SCRIPT_DIR}/install-monitoring.sh" ] || {
    note "install-monitoring.sh not found; skipping. Run it by hand later."
    return 0
  }
  "${SCRIPT_DIR}/install-monitoring.sh"
}

# The host admission queue: one daemon, socket-activated, unprivileged. The
# `webamend-slots` group is both its authorization list and its client count;
# provision-client.sh enrols each client. Python 3 is present on every
# supported host image; the daemon is standard library only.
install_slotd() {
  command -v python3 >/dev/null || die "python3 is required for webamend-slotd; apt-get install -y python3"
  getent group webamend-slots >/dev/null || groupadd --system webamend-slots
  install -d -m 755 /run/webamend /etc/webamend
  [ -f /etc/webamend/slots.env ] || install -m 644 "${SCRIPT_DIR}/slotd/slots.env.example" /etc/webamend/slots.env
  local unit
  for unit in webamend-slotd.socket webamend-slotd.service; do
    sed "s#/opt/webamend/src#${SCRIPT_DIR%/ops}#g" "${SCRIPT_DIR}/slotd/systemd/${unit}" \
      >"/etc/systemd/system/${unit}"
  done
  systemctl daemon-reload
  systemctl enable --now webamend-slotd.socket
  note "webamend-slotd listening on /run/webamend/slotd.sock; capacity: python3 ${SCRIPT_DIR}/slotd/webamend_slotd.py status"
}

# Last, and not fatal: by now the host can serve clients, and the one thing
# harden-host.sh refuses over — no SSH key on any account — is fixed by a
# person, not by failing the whole bootstrap after the fact.
harden_host() {
  if [ "$WITH_HARDEN" -eq 0 ]; then
    note "skipping host hardening (--no-harden)"
    return 0
  fi
  [ -x "${SCRIPT_DIR}/harden-host.sh" ] || {
    note "harden-host.sh not found; skipping. Run it by hand later."
    return 0
  }
  "${SCRIPT_DIR}/harden-host.sh" ||
    note "host hardening did NOT complete; read the message above, then run ops/harden-host.sh yourself"
}

main() {
  parse_args "$@"
  require_root
  install_docker
  install_rootless_prerequisites
  verify_compose_version
  create_client_root
  start_registry
  verify_registry
  ensure_swap
  install_monitoring
  install_slotd
  harden_host

  cat <<EOF

bootstrap-host: done. This host is ready for clients.

Next:
  ops/provision-client.sh <slug> <hostname> <port>

Monitoring is installed but inert until it has somewhere to report:
  \$EDITOR /etc/webamend/monitoring.env    # HEARTBEAT_URL at minimum
See ops/MONITORING.md.

Note the registry port if you changed it (${REGISTRY_PORT}); release.sh and
provision-client.sh both default to 5000 and take --registry-port to match.
EOF
}

main "$@"
