#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Renames a host that was installed as Lexi.
#
# The product's name was load-bearing in seven places on disk — the source
# checkout, the client root, the runtime socket directory, the daemon's unit
# and group, the log wrapper and its sudoers grant, and the image repository —
# and the repository now spells all of them `webamend`. A host that keeps the
# old names and a release built from the new repository disagree about where
# every client lives, so this script is the one-time bridge between them.
#
# Run it once, as root, on a host provisioned before the rename, from the
# renamed checkout. It is idempotent: each step checks whether it has already
# happened, so a re-run after a failure resumes rather than doubles.
#
#   git -C /opt/prosel/src pull          # or wherever the checkout still is
#   /opt/prosel/src/ops/migrate-to-webamend.sh
#
# What it deliberately does NOT do: rebuild images. Old tags stay in the
# registry under lexi/app, and the first `ops/release.sh` after this writes
# webamend/app and recreates every client on it. Until that release runs, the
# clients are down — which is why the script offers to run it for you.

OLD_SRC=/opt/prosel
NEW_SRC=/opt/webamend
OLD_CLIENTS=/srv/lexi
NEW_CLIENTS=/srv/webamend
RUN_RELEASE=0

die() {
  echo "migrate: $*" >&2
  exit 1
}
note() { echo "migrate: $*"; }

