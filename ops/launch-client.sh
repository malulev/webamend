#!/usr/bin/env bash
set -euo pipefail

# Takes one client from "nothing" to "serving HTTPS" in a single run. Run as
# root on a host already prepared by bootstrap-host.sh. Idempotent: every step
# checks what is already there and re-running after a failure resumes where it
# stopped.
#
# It does not replace the four scripts it calls; it sequences them and fills
# in the hand steps between them:
#
#   1. provision-client.sh     user, rootless daemon, 0700 tree, .env skeleton
#   2. edit .env               the credentials only a person knows
#   3. gen:secrets             minted in a throwaway node container, appended as the client user
#   4. check:env               names what is missing, prints no values
#   5. DNS                     waits until <hostname> resolves to this box
#   6. release.sh --client     build once, deliver, start, wait
#   7. Caddy                   one site block, validate, reload
#   8. status.sh + HTTPS       proves the whole path answers
#   9. enroll:link             the 24-hour link that shows the client their authenticator QR
#
# One step is interactive: the .env editor, for the credentials only a person
# knows. Everything else is derived. No secret value is ever printed; the
# enrollment link carries a signed token, not the secret.

usage() {
  cat <<'USAGE'
Usage: ops/launch-client.sh <slug> <hostname> [port] [options]

Provisions, configures, releases and exposes one client installation, in
order, stopping at the steps only a person can do. Run as root.

Arguments:
  <slug>      Client identifier; becomes the Linux user. Lowercase letters,
              digits and hyphens, 2-31 characters, starting with a letter.
  <hostname>  Public hostname, e.g. edit.client.example. Must have an A (and
              optionally AAAA) record pointing at this host before the proxy
              step can obtain a certificate.
  [port]      Loopback port unique to this client, 1024-65535. Optional: a
              re-run keeps the client's existing PORT_HOST, and a new client
              gets the lowest free port from 3001 up.

Options:
  --values <file>         KEY=VALUE lines to merge into the client's .env
                          instead of opening an editor. The file is read once
                          and never copied anywhere. Use it from automation;
                          by hand, the editor is safer.
  --dns-timeout <sec>     How long to wait for DNS to resolve here (default 900).
                          0 waits forever.
  --skip-dns              Do not check DNS. Caddy will retry certificate issuance
                          on its own once the record exists.
  --no-proxy              Do not touch /etc/caddy/Caddyfile. Print the block instead.
  --registry-port <port>  Host registry port (default 5000). Must match
                          bootstrap-host.sh.
  -h, --help              Show this message.

Examples:
  ops/launch-client.sh acme edit.acme.example        # port chosen for you
  ops/launch-client.sh acme edit.acme.example 3001
USAGE
}

CLIENT_ROOT=/srv/webamend
CADDYFILE=/etc/caddy/Caddyfile
REGISTRY_PORT=5000
DNS_TIMEOUT=900
SKIP_DNS=0
NO_PROXY=0
VALUES_FILE=""
SLUG=""
HOSTNAME_ARG=""
PORT=""

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"

# The hand-filled half of the skeleton. A launch cannot proceed while any of
# these is empty; check:env would say so too, but naming them here saves a
# round trip through a node container.
REQUIRED_BY_HAND=(
  GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_INSTALLATION_ID GITHUB_REPO
  NETLIFY_TOKEN NETLIFY_SITE_ID OPENROUTER_API_KEY SMTP_URL SMTP_FROM ALLOWED_EMAILS
)

die() {
  echo "launch-client: $*" >&2
  exit 1
}

note() {
  echo "launch-client: $*"
}

step() {
  echo
  echo "== $* =="
}

parse_args() {
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --values)
        [ $# -ge 2 ] || die "--values needs a file"
        VALUES_FILE="$2"
        shift 2
        ;;
      --dns-timeout)
        [ $# -ge 2 ] || die "--dns-timeout needs a number of seconds"
        DNS_TIMEOUT="$2"
        shift 2
        ;;
      --skip-dns)
        SKIP_DNS=1
        shift
        ;;
      --no-proxy)
        NO_PROXY=1
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

  if [ "${#positional[@]}" -lt 2 ] || [ "${#positional[@]}" -gt 3 ]; then
    usage >&2
    die "expected 2 or 3 arguments (slug, hostname, [port]), got ${#positional[@]}"
  fi

  SLUG="${positional[0]}"
  HOSTNAME_ARG="${positional[1]}"
  PORT="${positional[2]:-}"
}

