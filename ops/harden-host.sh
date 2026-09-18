#!/usr/bin/env bash
set -euo pipefail

# Hardens the host underneath the client installations. Run as root on Ubuntu
# 22.04/24.04; bootstrap-host.sh runs it for you. Idempotent.
#
# The containers are already narrow (rootless daemons, every capability
# dropped, no credentials in the agent). This is the other half: the box they
# all share, which one weak SSH password or one unpatched kernel takes away
# from every client at once.
#
#   1. sshd        keys only, no root sign-in, as a drop-in sshd reads first
#   2. upgrades    unattended-upgrades, with a reboot window for kernels
#   3. firewall    ufw: deny incoming, then sshd's own port, 80 and 443
#   4. sysctl      the part of dev-sec.io's os_hardening baseline that does not
#                  break Docker or rootless mode
#
# --audit is separate and changes nothing: it runs Lynis and publishes the
# hardening index where the metrics collector already looks.
#
# The one way this script can hurt is by locking its operator out, so every
# refusal is decided before the first file is written.

usage() {
  cat <<'USAGE'
Usage: ops/harden-host.sh [options]
       ops/harden-host.sh --audit

Hardens sshd, turns on automatic security upgrades, enables the firewall and
applies kernel settings. Run as root. Idempotent.

Options:
  --ssh-users "<a> <b>"   Also restrict SSH to these accounts (AllowUsers). Each
                          must have an authorized_keys file, and at least one
                          must be in the sudo group. Off by default.
  --reboot-time <HH:MM>   When a pending kernel upgrade may reboot the host, in
                          the host's own timezone (default 04:00). A reboot
                          interrupts a running request; the app rebuilds it
                          from its pull request.
  --no-auto-reboot        Install upgrades but never reboot for them.
  --no-ssh                Leave sshd alone.
  --no-firewall           Leave ufw alone.
  --no-apply              Write the files, print the commands that would
                          activate them, run none. Needs no root. With
                          HARDEN_ROOT=<dir> the files land under <dir>.
  --audit                 Run Lynis, publish webamend_host_hardening_index for
                          the collector, print the top suggestions. Hardens
                          nothing.
  -h, --help              Show this message.

Root sign-in over SSH is turned off only when an account in the sudo group has
an authorized_keys file. Without one, root keeps key sign-in and the script
says so. With no key on any account it refuses rather than lock you out.
USAGE
}

# Test seam, like CLIENT_ROOT in set-env.sh: every path below is under it.
HARDEN_ROOT="${HARDEN_ROOT:-}"

# 00-, not 99-: sshd keeps the FIRST value it reads for a keyword, and cloud
# images ship 50-cloud-init.conf with `PasswordAuthentication yes`. A drop-in
# that sorts after it is parsed, validated, and ignored.
SSH_DROPIN=/etc/ssh/sshd_config.d/00-webamend-hardening.conf
SYSCTL_FILE=/etc/sysctl.d/60-webamend-hardening.conf
PERIODIC_FILE=/etc/apt/apt.conf.d/20auto-upgrades
# 52, so it is read after the distribution's 50unattended-upgrades and wins.
REBOOT_FILE=/etc/apt/apt.conf.d/52webamend-unattended-upgrades
LYNIS_REPORT=/var/log/lynis-report.dat
TEXTFILE_DIR=/var/lib/node_exporter/textfile
PROM_FILE="${TEXTFILE_DIR}/webamend-hardening.prom"

APPLY=1
AUDIT=0
WITH_SSH=1
WITH_FIREWALL=1
AUTO_REBOOT=true
REBOOT_TIME=04:00
SSH_USERS=""
ROOT_LOGIN=no

die() {
  echo "harden-host: $*" >&2
  exit 1
}

note() {
  echo "harden-host: $*"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --ssh-users)
        [ $# -ge 2 ] || die "--ssh-users needs a quoted list of account names"
        SSH_USERS="$2"
        shift 2
        ;;
      --reboot-time)
        [ $# -ge 2 ] || die "--reboot-time needs HH:MM"
        REBOOT_TIME="$2"
        shift 2
        ;;
      --no-auto-reboot) AUTO_REBOOT=false; shift ;;
      --no-ssh) WITH_SSH=0; shift ;;
      --no-firewall) WITH_FIREWALL=0; shift ;;
      --no-apply) APPLY=0; shift ;;
      --audit) AUDIT=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
}

