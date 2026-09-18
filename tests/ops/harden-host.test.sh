#!/usr/bin/env bash
# Exercises ops/harden-host.sh against a throwaway root. Runs unprivileged with
# --no-apply, so it covers the files written, the order of the commands it
# would run, and the refusals — not sshd, ufw or apt themselves.
# Run: bash tests/ops/harden-host.test.sh
set -euo pipefail

SCRIPT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/ops/harden-host.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

SSH_DROPIN="$ROOT/etc/ssh/sshd_config.d/00-webamend-hardening.conf"
SYSCTL_FILE="$ROOT/etc/sysctl.d/60-webamend-hardening.conf"
REBOOT_FILE="$ROOT/etc/apt/apt.conf.d/52webamend-unattended-upgrades"
PERIODIC_FILE="$ROOT/etc/apt/apt.conf.d/20auto-upgrades"
PROM_FILE="$ROOT/var/lib/node_exporter/textfile/webamend-hardening.prom"

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1" >&2; failures=$((failures + 1)); }
assert_eq() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$2', got '$3'"; fi
}
assert_contains() { # name needle haystack
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1: '$2' not found" ;; esac
}
assert_not_contains() { # name needle haystack
  case "$3" in *"$2"*) fail "$1: '$2' should not be there" ;; *) pass "$1" ;; esac
}
assert_missing() { # name path
  if [ -e "$2" ]; then fail "$1: $2 exists"; else pass "$1"; fi
}

give_key() { # user home
  mkdir -p "$ROOT$2/.ssh"
  echo 'ssh-ed25519 AAAATESTKEY test' >"$ROOT$2/.ssh/authorized_keys"
}