validate_args() {
  [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]] ||
    die "slug '${SLUG}' must be lowercase letters, digits and hyphens, 2-31 characters, starting with a letter"
  [[ "$HOSTNAME_ARG" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] ||
    die "hostname '${HOSTNAME_ARG}' does not look like a DNS name. Pass the bare host, no scheme, no path."
  if [ -n "$PORT" ]; then
    case "$PORT" in *[!0-9]*) die "port '${PORT}' is not a number" ;; esac
    [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "port ${PORT} is outside 1024-65535"
  fi
  case "$DNS_TIMEOUT" in '' | *[!0-9]*) die "--dns-timeout must be a whole number of seconds" ;; esac
  case "$REGISTRY_PORT" in '' | *[!0-9]*) die "--registry-port must be a whole number" ;; esac
  if [ -n "$VALUES_FILE" ]; then
    [ -f "$VALUES_FILE" ] || die "--values file not found: ${VALUES_FILE}"
  fi
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root. Try: sudo $0 ..."
}

require_scripts() {
  local s
  for s in provision-client.sh release.sh status.sh; do
    [ -x "${SCRIPT_DIR}/${s}" ] || die "${SCRIPT_DIR}/${s} is missing or not executable"
  done
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v docker >/dev/null 2>&1 || die "docker is not installed. Run ops/bootstrap-host.sh first."
}

# Same as release.sh: rewritten through a 0600 temp file in the same directory
# so the file holding every secret is never world-readable, even briefly.
set_env_value() {
  local env_file="$1" name="$2" value="$3"
  local tmp
  tmp="$(mktemp "$(dirname -- "$env_file")/.env.XXXXXX")"
  chown "${SLUG}:${SLUG}" "$tmp"
  chmod 0600 "$tmp"
  if grep -qE "^${name}=" "$env_file"; then
    # awk reading the value from the environment rather than sed or `awk -v`:
    # sed interprets `|`, `&` and backslashes in the replacement, and `-v`
    # unescapes backslashes, which would turn a private key pasted with
    # literal `\n` into real newlines. ENVIRON passes bytes through untouched.
    LC_NAME="$name" LC_VALUE="$value" awk \
      'BEGIN{n=ENVIRON["LC_NAME"]; v=ENVIRON["LC_VALUE"]; done=0}
       index($0, n"=")==1 && !done {print n"="v; done=1; next} {print}' \
      "$env_file" >"$tmp"
  else
    cat "$env_file" >"$tmp"
    printf '%s=%s\n' "$name" "$value" >>"$tmp"
  fi
  mv -- "$tmp" "$env_file"
  chown "${SLUG}:${SLUG}" "$env_file"
  chmod 0600 "$env_file"
}