usage() {
  cat <<'USAGE'
Usage: ops/migrate-to-webamend.sh [--release]

Renames a Lexi-era host to webamend: directories, the slot daemon's unit and
group, the monitoring timers, the log wrapper and its sudoers grant, and every
client's .env. Run as root, once.

Options:
  --release   Run ops/release.sh at the end, rebuilding every client on the
              new image name. Without it the clients stay down until you do.
  -h, --help  Show this message.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      RUN_RELEASE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (it moves /srv, /opt and /etc, and edits sudoers). Try: sudo $0"

# --- 1. stop everything that holds the old paths open -----------------------
#
# The client containers first: each one bind-mounts its own state directory by
# absolute path, and moving a directory out from under a running mount leaves
# the container writing into a path that no longer exists.

stop_clients() {
  local root="$1" dir slug uid
  [ -d "$root" ] || return 0
  for dir in "$root"/*/; do
    [ -d "$dir" ] || continue
    slug="$(basename "$dir")"
    id -u "$slug" >/dev/null 2>&1 || continue
    uid="$(id -u "$slug")"
    note "stopping ${slug}"
    runuser -u "$slug" -- env -C / \
      XDG_RUNTIME_DIR="/run/user/${uid}" \
      DOCKER_HOST="unix:///run/user/${uid}/docker.sock" \
      docker compose -f "${dir}docker-compose.yml" --project-directory "$dir" down \
      >/dev/null 2>&1 || note "  (${slug} had nothing running)"
  done
}

stop_units() {
  local unit
  for unit in lexi-slotd.socket lexi-slotd.service lexi-probe.timer lexi-probe-full.timer; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${unit}"
  done
  systemctl daemon-reload
}

# --- 2. move the directories ------------------------------------------------
#
# `mv` and not a copy: the client trees are 0700 with their own ownership, and
# a rename within one filesystem preserves every bit of that for free.

move_dir() {
  local from="$1" to="$2"
  [ -e "$from" ] || return 0
  if [ -e "$to" ]; then
    note "${to} already exists; leaving ${from} in place — merge it by hand"
    return 0
  fi
  mv "$from" "$to"
  note "moved ${from} -> ${to}"
}

# --- 3. the group keeps its GID, so membership survives ---------------------
#
# groupmod -n renames in place. Recreating the group instead would hand out a
# new GID, and every client's slot request would arrive as an unknown uid.

rename_group() {
  if getent group webamend-slots >/dev/null; then
    note "group webamend-slots already exists"
    return 0
  fi
  getent group lexi-slots >/dev/null || {
    note "no lexi-slots group on this host; skipping"
    return 0
  }
  groupmod -n webamend-slots lexi-slots
  note "renamed group lexi-slots -> webamend-slots (GID unchanged, membership intact)"
}

# --- 4. rewrite the paths inside each client's .env -------------------------
#
# Owner and mode are restored explicitly: the file is 0600 and client-owned,
# and an in-place edit by root would otherwise hand a client's secrets to root
# and leave the client unable to read them.

rewrite_client_envs() {
  local dir slug env_file
  for dir in "$NEW_CLIENTS"/*/; do
    [ -f "${dir}.env" ] || continue
    slug="$(basename "$dir")"
    env_file="${dir}.env"
    sed -i \
      -e "s#${OLD_CLIENTS}#${NEW_CLIENTS}#g" \
      -e 's#/run/lexi#/run/webamend#g' \
      -e 's#/var/lib/lexi#/var/lib/webamend#g' \
      -e 's#/lexi/app:#/webamend/app:#g' \
      "$env_file"
    chown "${slug}:${slug}" "$env_file"
    chmod 0600 "$env_file"
    note "rewrote ${slug}'s .env"
  done
}

# --- 5. reinstall what names itself ----------------------------------------

install_slotd() {
  install -d -m 755 /run/webamend /etc/webamend
  move_dir /etc/lexi/slots.env /etc/webamend/slots.env
  rmdir /etc/lexi 2>/dev/null || true
  local unit
  for unit in webamend-slotd.socket webamend-slotd.service; do
    # The unit ships the canonical path; a checkout anywhere else substitutes
    # its own, exactly as bootstrap-host.sh does.
    sed "s#/opt/webamend/src#${SCRIPT_DIR%/ops}#g" "${SCRIPT_DIR}/slotd/systemd/${unit}" \
      >"/etc/systemd/system/${unit}"
  done
  systemctl daemon-reload
  systemctl enable --now webamend-slotd.socket
  note "webamend-slotd listening on /run/webamend/slotd.sock"
}

install_log_wrapper() {
  local old_grant new_grant
  install -o root -g root -m 0755 "${SCRIPT_DIR}/client-logs.sh" /usr/local/bin/webamend-logs
  # Any drop-in naming the old wrapper, whatever the file itself is called:
  # the grant was written by hand and its name is not ours to assume.
  for old_grant in $(grep -rls '/usr/local/bin/lexi-logs' /etc/sudoers.d 2>/dev/null); do
    [ -f "$old_grant" ] || continue
    new_grant="$(dirname "$old_grant")/$(basename "$old_grant" | sed 's/lexi/webamend/')"
    [ "$new_grant" = "$old_grant" ] && new_grant="${old_grant}-webamend"
    sed 's#/usr/local/bin/lexi-logs#/usr/local/bin/webamend-logs#g' "$old_grant" >"$new_grant"
    chmod 0440 "$new_grant"
    rm -f "$old_grant"
    note "rewrote $(basename "$old_grant") -> $(basename "$new_grant")"
  done
  # A broken sudoers file locks the operator out of the one command they have,
  # so this is checked before the old wrapper is removed, not after.
  visudo -c >/dev/null || die "sudoers is invalid after rewriting the grant — fix it before removing the old wrapper"
  rm -f /usr/local/bin/lexi-logs
}

install_monitoring() {
  [ -x "${SCRIPT_DIR}/install-monitoring.sh" ] || {
    note "install-monitoring.sh not found; skipping the probe timers"
    return 0
  }
  "${SCRIPT_DIR}/install-monitoring.sh"
}

# --- 6. what a rename leaves behind ----------------------------------------
#
# Residue is not cosmetic. A stale `lexi.prom` keeps node_exporter publishing
# frozen `lexi_*` series next to the live ones, so a dashboard shows both and
# neither is obviously wrong. A stale socket file answers "connection refused"
# rather than "no such file", which reads like a daemon that is down. And
# monitoring.env holds the collector's credentials: left in /etc/lexi, the
# installer writes a fresh one from the example and Alloy ships nothing.
#
# Cleaning it needs no downtime, so it runs on every invocation — including on
# a host that is otherwise fully migrated.

clear_residue() {
  adopt_monitoring_env
  rmdir /etc/lexi 2>/dev/null || true

  rm -f /run/lexi/slotd.sock
  rmdir /run/lexi 2>/dev/null || true

  rm -f /var/lib/node_exporter/textfile/lexi.prom
}

# The collector's credentials, which only exist on a host someone configured.
#
# Ordering made this awkward once already: install-monitoring.sh writes a fresh
# env file from its example when it finds none, so a migration that installs
# monitoring before moving the old file ends up with a placeholder in place and
# the real credentials stranded. A placeholder is recognisable — it is the
# example, byte for byte — so that case resolves itself. Two files that both
# say something are a merge, and a merge is not a script's decision to make.
adopt_monitoring_env() {
  local old=/etc/lexi/monitoring.env
  local new=/etc/webamend/monitoring.env
  local example="${SCRIPT_DIR}/monitoring/alloy/env.example"

  [ -f "$old" ] || return 0

  if [ ! -e "$new" ]; then
    mv "$old" "$new"
    chmod 0600 "$new"
    note "moved ${old} -> ${new}"
  elif [ -f "$example" ] && cmp -s "$new" "$example"; then
    mv "$old" "$new"
    chmod 0600 "$new"
    note "${new} was the untouched example; replaced it with this host's real one"
  else
    note "both ${old} and ${new} have content of their own — merge them by hand"
    return 0
  fi

  # The agent read the placeholder at start-up and will go on shipping nothing
  # until it rereads the file.
  systemctl restart alloy 2>/dev/null && note "restarted alloy" || true
}

residue() {
  local found=()
  [ -e /etc/lexi ] && found+=(/etc/lexi)
  [ -e /run/lexi ] && found+=(/run/lexi)
  [ -e /var/lib/node_exporter/textfile/lexi.prom ] && found+=(lexi.prom)
  printf '%s\n' "${found[@]:-}"
}

# The parts that cannot be fixed without stopping the clients: the source, the
# client root, the group every slot request is identified by, the wrapper and
# the units. None of them present means the rename itself is done, whatever
# residue is still lying around.
structural_artifacts() {
  local found=()
  [ -e "$OLD_SRC" ] && found+=("$OLD_SRC")
  [ -e "$OLD_CLIENTS" ] && found+=("$OLD_CLIENTS")
  [ -e /var/lib/lexi ] && found+=(/var/lib/lexi)
  [ -e /usr/local/bin/lexi-logs ] && found+=(/usr/local/bin/lexi-logs)
  getent group lexi-slots >/dev/null && found+=("group lexi-slots")
  [ -e /etc/systemd/system/lexi-slotd.socket ] && found+=(lexi-slotd.socket)
  [ -e /etc/systemd/system/lexi-probe.timer ] && found+=(lexi-probe.timer)
  printf '%s\n' "${found[@]:-}"
}

main() {
  [ -d "$NEW_SRC" ] || [ -d "$OLD_SRC" ] || die "neither ${OLD_SRC} nor ${NEW_SRC} exists — is this the right host?"

  local structural
  structural="$(structural_artifacts | grep -c . || true)"

  if [ "$structural" -eq 0 ]; then
    if [ "$(residue | grep -c . || true)" -eq 0 ]; then
      note "nothing named lexi on this host; already migrated. Doing nothing."
      exit 0
    fi
    note "already migrated; clearing what the rename left behind:"
    residue | sed 's/^/migrate:   /'
    clear_residue
    note "done. No client was stopped."
    exit 0
  fi

  note "found ${structural} thing(s) still named lexi:"
  structural_artifacts | sed 's/^/migrate:   /'
  residue | sed 's/^/migrate:   /'

  note "stopping clients and the old units"
  stop_clients "$OLD_CLIENTS"
  stop_clients "$NEW_CLIENTS"
  stop_units

  move_dir "$OLD_CLIENTS" "$NEW_CLIENTS"
  move_dir /var/lib/lexi /var/lib/webamend
  rename_group
  rewrite_client_envs

  # Before anything is installed *from* the checkout, not after: the unit file
  # this writes names the source path, and a unit pointing at a directory that
  # is about to move starts a daemon that cannot find its own program. Bash
  # holds this script by inode, so moving it out from under itself is safe;
  # every later read through SCRIPT_DIR is not, hence the reassignment.
  move_dir "$OLD_SRC" "$NEW_SRC"
  case "$SCRIPT_DIR" in
    "$OLD_SRC"/*) SCRIPT_DIR="${NEW_SRC}${SCRIPT_DIR#"$OLD_SRC"}" ;;
  esac
  [ -d "$SCRIPT_DIR" ] || die "the checkout is not where this script expected it (${SCRIPT_DIR}); nothing else was installed"

  install_slotd
  install_log_wrapper
  # Before the monitoring installer, which writes a fresh env file from the
  # example only when there is none — so the credentials have to arrive first.
  clear_residue
  install_monitoring

  note "host renamed."
  if [ "$RUN_RELEASE" -eq 1 ]; then
    note "releasing onto the new image name"
    "${NEW_SRC}/src/ops/release.sh"
  else
    cat <<NEXT

migrate: the clients are down until a release rebuilds them under the new
migrate: image name. Run:

    ${NEW_SRC}/src/ops/release.sh
    ${NEW_SRC}/src/ops/status.sh

NEXT
  fi
}

main "$@"