# amit: an administrator with a key. claude: a key, no sudo. acme: a client
# account, neither. root: a key, as a provider's image ships it.
fresh_host() {
  rm -rf "${ROOT:?}"/*
  mkdir -p "$ROOT/etc/ssh"
  cat >"$ROOT/etc/passwd" <<'PASSWD'
root:x:0:0:root:/root:/bin/bash
amit:x:1000:1000::/home/amit:/bin/bash
claude:x:1001:1001::/home/claude:/bin/bash
acme:x:1002:1002::/home/acme:/usr/sbin/nologin
PASSWD
  printf 'root:x:0:\nsudo:x:27:amit\nwebamend-slots:x:999:acme\n' >"$ROOT/etc/group"
  printf 'Include /etc/ssh/sshd_config.d/*.conf\n' >"$ROOT/etc/ssh/sshd_config"
  give_key root /root
  give_key amit /home/amit
  give_key claude /home/claude
}

run() { # runs the script unprivileged against the throwaway root
  set +e
  OUT="$(HARDEN_ROOT="$ROOT" bash "$SCRIPT" --no-apply "$@" 2>&1)"
  STATUS=$?
  set -e
}

line_of() { # first line number of a needle in $OUT, 0 when absent
  echo "$OUT" | grep -nF -- "$1" | head -n 1 | cut -d: -f1 || true
}

# --- the default run ---------------------------------------------------------------
fresh_host
run
assert_eq "exit 0 on success" 0 "$STATUS"
ssh_conf="$(cat "$SSH_DROPIN")"
assert_contains "password sign-in off" "PasswordAuthentication no" "$ssh_conf"
assert_contains "root sign-in off when a keyed administrator exists" "PermitRootLogin no" "$ssh_conf"
assert_not_contains "no AllowUsers unless asked" "AllowUsers" "$ssh_conf"
sysctl_conf="$(grep -v '^#' "$SYSCTL_FILE")"
assert_contains "sysctl hardens kernel pointers" "kernel.kptr_restrict = 2" "$sysctl_conf"
assert_not_contains "sysctl leaves forwarding alone (Docker needs it)" "ip_forward" "$sysctl_conf"
assert_not_contains "sysctl leaves user namespaces alone (rootless needs them)" "user_namespaces" "$sysctl_conf"
assert_contains "periodic upgrades on" 'Unattended-Upgrade "1"' "$(cat "$PERIODIC_FILE")"
assert_contains "reboot window defaults to 04:00" 'Automatic-Reboot-Time "04:00"' "$(cat "$REBOOT_FILE")"
assert_contains "firewall opens https" "would run: ufw allow 443/tcp" "$OUT"
assert_contains "firewall opens http" "would run: ufw allow 80/tcp" "$OUT"
ssh_rule="$(line_of 'would run: ufw allow 22/tcp')"
enable_rule="$(line_of 'would run: ufw --force enable')"
if [ "${ssh_rule:-0}" -gt 0 ] && [ "$ssh_rule" -lt "${enable_rule:-0}" ]; then
  pass "ssh is allowed before the firewall is enabled"
else
  fail "ssh is allowed before the firewall is enabled: ssh at '${ssh_rule}', enable at '${enable_rule}'"
fi
assert_contains "sshd config is validated" "would run: sshd -t" "$OUT"

# --- idempotent --------------------------------------------------------------------
before="$(cat "$SSH_DROPIN" "$SYSCTL_FILE" "$REBOOT_FILE" "$PERIODIC_FILE")"
run
assert_eq "second run exit 0" 0 "$STATUS"
assert_eq "second run changes no file" "$before" "$(cat "$SSH_DROPIN" "$SYSCTL_FILE" "$REBOOT_FILE" "$PERIODIC_FILE")"
assert_contains "second run says so" "unchanged" "$OUT"

# --- a non-default ssh port is the one the firewall opens ---------------------------
fresh_host
printf 'Port 2222\n' >>"$ROOT/etc/ssh/sshd_config"
run
assert_contains "firewall follows sshd's port" "would run: ufw allow 2222/tcp" "$OUT"
assert_not_contains "and does not open 22" "ufw allow 22/tcp" "$OUT"

# --- no keyed administrator: root keeps key sign-in ---------------------------------
fresh_host
rm -rf "$ROOT/home/amit/.ssh"
run
assert_eq "exit 0 without a keyed administrator" 0 "$STATUS"
assert_contains "root keeps key sign-in" "PermitRootLogin prohibit-password" "$(cat "$SSH_DROPIN")"
assert_contains "and the reason is given" "no administrator" "$OUT"

# --- nobody has a key: refuse, and write nothing -------------------------------------
fresh_host
rm -rf "$ROOT/root/.ssh" "$ROOT/home/amit/.ssh" "$ROOT/home/claude/.ssh"
run
assert_eq "refuses when no account has a key" 1 "$STATUS"
assert_contains "names the lockout" "lock" "$OUT"
assert_missing "refusal wrote no sshd drop-in" "$SSH_DROPIN"
assert_missing "refusal wrote no sysctl file" "$SYSCTL_FILE"
run --no-ssh
assert_eq "--no-ssh proceeds without keys" 0 "$STATUS"
assert_missing "--no-ssh writes no sshd drop-in" "$SSH_DROPIN"

# --- --ssh-users ---------------------------------------------------------------------
fresh_host
run --ssh-users "amit claude"
assert_eq "--ssh-users exit 0" 0 "$STATUS"
assert_contains "AllowUsers written" "AllowUsers amit claude" "$(cat "$SSH_DROPIN")"
fresh_host
run --ssh-users claude
assert_eq "--ssh-users without an administrator refused" 1 "$STATUS"
assert_missing "and wrote nothing" "$SSH_DROPIN"
run --ssh-users "amit ghost"
assert_eq "--ssh-users with an unknown account refused" 1 "$STATUS"
run --ssh-users "amit acme"
assert_eq "--ssh-users with a keyless account refused" 1 "$STATUS"
run --ssh-users 'amit;reboot'
assert_eq "--ssh-users with a bad name refused" 1 "$STATUS"

# --- reboot window -------------------------------------------------------------------
fresh_host
run --reboot-time 03:30
assert_contains "--reboot-time is written" 'Automatic-Reboot-Time "03:30"' "$(cat "$REBOOT_FILE")"
run --reboot-time 25:00
assert_eq "bad --reboot-time refused" 1 "$STATUS"
run --no-auto-reboot
assert_contains "--no-auto-reboot turns it off" 'Automatic-Reboot "false"' "$(cat "$REBOOT_FILE")"

# --- --no-firewall -------------------------------------------------------------------
fresh_host
run --no-firewall
assert_eq "--no-firewall exit 0" 0 "$STATUS"
assert_not_contains "--no-firewall never touches ufw" "ufw" "$OUT"

# --- --audit reads the report and changes nothing else -------------------------------
fresh_host
mkdir -p "$ROOT/var/log"
printf 'report_version_major=1\nhardening_index=67\nsuggestion[]=SSH-7408|Consider hardening SSH configuration|-|-|\n' \
  >"$ROOT/var/log/lynis-report.dat"
run --audit
assert_eq "--audit exit 0" 0 "$STATUS"
assert_contains "index published" "webamend_host_hardening_index 67" "$(cat "$PROM_FILE")"
assert_contains "audit time published" "webamend_host_hardening_audit_timestamp_seconds" "$(cat "$PROM_FILE")"
assert_contains "suggestions shown" "SSH-7408" "$OUT"
assert_missing "--audit hardens nothing" "$SSH_DROPIN"
rm "$ROOT/var/log/lynis-report.dat" "$PROM_FILE"
run --audit
assert_eq "--audit without a report fails" 1 "$STATUS"
assert_missing "and publishes nothing" "$PROM_FILE"

# --- refusals ------------------------------------------------------------------------
run --bogus
assert_eq "unknown option refused" 1 "$STATUS"
if [ "$(id -u)" -ne 0 ]; then
  set +e
  OUT="$(bash "$SCRIPT" 2>&1)"
  STATUS=$?
  set -e
  assert_eq "applying needs root" 1 "$STATUS"
  set +e
  OUT="$(HARDEN_ROOT="$ROOT" bash "$SCRIPT" 2>&1)"
  STATUS=$?
  set -e
  assert_eq "HARDEN_ROOT without --no-apply refused" 1 "$STATUS"
  assert_contains "and says why" "--no-apply" "$OUT"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "${failures} failure(s)" >&2
  exit 1
fi
echo "all passed"
