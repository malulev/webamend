#!/usr/bin/env bash
set -euo pipefail

# Creates one client installation on a host already prepared by
# bootstrap-host.sh. Run as root. Idempotent.
#
# The shape it builds, and why:
#
#   One Linux user per client, each running its own rootless dockerd. That is
#   the isolation boundary and the reason this script exists at all. The
#   application mounts a Docker socket, and a socket is the authority of
#   whoever owns the daemon behind it. Point every client at the root daemon
#   and one client's remote code execution is root on the box and every other
#   client's secrets. Point client A at a daemon owned by user A and the same
#   compromise buys user A's authority: A's own .env, A's own state, and
#   nothing of B's — B's directory is 0700 and owned by B.
#
#   /srv/webamend/<slug>/            0700 <slug>:<slug>
#     .env                         0600 <slug>:<slug>   secrets, filled by hand
#     docker-compose.yml           0600 <slug>:<slug>   copied from the repo
#     state/                       0700 <slug>:<slug>   WEBAGENT_STATE_DIR
#
#   state/ must stay 0700. The application makes each per-request working tree
#   inside it world-writable, because the agent container runs as a mapped
#   subordinate UID that is nobody the host has heard of. Those trees hold a
#   full checkout of the client's repository. The 0700 on the parent is what
#   stops another client's user from walking in and reading them; the agent
#   still reaches its own tree, because a bind mount resolves the path once, in
#   the daemon, as <slug> — the container process never traverses the parent.
#
# What this script deliberately does NOT do: invent a secret, or start
# anything. Secrets are minted by `gen:secrets` and pasted in by a person, and
# a stack started before its .env is filled in would only fail startup
# validation in a way that reads like a bug. It ends by printing the steps left.

usage() {
  cat <<'USAGE'
Usage: ops/provision-client.sh <slug> <hostname> <port> [--force] [--registry-port <port>]

Creates one client installation: a Linux user with its own rootless Docker
daemon, /srv/webamend/<slug>/ at mode 0700, and a .env skeleton. Run as root.

Arguments:
  <slug>      Client identifier. Becomes the Linux user name and the directory
              name: lowercase letters, digits and hyphens, starting with a
              letter, 2-31 characters.
  <hostname>  Public hostname the reverse proxy will serve, e.g.
              edit.client.example. Becomes PUBLIC_BASE_URL as https://<hostname>.
  <port>      Loopback port this installation publishes on, 1024-65535. Must be
              unique across clients on this host; the reverse proxy forwards to
              127.0.0.1:<port>.

Options:
  --force                 Proceed when the slug already exists, repairing what
                          is missing. Never overwrites an existing .env.
  --registry-port <port>  Host registry port (default 5000). Must match
                          bootstrap-host.sh.
  -h, --help              Show this message.

Example:
  ops/provision-client.sh acme edit.acme.example 3001
USAGE
}

CLIENT_ROOT=/srv/webamend
REGISTRY_PORT=5000
FORCE=0
SLUG=""
HOSTNAME_ARG=""
PORT=""

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"

die() {
  echo "provision-client: $*" >&2
  exit 1
}

note() {
  echo "provision-client: $*"
}

parse_args() {
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --force)
        FORCE=1
        shift
        ;;
      --registry-port)
        [ $# -ge 2 ] || die "--registry-port needs a value"
        REGISTRY_PORT="$2"
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

  if [ "${#positional[@]}" -ne 3 ]; then
    usage >&2
    die "expected exactly 3 arguments (slug, hostname, port), got ${#positional[@]}"
  fi

  SLUG="${positional[0]}"
  HOSTNAME_ARG="${positional[1]}"
  PORT="${positional[2]}"
}

validate_args() {
  # Constrained to what useradd accepts and what reads unambiguously in a
  # directory listing; an underscore or a leading digit is a valid user name on
  # some systems and not others, and this is not the place to find out which.
  [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]] ||
    die "slug '${SLUG}' is not usable as a Linux user name: lowercase letters, digits and hyphens, starting with a letter, 2-31 characters"

  [[ "$HOSTNAME_ARG" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] ||
    die "hostname '${HOSTNAME_ARG}' does not look like a DNS name. Pass the bare host, e.g. edit.client.example — no scheme, no path."

  case "$PORT" in
    '' | *[!0-9]*) die "port '${PORT}' is not a number" ;;
  esac
  [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] ||
    die "port ${PORT} is outside 1024-65535"

  case "$REGISTRY_PORT" in
    '' | *[!0-9]*) die "--registry-port must be a whole number, got: ${REGISTRY_PORT}" ;;
  esac
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root (creating a user and a 0700 tree). Try: sudo $0 ..."
}

