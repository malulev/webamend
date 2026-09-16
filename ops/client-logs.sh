#!/bin/bash
# Read-only view of one client's app container, for an unprivileged operator
# account (the `claude` user) that must not become root or the client user.
#
# Install (as root), one line per client that should be readable:
#   install -o root -g root -m 0755 ops/client-logs.sh /usr/local/bin/webamend-logs
#   echo 'claude ALL=(malulev) NOPASSWD: /usr/local/bin/webamend-logs' > /etc/sudoers.d/webamend-logs-claude
#   chmod 0440 /etc/sudoers.d/webamend-logs-claude && visudo -c
#
# Use (as claude):
#   sudo -u malulev webamend-logs logs --since 30m
#   sudo -u malulev webamend-logs ps
#   sudo -u malulev webamend-logs inspect
#
# The grant runs this script as the CLIENT user against the client's own
# rootless daemon, never as root. The script exposes exactly three read-only
# operations on the app container and refuses every other argument, so the
# sudoers line cannot widen into `docker exec`, `docker run`, a bind mount, or
# another client's daemon. The client whose logs are read is whichever user
# sudo switched to; the app container's structured log carries no secret
# values (src/lib/log/redact.ts), and agent containers are not reachable here.
set -euo pipefail

slug="$(id -un)"
container="${slug}-app-1"
uid="$(id -u)"

if [ "$slug" = "root" ] || [ ! -d "/srv/webamend/${slug}" ]; then
  echo "webamend-logs: must run as a client user (sudo -u <slug> webamend-logs ...)" >&2
  exit 1
fi

export XDG_RUNTIME_DIR="/run/user/${uid}"
export DOCKER_HOST="unix:///run/user/${uid}/docker.sock"
cd /   # sudo keeps the caller's cwd, which the client user may not be able to stat

usage() {
  cat >&2 <<USAGE
usage: webamend-logs logs [--since <t>] [--until <t>] [--tail <n>] [-t|--timestamps]
       webamend-logs ps
       webamend-logs inspect
USAGE
  exit 2
}

reject_dash() {
  case "$1" in
    -*) echo "webamend-logs: refused value: $1" >&2; exit 2 ;;
  esac
}

cmd="${1:-}"
[ -n "$cmd" ] && shift

case "$cmd" in
  logs)
    args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --since|--until|--tail)
          [ $# -ge 2 ] || usage
          reject_dash "$2"
          args+=("$1" "$2"); shift 2 ;;
        --since=*|--until=*|--tail=*)
          reject_dash "${1#*=}"
          args+=("$1"); shift ;;
        -t|--timestamps)
          args+=("$1"); shift ;;
        *)
          echo "webamend-logs: refused argument: $1" >&2; exit 2 ;;
      esac
    done
    exec docker logs "${args[@]}" "$container"
    ;;
  ps)
    [ $# -eq 0 ] || usage
    exec docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Labels}}'
    ;;
  inspect)
    [ $# -eq 0 ] || usage
    exec docker inspect \
      -f 'running={{.State.Running}} restarts={{.RestartCount}} started={{.State.StartedAt}} image={{.Config.Image}}' \
      "$container"
    ;;
  *)
    usage ;;
esac