validate_args() {
  [[ "$REBOOT_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] ||
    die "--reboot-time must be HH:MM on a 24-hour clock, got: ${REBOOT_TIME}"
  local user
  for user in $SSH_USERS; do
    [[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--ssh-users: '${user}' is not an account name"
  done
  if [ "$APPLY" -eq 1 ]; then
    [ -z "$HARDEN_ROOT" ] ||
      die "HARDEN_ROOT is set, so files would land under it while the commands hit this host. Add --no-apply."
    [ "$(id -u)" -eq 0 ] || die "must run as root. Try: sudo $0, or look first with --no-apply"
  fi
}

# Prints instead of running under --no-apply, so the plan can be read (and
# tested) without a host to run it on.
run() {
  if [ "$APPLY" -eq 0 ]; then
    echo "would run: $*"
    return 0
  fi
  "$@"
}

# Content on stdin. Written through a temp file beside the target; the temp
# name does not end in .conf, so neither sshd nor sysctl reads a half-written
# one.
write_file() {
  local shown="$1" mode="$2" path="${HARDEN_ROOT}$1" tmp
  mkdir -p "$(dirname -- "$path")"
  tmp="$(mktemp "${path}.XXXXXX")"
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    note "${shown} unchanged"
    return 0
  fi
  chmod "$mode" "$tmp"
  mv -- "$tmp" "$path"
  note "wrote ${shown}"
}

ensure_packages() {
  if [ "$APPLY" -eq 0 ]; then
    echo "would run: apt-get install -y -qq $*"
    return 0
  fi
  local missing=() pkg
  for pkg in "$@"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  [ ${#missing[@]} -gt 0 ] || return 0
  note "installing: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" ||
    die "could not install: ${missing[*]}"
}

# --- who can still get in -------------------------------------------------------

home_of() {
  awk -F: -v user="$1" '$1 == user {print $6}' "${HARDEN_ROOT}/etc/passwd"
}

has_keys() {
  local home
  home="$(home_of "$1")"
  [ -n "$home" ] && [ -s "${HARDEN_ROOT}${home}/.ssh/authorized_keys" ]
}

# Accounts that can both sign in with a key and become root afterwards.
keyed_admins() {
  local user
  for user in $(awk -F: '$1 == "sudo" {gsub(",", " ", $4); print $4}' "${HARDEN_ROOT}/etc/group"); do
    if has_keys "$user"; then echo "$user"; fi
  done
}

# Decides ROOT_LOGIN, or refuses. Writes nothing: main runs this before any
# step does, so a refusal leaves the host exactly as it was.
plan_ssh() {
  [ "$WITH_SSH" -eq 1 ] || return 0
  [ -f "${HARDEN_ROOT}/etc/passwd" ] || die "${HARDEN_ROOT}/etc/passwd not found"
  local admins user allowed_admin=""
  admins="$(keyed_admins)"

  if [ -n "$SSH_USERS" ]; then
    for user in $SSH_USERS; do
      [ -n "$(home_of "$user")" ] || die "--ssh-users: no account named '${user}'"
      has_keys "$user" || die "--ssh-users: '${user}' has no authorized_keys file and could never sign in"
      if echo "$admins" | grep -qx "$user"; then allowed_admin="$user"; fi
    done
    # AllowUsers shuts root out as well, so one of the listed accounts has to
    # be able to reach root by sudo.
    [ -n "$allowed_admin" ] ||
      die "--ssh-users: none of '${SSH_USERS}' is in the sudo group. That list would lock out every administrator."
    ROOT_LOGIN=no
    return 0
  fi

  if [ -n "$admins" ]; then
    ROOT_LOGIN=no
    return 0
  fi
  if has_keys root; then
    ROOT_LOGIN=prohibit-password
    note "no administrator other than root has an authorized_keys file; root keeps key sign-in. Add a keyed account to the sudo group and re-run to turn it off."
    return 0
  fi
  die "no account has an authorized_keys file; turning password sign-in off now would lock everyone out. Add a key first, or pass --no-ssh."
}

# --- the steps ------------------------------------------------------------------

render_ssh_dropin() {
  cat <<EOF
# Written by ops/harden-host.sh; edits here are overwritten on the next run.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin ${ROOT_LOGIN}
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
EOF
  if [ -n "$SSH_USERS" ]; then
    # Re-split so the line is single-spaced however the list was quoted.
    # shellcheck disable=SC2086
    echo "AllowUsers" $SSH_USERS
  fi
}

# A Match block or a main file that sets the keyword above its Include would
# still win over the drop-in; ask sshd what it actually resolved.
verify_ssh_effective() {
  [ "$APPLY" -eq 1 ] || return 0
  sshd -T 2>/dev/null | grep -qx 'passwordauthentication no' ||
    die "sshd still allows password sign-in after the drop-in. Something in /etc/ssh/sshd_config sets it before the Include line; remove that and re-run."
}

harden_ssh() {
  if [ "$WITH_SSH" -eq 0 ]; then
    note "leaving sshd alone (--no-ssh)"
    return 0
  fi
  render_ssh_dropin | write_file "$SSH_DROPIN" 0644
  # Ubuntu 24.04 starts sshd from a socket, so until the first connection
  # nothing has created this, and `sshd -t` fails on its absence rather than
  # on anything in the configuration.
  [ "$APPLY" -eq 0 ] || install -d -m 0755 /run/sshd
  if ! run sshd -t; then
    rm -f -- "${HARDEN_ROOT}${SSH_DROPIN}"
    die "sshd rejected the new configuration; the drop-in was removed and sshd was not reloaded"
  fi
  # The unit is `ssh` on Ubuntu. Established sessions live in their own scope
  # and survive this; only new connections see the new rules.
  run systemctl reload-or-restart ssh
  verify_ssh_effective
  note "sshd: keys only, root sign-in '${ROOT_LOGIN}'"
}

enable_upgrades() {
  ensure_packages unattended-upgrades
  write_file "$PERIODIC_FILE" 0644 <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  # Docker's own apt repository is not among unattended-upgrades' allowed
  # origins, and is deliberately not added: a dockerd upgrade restarts the
  # daemon under the registry at a time nobody chose. Upgrade Docker by hand.
  write_file "$REBOOT_FILE" 0644 <<EOF
Unattended-Upgrade::Automatic-Reboot "${AUTO_REBOOT}";
Unattended-Upgrade::Automatic-Reboot-Time "${REBOOT_TIME}";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
  run systemctl enable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer
  note "security upgrades: daily; reboot for a kernel: ${AUTO_REBOOT} at ${REBOOT_TIME}"
}

# Read from the configuration rather than assumed: a host whose sshd listens
# on 2222 and whose firewall opens 22 is a host nobody can reach.
ssh_ports() {
  local ports
  ports="$(cat "${HARDEN_ROOT}/etc/ssh/sshd_config" "${HARDEN_ROOT}"/etc/ssh/sshd_config.d/*.conf 2>/dev/null |
    awk 'tolower($1) == "port" {print $2}' | sort -un)"
  echo "${ports:-22}"
}

# Client ports need no rule: every one is published on loopback only, and a
# rootless daemon forwards in userspace, outside iptables altogether.
enable_firewall() {
  if [ "$WITH_FIREWALL" -eq 0 ]; then
    note "leaving the firewall alone (--no-firewall)"
    return 0
  fi
  ensure_packages ufw
  local port
  run ufw default deny incoming
  run ufw default allow outgoing
  # Before `enable`, always: enabling first drops the session running this.
  for port in $(ssh_ports); do
    run ufw allow "${port}/tcp"
  done
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  # HTTP/3, which Caddy serves by default.
  run ufw allow 443/udp
  run ufw --force enable
  note "firewall: incoming denied except ssh ($(ssh_ports | tr '\n' ' ')), 80 and 443"
}

# From dev-sec.io's os_hardening defaults, minus what this host cannot take:
#   net.ipv4.ip_forward=0            Docker routes container traffic through it
#   user.max_user_namespaces=0       rootless dockerd IS a user namespace
#   net.ipv6.conf.*.accept_ra=0      some providers hand out IPv6 routes by RA
#   net.ipv4.conf.*.log_martians=1   logs at warning, which the journal ships
apply_sysctl() {
  write_file "$SYSCTL_FILE" 0644 <<'EOF'
# Written by ops/harden-host.sh; edits here are overwritten on the next run.
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.sysrq = 0
kernel.randomize_va_space = 2
kernel.yama.ptrace_scope = 1
kernel.perf_event_paranoid = 3
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
fs.suid_dumpable = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
EOF
  # -e: a key this kernel does not have is skipped, not fatal.
  run sysctl -e -q -p "${HARDEN_ROOT}${SYSCTL_FILE}"
}

# --- audit ----------------------------------------------------------------------

modified_at() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

# The timestamp is the report's, not now's: if Lynis failed and an old report
# is still lying there, the metric says how old the number is instead of
# presenting it as fresh.
run_audit() {
  local report="${HARDEN_ROOT}${LYNIS_REPORT}" index
  ensure_packages lynis
  run lynis audit system --quick --no-colors --quiet ||
    note "lynis exited non-zero; reading whatever report it left"
  [ -f "$report" ] || die "${LYNIS_REPORT} not found; lynis wrote no report"
  index="$(grep -E '^hardening_index=' "$report" | tail -n 1 | cut -d= -f2)"
  [[ "$index" =~ ^[0-9]{1,3}$ ]] || die "no hardening_index in ${LYNIS_REPORT}"

  write_file "$PROM_FILE" 0644 <<EOF
# HELP webamend_host_hardening_index Lynis hardening index of this host, 0-100.
# TYPE webamend_host_hardening_index gauge
webamend_host_hardening_index ${index}
# HELP webamend_host_hardening_audit_timestamp_seconds When that index was measured.
# TYPE webamend_host_hardening_audit_timestamp_seconds gauge
webamend_host_hardening_audit_timestamp_seconds $(modified_at "$report")
EOF
  note "hardening index: ${index}/100. Top suggestions (full list: ${LYNIS_REPORT}):"
  grep -E '^suggestion\[\]=' "$report" | head -n 15 | cut -d= -f2- | cut -d'|' -f1-2 | sed 's/|/  /; s/^/  /' || true
}

main() {
  parse_args "$@"
  validate_args
  if [ "$AUDIT" -eq 1 ]; then
    run_audit
    return 0
  fi
  plan_ssh
  harden_ssh
  enable_upgrades
  enable_firewall
  apply_sysctl
  note "done. Measure it: ops/harden-host.sh --audit"
}

main "$@"