require_host_bootstrapped() {
  command -v docker >/dev/null 2>&1 ||
    die "docker is not installed. Run ops/bootstrap-host.sh first."
  [ -d "$CLIENT_ROOT" ] ||
    die "${CLIENT_ROOT} does not exist. Run ops/bootstrap-host.sh first."
  command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1 ||
    die "dockerd-rootless-setuptool.sh is missing (package docker-ce-rootless-extras). Run ops/bootstrap-host.sh first."
  [ -f "${REPO_ROOT}/docker-compose.yml" ] ||
    die "no docker-compose.yml at ${REPO_ROOT}. Run this script from inside a checkout of the application repository."
}

# A second installation on the same port would start, bind nothing, and fail in
# a way that looks like the application rather than the port. Cheaper to catch
# here, by reading the one non-secret line out of each existing .env.
refuse_port_collision() {
  local env_file other
  for env_file in "$CLIENT_ROOT"/*/.env; do
    [ -f "$env_file" ] || continue
    other="$(basename -- "$(dirname -- "$env_file")")"
    [ "$other" = "$SLUG" ] && continue
    if grep -qE "^PORT_HOST=${PORT}\$" "$env_file"; then
      die "port ${PORT} is already PORT_HOST for client '${other}'. Pick another."
    fi
  done
}

refuse_existing_slug() {
  local exists=0
  id -u "$SLUG" >/dev/null 2>&1 && exists=1
  [ -d "${CLIENT_ROOT}/${SLUG}" ] && exists=1

  if [ "$exists" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
    die "client '${SLUG}' already exists (user and/or ${CLIENT_ROOT}/${SLUG}). Re-run with --force to repair it in place; an existing .env is never overwritten either way."
  fi

  [ "$exists" -eq 1 ] && note "client '${SLUG}' already exists; repairing in place (--force)"
  return 0
}

create_user() {
  if id -u "$SLUG" >/dev/null 2>&1; then
    note "user ${SLUG} exists"
  else
    # A home directory is not optional here: rootless Docker keeps its systemd
    # user unit, its daemon config and its image store under $HOME.
    useradd --create-home --shell /bin/bash "$SLUG" ||
      die "useradd failed for ${SLUG}"
    note "created user ${SLUG}"
  fi

  # Container UID 0 maps to a subordinate UID of this user; without a range
  # allocated here, rootless dockerd fails with a message about newuidmap that
  # does not mention /etc/subuid.
  grep -q "^${SLUG}:" /etc/subuid ||
    die "no subordinate UID range for ${SLUG} in /etc/subuid. Allocate one, e.g.: usermod --add-subuids 100000-165535 --add-subgids 100000-165535 ${SLUG}"
  grep -q "^${SLUG}:" /etc/subgid ||
    die "no subordinate GID range for ${SLUG} in /etc/subgid. Allocate one, e.g.: usermod --add-subuids 100000-165535 --add-subgids 100000-165535 ${SLUG}"
}

# Membership of webamend-slots is what lets this client's uid take a slot from the
# admission daemon, and what the daemon counts when it sizes capacity. The
# reload recomputes capacity for the new count; harmless if the daemon is not
# installed.
enroll_in_slots() {
  if ! getent group webamend-slots >/dev/null; then
    note "webamend-slots group absent (host bootstrapped before the admission queue); skipping enrolment"
    return 0
  fi
  usermod -aG webamend-slots "$SLUG" || die "could not add ${SLUG} to webamend-slots"
  systemctl reload webamend-slotd.service 2>/dev/null || true
  note "enrolled ${SLUG} in webamend-slots"
}

# Without linger, /run/user/<uid> and the user's systemd instance exist only
# while the user has a login session — so the client's daemon would stop the
# moment an operator logged out, and would never start at boot. These accounts
# never log in at all.
enable_linger() {
  loginctl enable-linger "$SLUG" ||
    die "loginctl enable-linger ${SLUG} failed; without it the client's rootless daemon will not survive a reboot"

  local uid waited=0
  uid="$(id -u "$SLUG")"
  while [ "$waited" -lt 10 ]; do
    [ -d "/run/user/${uid}" ] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  die "/run/user/${uid} did not appear within 10s of enabling linger. Check: systemctl status user@${uid}.service"
}

# Every command that must run with the client's own systemd and daemon in view.
# DOCKER_HOST is set here so `docker` reaches this client's rootless socket and
# never the root daemon; PATH is spelled out because runuser does not give a
# non-login shell one worth relying on.
run_as_client() {
  local uid
  uid="$(id -u "$SLUG")"
  # `-C /`: runuser does not change directory, so these commands inherit the
  # caller's cwd. Called from a root-only directory (/root, say), the client
  # user cannot stat `.`, and `docker compose` fails validation with
  # "stat .: permission denied" — which this script would otherwise report as
  # a *stopped* installation. A monitor that says down for a cwd it could not
  # read is worse than no monitor.
  runuser -u "$SLUG" -- env -C / \
    HOME="$(getent passwd "$SLUG" | cut -d: -f6)" \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    DOCKER_HOST="unix:///run/user/${uid}/docker.sock" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

install_rootless_daemon() {
  local home unit
  home="$(getent passwd "$SLUG" | cut -d: -f6)"
  unit="${home}/.config/systemd/user/docker.service"

  if [ -f "$unit" ]; then
    note "rootless daemon already installed for ${SLUG}"
  else
    # DOCKER_HOST is unset for this one call: the setup tool refuses to run
    # while it is set, because it is about to create the socket that variable
    # names and cannot verify a daemon that does not exist yet.
    run_as_client env -u DOCKER_HOST dockerd-rootless-setuptool.sh install ||
      die "dockerd-rootless-setuptool.sh failed for ${SLUG}. Read its output above: it names the missing prerequisite."
    note "installed rootless daemon for ${SLUG}"
  fi

  run_as_client systemctl --user enable docker ||
    die "systemctl --user enable docker failed for ${SLUG}"
  run_as_client systemctl --user start docker ||
    die "systemctl --user start docker failed for ${SLUG}. Check: systemctl --user -M ${SLUG}@ status docker"

  run_as_client docker info >/dev/null 2>&1 ||
    die "${SLUG}'s rootless daemon is not answering its socket. Check: systemctl --user -M ${SLUG}@ status docker"
}

create_tree() {
  local dir="${CLIENT_ROOT}/${SLUG}"
  mkdir -p "${dir}/state"
  chown -R "${SLUG}:${SLUG}" "$dir"
  chmod 0700 "$dir"
  # Restated rather than inherited: this one mode is the containment for every
  # per-request working tree the application deliberately makes world-writable.
  chmod 0700 "${dir}/state"
  note "${dir} and ${dir}/state at 0700 ${SLUG}:${SLUG}"
}

copy_compose() {
  local dir="${CLIENT_ROOT}/${SLUG}"
  install -o "$SLUG" -g "$SLUG" -m 0600 \
    "${REPO_ROOT}/docker-compose.yml" "${dir}/docker-compose.yml"
  note "copied docker-compose.yml"
}

# Written only when absent. It is the one file on the host that will hold this
# client's secrets, and a "repair" run that truncated it would be the worst
# possible outcome of a command whose whole purpose is to be safe to re-run.
write_env_skeleton() {
  local dir="${CLIENT_ROOT}/${SLUG}"
  local env_file="${dir}/.env"
  local uid
  uid="$(id -u "$SLUG")"

  if [ -f "$env_file" ]; then
    note ".env already exists; left untouched"
    # Still enforced, in case an earlier hand-edit relaxed it.
    chown "${SLUG}:${SLUG}" "$env_file"
    chmod 0600 "$env_file"
    return
  fi

  # Created empty at 0600 before a byte is written, so the placeholders and
  # anything pasted after them are never briefly world-readable.
  install -o "$SLUG" -g "$SLUG" -m 0600 /dev/null "$env_file"

  cat >"$env_file" <<EOF
# ${SLUG} — one installation, one website.
#
# This file is read twice: docker compose interpolates it into
# docker-compose.yml, and every name in it is also passed into the container.
# That is why PORT must never appear here (Next would take it as its listen
# port and the published mapping would stop matching) and why PORT_HOST exists.
#
# Mode 0600, owned by ${SLUG}. Keep it that way. Never commit it anywhere.

# --- Filled in for you: this installation's place on this host --------------

# Sign-in links are built from this, and the session and configuration cookies
# take their Secure flag from its scheme. An http:// value behind an HTTPS
# proxy issues cookies without it.
PUBLIC_BASE_URL=https://${HOSTNAME_ARG}

# Must be the same absolute path inside the container and on the host: the
# daemon resolves the agent's bind mount on the host, not in the container.
WEBAGENT_STATE_DIR=${CLIENT_ROOT}/${SLUG}/state

# This client's own rootless daemon. Its authority is user ${SLUG}, not root.
DOCKER_SOCK=/run/user/${uid}/docker.sock

# The host admission queue. Same path on the host and in the container
# (docker-compose.yml mounts /run/webamend). Remove the line to run without it.
SLOT_BROKER_SOCKET=/run/webamend/slotd.sock

# Loopback port the reverse proxy forwards to. Unique per client on this host.
PORT_HOST=${PORT}

# Set by ops/release.sh on every roll-forward. Leave them alone by hand.
APP_IMAGE=127.0.0.1:${REGISTRY_PORT}/webamend/app:bootstrap
AGENT_IMAGE=127.0.0.1:${REGISTRY_PORT}/webagent/agent:bootstrap

# --- Fill these in by hand --------------------------------------------------

# GitHub App installed on this client's repository only.
# Contents: read and write. Pull requests: read and write. Webhook unchecked.
# GITHUB_INSTALLATION_ID is the number in the URL after installing the App —
# it is not the App ID, and confusing the two is the commonest setup mistake.
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_INSTALLATION_ID=
GITHUB_REPO=owner/name

# Netlify. The token is ACCOUNT-WIDE — it reaches every site in the account it
# belongs to. If that matters, give this client its own Netlify team.
# Deploy Previews must be enabled for pull requests on the site, or the loop
# waits forever with no error.
NETLIFY_TOKEN=
NETLIFY_SITE_ID=

OPENROUTER_API_KEY=

SMTP_URL=
SMTP_FROM=

# Who may sign in. Deployment configuration, never repository configuration:
# write access to the client's repository must not confer access to the
# editing interface. Comma-separated.
ALLOWED_EMAILS=

# --- Minted by gen:secrets, never chosen by hand ----------------------------
# Append them; do not type them:
#   npm run gen:secrets >> ${env_file}
# SESSION_SECRET, NETLIFY_WEBHOOK_SECRET, TOTP_SECRET
EOF

  chown "${SLUG}:${SLUG}" "$env_file"
  chmod 0600 "$env_file"
  note "wrote .env skeleton (0600, ${SLUG}:${SLUG}); no secrets in it"
}

print_next_steps() {
  local dir="${CLIENT_ROOT}/${SLUG}"
  cat <<EOF

provision-client: '${SLUG}' is provisioned. Nothing is running yet, by design.

Remaining steps, in this order:

  1. Fill in the hand-written half of the environment:
       sudoedit ${dir}/.env
     (GitHub App, Netlify, OpenRouter, SMTP, ALLOWED_EMAILS.)

  2. Mint the three secrets and append them AS ${SLUG}, so the file stays 0600
     and no value is ever echoed to your terminal. The toolchain runs in a
     throwaway copy of the checkout, because node_modules in ${REPO_ROOT}
     would be baked into every client's image by the next release:
       docker run --rm -v ${REPO_ROOT}:/src:ro -w /build node:22-slim \\
         sh -c 'cp -a /src/. /build && npm ci --silent && npm run --silent gen:secrets' \\
         | sudo -u ${SLUG} tee -a ${dir}/.env >/dev/null

  3. Check it parses. It prints variable names and never values:
       docker run --rm -v ${REPO_ROOT}:/src:ro -v ${dir}/.env:/secret/.env:ro \\
         -w /build node:22-slim \\
         sh -c 'cp -a /src/. /build && cp /secret/.env /build/.env \\
                && npm ci --silent && npm run --silent check:env'

  4. Build and roll out:
       ops/release.sh --client ${SLUG}

  5. Point the reverse proxy at it, e.g. in /etc/caddy/Caddyfile:
       ${HOSTNAME_ARG} {
           log {
               output stderr
           }
           reverse_proxy 127.0.0.1:${PORT}
       }
     then: systemctl reload caddy

     The log block is not optional decoration. Caddy writes no access log at
     all without it, and stderr means journald, which Alloy already ships.
     It is the only source of this client's HTTP status codes, latency and
     5xx rate — the app cannot report a request that never reached it.

  6. Send the client their authenticator link (shows the QR once, valid 24 h):
       docker run --rm -v ${REPO_ROOT}:/src:ro -v ${dir}/.env:/secret/.env:ro -w /build node:22-slim \\
         sh -c 'cp -a /src/. /build && cp /secret/.env /build/.env && npm ci --silent && npm run --silent enroll:link'
EOF
}

main() {
  parse_args "$@"
  validate_args
  require_root
  require_host_bootstrapped
  refuse_existing_slug
  refuse_port_collision
  create_user
  enable_linger
  enroll_in_slots
  install_rootless_daemon
  create_tree
  copy_compose
  write_env_skeleton
  print_next_steps
}

main "$@"
