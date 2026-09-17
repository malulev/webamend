#!/usr/bin/env bash
# Exercises ops/set-env.sh against a throwaway client tree. Runs unprivileged
# with --no-recreate, so it covers the file edits and the refusals, not the
# container restart. Run: bash tests/ops/set-env.test.sh
set -euo pipefail

SCRIPT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/ops/set-env.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1" >&2; failures=$((failures + 1)); }
assert_eq() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$2', got '$3'"; fi
}
assert_contains() { # name needle haystack
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1: '$2' not found in output" ;; esac
}
assert_not_contains() { # name needle haystack
  case "$3" in *"$2"*) fail "$1: '$2' leaked into output" ;; *) pass "$1" ;; esac
}

fresh_clients() {
  rm -rf "${ROOT:?}"/*
  mkdir -p "$ROOT/acme" "$ROOT/beta" "$ROOT/empty"
  printf '# acme\nPORT_HOST=3001\nSMTP_FROM=old@example.com\nSESSION_SECRET=s3cret\n' >"$ROOT/acme/.env"
  printf 'PORT_HOST=3002\nSESSION_SECRET=s3cret\n' >"$ROOT/beta/.env"
}

run() { # runs the script unprivileged, never recreating; captures output + status
  set +e
  OUT="$(CLIENT_ROOT="$ROOT" bash "$SCRIPT" "$@" --no-recreate 2>&1)"
  STATUS=$?
  set -e
}

value_of() { grep -E "^$2=" "$ROOT/$1/.env" | cut -d= -f2-; }
count_of() { grep -cE "^$2=" "$ROOT/$1/.env" || true; }

# --- replaces an existing value and appends a missing one ---------------------
fresh_clients
run SMTP_FROM hello@webamend.com
assert_eq "exit 0 on success" 0 "$STATUS"
assert_eq "acme replaced" "hello@webamend.com" "$(value_of acme SMTP_FROM)"
assert_eq "acme has one SMTP_FROM line" 1 "$(count_of acme SMTP_FROM)"
assert_eq "beta appended" "hello@webamend.com" "$(value_of beta SMTP_FROM)"
assert_eq "acme comment kept" "# acme" "$(head -n 1 "$ROOT/acme/.env")"
assert_not_contains "value never printed" "hello@webamend.com" "$OUT"
assert_contains "summary names acme" "acme" "$OUT"
assert_contains "summary names beta" "beta" "$OUT"
assert_not_contains "dir without .env is skipped silently" "empty" "$OUT"

# --- --client limits the change --------------------------------------------------
fresh_clients
run SMTP_FROM hello@webamend.com --client beta
assert_eq "--client exit 0" 0 "$STATUS"
assert_eq "acme untouched with --client beta" "old@example.com" "$(value_of acme SMTP_FROM)"
assert_eq "beta set with --client beta" "hello@webamend.com" "$(value_of beta SMTP_FROM)"

run SMTP_FROM x@y.z --client nobody
assert_eq "unknown --client fails" 1 "$STATUS"

# --- --unset removes the line ------------------------------------------------------
fresh_clients
run --unset SMTP_FROM
assert_eq "--unset exit 0" 0 "$STATUS"
assert_eq "acme SMTP_FROM removed" 0 "$(count_of acme SMTP_FROM)"
assert_eq "acme other lines kept" "3001" "$(value_of acme PORT_HOST)"

# --- refusals leave every file untouched -------------------------------------------
fresh_clients
before="$(cat "$ROOT/acme/.env")"
run PORT 3000
assert_eq "PORT refused" 1 "$STATUS"
run PORT_HOST 9999
assert_eq "provisioning-owned name refused" 1 "$STATUS"
run lower_case v
assert_eq "bad name refused" 1 "$STATUS"
run SMTP_FROM ""
assert_eq "empty value refused" 1 "$STATUS"
run SMTP_FROM "$(printf 'a\nb')"
assert_eq "multi-line value refused" 1 "$STATUS"
run
assert_eq "no arguments refused" 1 "$STATUS"
assert_eq "refusals wrote nothing" "$before" "$(cat "$ROOT/acme/.env")"

# --- a corrupt .env is caught before anything is restarted -------------------------
fresh_clients
printf '=\n' >>"$ROOT/beta/.env"
before_beta="$(cat "$ROOT/beta/.env")"
run SMTP_FROM hello@webamend.com
assert_eq "corrupt file fails the run" 1 "$STATUS"
assert_contains "corrupt file is named with a line number" "beta: .env line 3" "$OUT"
assert_eq "corrupt file restored" "$before_beta" "$(cat "$ROOT/beta/.env")"
assert_eq "healthy client still updated" "hello@webamend.com" "$(value_of acme SMTP_FROM)"

# --- every shape Compose accepts passes validation ---------------------------------
fresh_clients
{
  printf "GITHUB_APP_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----\n"
  printf 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n'
  printf -- "-----END RSA PRIVATE KEY-----'\n"
  printf 'OTHER_KEY="-----BEGIN X-----\nabc\n-----END X-----"\n'
  printf 'export EXPORTED=1\n'
  printf 'lower_case_name=allowed by compose\n'
  printf '  # indented comment\n'
  printf 'QUOTED_ONE_LINE="a b c"\n'
  printf "EMPTY_QUOTE=''\n"
} >>"$ROOT/acme/.env"
run SMTP_FROM hello@webamend.com --client acme
assert_eq "single-quoted PEM, export, lowercase all accepted" 0 "$STATUS"
assert_eq "PEM file still updated" "hello@webamend.com" "$(value_of acme SMTP_FROM)"
assert_eq "PEM closing line intact" "-----END RSA PRIVATE KEY-----'" "$(grep -F -- "END RSA" "$ROOT/acme/.env")"

# --- --check reports without touching anything ------------------------------------
fresh_clients
printf '=\n' >>"$ROOT/beta/.env"
before_acme="$(cat "$ROOT/acme/.env")"; before_beta="$(cat "$ROOT/beta/.env")"
run --check
assert_eq "--check exit 1 with a bad file" 1 "$STATUS"
assert_contains "--check names the good client ok" "acme             ok" "$OUT"
assert_contains "--check names the bad line" "beta             REJECTED: .env line 3" "$OUT"
assert_eq "--check wrote nothing (acme)" "$before_acme" "$(cat "$ROOT/acme/.env")"
assert_eq "--check wrote nothing (beta)" "$before_beta" "$(cat "$ROOT/beta/.env")"
run --check --client acme
assert_eq "--check exit 0 when clean" 0 "$STATUS"

# --- --dry-run changes nothing -----------------------------------------------------
fresh_clients
run SMTP_FROM hello@webamend.com --dry-run
assert_eq "--dry-run exit 0" 0 "$STATUS"
assert_eq "--dry-run wrote nothing" "old@example.com" "$(value_of acme SMTP_FROM)"
assert_contains "--dry-run says replace" "acme: would replace SMTP_FROM" "$OUT"
assert_contains "--dry-run says add" "beta: would add SMTP_FROM" "$OUT"

echo
if [ "$failures" -eq 0 ]; then
  echo "set-env: all checks passed"
else
  echo "set-env: ${failures} check(s) failed" >&2
  exit 1
fi