read_env_value() {
  local env_file="$1" name="$2"
  grep -E "^${name}=" "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

env_file_path() {
  echo "${CLIENT_ROOT}/${SLUG}/.env"
}

missing_by_hand() {
  local env_file="$1" name value
  for name in "${REQUIRED_BY_HAND[@]}"; do
    value="$(read_env_value "$env_file" "$name")"
    # The skeleton ships GITHUB_REPO=owner/name as a placeholder, not a value.
    if [ -z "$value" ] || { [ "$name" = "GITHUB_REPO" ] && [ "$value" = "owner/name" ]; }; then
      echo "$name"
    fi
  done
}

# Every PORT_HOST already claimed by a client on this host, one per line.
claimed_ports() {
  local env_file
  for env_file in "$CLIENT_ROOT"/*/.env; do
    [ -f "$env_file" ] || continue
    # `|| true`: a skeleton with no port yet is not an error, and set -e would
    # otherwise end the script on grep's exit status.
    grep -oE '^PORT_HOST=[0-9]+' "$env_file" | cut -d= -f2 || true
  done
  return 0
}

port_in_use() {
  ss -Hltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
}

# A re-run keeps the port the client already has; a new client gets the lowest
# port from 3001 up that no other client claims and nothing else listens on.
choose_port() {
  local existing
  existing="$(read_env_value "$(env_file_path)" PORT_HOST)"
  if [ -n "$existing" ]; then
    PORT="$existing"
    note "port ${PORT}: kept from the existing ${SLUG} .env"
    return 0
  fi
  local claimed candidate=3001
  claimed="$(claimed_ports)"
  while [ "$candidate" -le 65535 ]; do
    if ! echo "$claimed" | grep -qx "$candidate" && ! port_in_use "$candidate"; then
      PORT="$candidate"
      note "port ${PORT}: lowest free loopback port"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  die "no free port found from 3001 up"
}

# ---------------------------------------------------------------------------

step_provision() {
  step "1/9 provision ${SLUG}"
  local force=()
  if id -u "$SLUG" >/dev/null 2>&1 || [ -d "${CLIENT_ROOT}/${SLUG}" ]; then
    force=(--force)
  fi
  # Its "remaining steps" epilogue is what this script performs next, so it is
  # cut; its diagnostics still reach the terminal.
  "${SCRIPT_DIR}/provision-client.sh" "$SLUG" "$HOSTNAME_ARG" "$PORT" \
    --registry-port "$REGISTRY_PORT" "${force[@]}" |
    sed '/^provision-client: .* is provisioned\. Nothing is running yet/,$d'
}

# Reads KEY=VALUE lines, plus the double-quoted multi-line form a PEM arrives
# in (`KEY="-----BEGIN ...` through the line ending in `"`), the same two
# shapes check-env.ts accepts. Diagnostics name a line NUMBER, never its
# content: a continuation line of a private key must not reach the terminal.
merge_values_file() {
  local env_file="$1" line name value count=0 lineno=0 open_name="" open_value=""
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if [ -n "$open_name" ]; then
      open_value="${open_value}"$'\n'"${line}"
      case "$line" in
        *\") ;;
        *) continue ;;
      esac
      name="$open_name"; value="$open_value"; open_name=""; open_value=""
    else
      case "$line" in '' | '#'*) continue ;; esac
      [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || die "--values: line ${lineno} is not KEY=VALUE"
      name="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      case "$value" in
        \"*\") ;;
        \"*) open_name="$name"; open_value="$value"; continue ;;
      esac
    fi
    case "$name" in
      PORT) die "--values: PORT must never be set in a client .env; PORT_HOST is filled in by provisioning" ;;
      PUBLIC_BASE_URL | WEBAGENT_STATE_DIR | DOCKER_SOCK | PORT_HOST | APP_IMAGE | AGENT_IMAGE)
        note "--values: ${name} is owned by provisioning and release; ignored"
        continue
        ;;
    esac
    set_env_value "$env_file" "$name" "$value"
    count=$((count + 1))
  done <"$VALUES_FILE"
  [ -z "$open_name" ] || die "--values: ${open_name} opens a double-quoted value that never closes"
  note "merged ${count} value(s) from ${VALUES_FILE}; names only, nothing echoed"
}

open_editor() {
  local env_file="$1" editor
  [ -t 0 ] || die "no terminal to open an editor in. Pass --values <file> or fill in ${env_file} first."
  editor="${VISUAL:-${EDITOR:-}}"
  if [ -z "$editor" ]; then
    for candidate in nano vim vi; do
      command -v "$candidate" >/dev/null 2>&1 && editor="$candidate" && break
    done
  fi
  [ -n "$editor" ] || die "no editor found; set EDITOR or pass --values <file>"
  echo "Opening ${env_file} in ${editor}. Fill in the section 'Fill these in by hand', save, and exit."
  echo "Press Enter to continue."
  read -r _
  "$editor" "$env_file"
  # An editor may have rewritten the file with its own idea of a mode.
  chown "${SLUG}:${SLUG}" "$env_file"
  chmod 0600 "$env_file"
}

step_fill_env() {
  step "2/9 fill in ${SLUG}'s .env"
  local env_file missing
  env_file="$(env_file_path)"
  [ -f "$env_file" ] || die "${env_file} does not exist; provisioning should have written it"

  if [ -n "$VALUES_FILE" ]; then
    merge_values_file "$env_file"
  fi

  missing="$(missing_by_hand "$env_file")"
  if [ -n "$missing" ] && [ -z "$VALUES_FILE" ]; then
    echo "Still empty: $(echo "$missing" | tr '\n' ' ')"
    open_editor "$env_file"
    missing="$(missing_by_hand "$env_file")"
  fi
  if [ -n "$missing" ]; then
    die "these are still empty in ${env_file}: $(echo "$missing" | tr '\n' ' '). Fill them in and re-run; every step so far is kept."
  fi
  note "all hand-filled variables present"
}

# The node toolchain runs in a throwaway container from a read-only copy of the
# checkout, so the host needs no Node and the build source stays clean. First
# argument: the shell command to run after `npm ci`; the rest: extra options
# for `docker run` (mounts, environment).
node_in_container() {
  local script="$1"
  shift
  docker run --rm -i "$@" -v "${REPO_ROOT}:/src:ro" -w /build node:22-slim \
    sh -c "cp -a /src/. /build && npm ci --silent && ${script}"
}

step_secrets() {
  step "3/9 mint secrets"
  local env_file
  env_file="$(env_file_path)"
  if [ -n "$(read_env_value "$env_file" TOTP_SECRET)" ] ||
    [ -n "$(read_env_value "$env_file" CONFIG_TOTP_SECRET)" ]; then
    note "secrets already present (TOTP_SECRET is set); not minting again"
    return 0
  fi

  local out
  # Captured, then appended as the client user, so the file stays 0600 and no
  # line of it passes through the terminal.
  out="$(node_in_container 'npm run --silent gen:secrets')" ||
    die "gen:secrets failed; see the output above"
  [ -n "$out" ] || die "gen:secrets produced nothing"
  printf '\n%s\n' "$out" | runuser -u "$SLUG" -- tee -a "$env_file" >/dev/null
  chmod 0600 "$env_file"
  note "appended SESSION_SECRET, NETLIFY_WEBHOOK_SECRET, TOTP_SECRET"
}

step_check_env() {
  step "4/9 check:env"
  local env_file
  env_file="$(env_file_path)"
  node_in_container 'cp /secret/.env /build/.env && npm run --silent check:env' \
    -v "${env_file}:/secret/.env:ro" ||
    die "check:env found a problem in ${env_file}; fix it and re-run. Nothing was started."
}

public_ips() {
  # Both families, because a hostname with an AAAA record must point that at
  # this box too, or half of the clients get a certificate error.
  curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true
  echo
  curl -6 -fsS --max-time 5 https://api64.ipify.org 2>/dev/null || true
  echo
}

resolved_ips() {
  getent ahosts "$HOSTNAME_ARG" 2>/dev/null | awk '{print $1}' | sort -u || true
}

step_dns() {
  step "5/9 DNS for ${HOSTNAME_ARG}"
  if [ "$SKIP_DNS" -eq 1 ]; then
    note "skipped (--skip-dns)"
    return 0
  fi

  local mine resolved deadline waited=0
  mine="$(public_ips | sed '/^$/d')"
  if [ -z "$mine" ]; then
    note "could not learn this host's public IP (no route to api.ipify.org?). Checking only that the name resolves."
  else
    echo "This host: $(echo "$mine" | tr '\n' ' ')"
  fi

  if [ "$DNS_TIMEOUT" -eq 0 ]; then deadline=0; else deadline=$(($(date +%s) + DNS_TIMEOUT)); fi
  while :; do
    resolved="$(resolved_ips)"
    if [ -n "$resolved" ]; then
      if [ -z "$mine" ]; then
        note "${HOSTNAME_ARG} resolves to $(echo "$resolved" | tr '\n' ' ')"
        return 0
      fi
      if echo "$resolved" | grep -qxF -f <(echo "$mine"); then
        note "${HOSTNAME_ARG} points here ($(echo "$resolved" | tr '\n' ' '))"
        return 0
      fi
      [ "$waited" -eq 0 ] && echo "${HOSTNAME_ARG} resolves to $(echo "$resolved" | tr '\n' ' '), which is not this host."
    else
      [ "$waited" -eq 0 ] && echo "${HOSTNAME_ARG} does not resolve yet."
    fi
    if [ "$waited" -eq 0 ]; then
      echo "At the DNS provider, create an A record for ${HOSTNAME_ARG} -> $(echo "$mine" | head -n 1)"
      [ "$(echo "$mine" | wc -l)" -gt 1 ] && echo "and an AAAA record -> $(echo "$mine" | sed -n 2p)"
      echo "Waiting (checking every 15 s; --skip-dns to move on, --dns-timeout to change the limit)..."
    fi
    if [ "$deadline" -ne 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
      die "gave up waiting for DNS after ${DNS_TIMEOUT}s. Create the record, then re-run; every step so far is kept."
    fi
    sleep 15
    waited=$((waited + 15))
  done
}

step_release() {
  step "6/9 release ${SLUG}"
  "${SCRIPT_DIR}/release.sh" --client "$SLUG" --registry-port "$REGISTRY_PORT" ||
    die "release failed for ${SLUG}. See: ops/status.sh ${SLUG} --logs"
}

caddy_block() {
  cat <<EOF
${HOSTNAME_ARG} {
    reverse_proxy 127.0.0.1:${PORT}
}
EOF
}

step_proxy() {
  step "7/9 reverse proxy"
  if [ "$NO_PROXY" -eq 1 ]; then
    note "not touching ${CADDYFILE} (--no-proxy). Add this block yourself:"
    caddy_block
    return 0
  fi
  if ! command -v caddy >/dev/null 2>&1; then
    note "caddy is not installed (apt-get install -y caddy). Add this block to your proxy yourself:"
    caddy_block
    return 0
  fi

  if [ -f "$CADDYFILE" ] && grep -qE "^[[:space:]]*${HOSTNAME_ARG//./\\.}[[:space:]]*\{" "$CADDYFILE"; then
    note "${HOSTNAME_ARG} already in ${CADDYFILE}; left as is"
  else
    mkdir -p "$(dirname -- "$CADDYFILE")"
    { [ -f "$CADDYFILE" ] && [ -s "$CADDYFILE" ] && echo; caddy_block; } >>"$CADDYFILE"
    note "appended a site block for ${HOSTNAME_ARG} to ${CADDYFILE}"
  fi

  caddy validate --config "$CADDYFILE" >/dev/null 2>&1 ||
    die "${CADDYFILE} does not validate. Run: caddy validate --config ${CADDYFILE}"
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || die "systemctl reload caddy failed"
    note "caddy reloaded"
  else
    systemctl enable --now caddy || die "could not start caddy"
    note "caddy started"
  fi
}

wait_for_https() {
  local deadline code
  deadline=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${HOSTNAME_ARG}/" || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      echo "$code"
      return 0
    fi
    sleep 5
  done
  return 1
}

step_verify() {
  step "8/9 verify"
  "${SCRIPT_DIR}/status.sh" "$SLUG"
  if [ "$NO_PROXY" -eq 1 ] || [ "$SKIP_DNS" -eq 1 ]; then
    note "HTTPS check skipped (proxy or DNS step was skipped)"
    return 0
  fi
  local code
  if code="$(wait_for_https)"; then
    note "https://${HOSTNAME_ARG}/ answers (HTTP ${code})"
  else
    die "https://${HOSTNAME_ARG}/ did not answer within 120s. Certificate issuance can lag a fresh DNS record; check: journalctl -u caddy -n 50"
  fi
}

# The client enrols their authenticator through this link. It is the only
# place the secret is shown, it carries a signed token rather than the secret
# itself, and it stops working after 24 hours. Run `npm run enroll:link` in
# the node container for a fresh one.
step_enrollment_link() {
  step "9/9 enrollment link"
  local env_file link
  env_file="$(env_file_path)"
  link="$(node_in_container 'cp /secret/.env /build/.env && npm run --silent enroll:link' \
    -v "${env_file}:/secret/.env:ro")" || {
    note "could not mint an enrollment link now; see ops/README.md for the command to run later"
    return 0
  }
  echo
  echo "Send this to the client. It shows their authenticator QR once and works for 24 hours:"
  echo "  ${link}"
}

print_done() {
  if [ "$NO_PROXY" -eq 1 ] || [ "$SKIP_DNS" -eq 1 ]; then
    cat <<EOF

launch-client: '${SLUG}' is running on 127.0.0.1:${PORT}. It is not reachable at
https://${HOSTNAME_ARG} yet: finish the DNS record and the proxy block above, then
re-run this command without --skip-dns / --no-proxy to verify HTTPS.
EOF
    return 0
  fi
  cat <<EOF

launch-client: '${SLUG}' is live at https://${HOSTNAME_ARG}

Prove it end to end:
  1. Open the URL, request a sign-in link with an address in ALLOWED_EMAILS, receive the email.
  2. Send a small change. A preview should appear within a few minutes.
  3. Press Publish, then Undo.
  4. Sign in again from another browser: the link, then the code from the authenticator.

Back up ${CLIENT_ROOT}/${SLUG}/.env. Nothing else; the authenticator seed is in it.
EOF
}

main() {
  parse_args "$@"
  validate_args
  require_root
  require_scripts
  [ -n "$PORT" ] || choose_port
  step_provision
  step_fill_env
  step_secrets
  step_check_env
  step_dns
  step_release
  step_proxy
  step_verify
  step_enrollment_link
  print_done
}

main "$@"
