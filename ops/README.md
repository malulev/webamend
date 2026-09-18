# ops — many clients, one VPS

The root README installs one client on one machine by hand. This directory does that 5–25
times on the same box without the clients being able to reach each other.

**One Linux user per client, each running its own rootless dockerd.** That is the whole idea.
The application mounts a Docker socket, and a socket is the authority of whoever owns the
daemon behind it. Point every installation at the root daemon and one client's remote code
execution is root on the box and every other client's secrets. Point client A at a daemon owned
by user A and the same compromise buys user A: A's `.env`, A's state, and nothing of B's.

```
/srv/webamend/<slug>/          0700 <slug>:<slug>
  .env                       0600 <slug>:<slug>    secrets, hand-filled
  docker-compose.yml         0600 <slug>:<slug>    copied from the repository
  state/                     0700 <slug>:<slug>    WEBAGENT_STATE_DIR
```

Both images are built **once**, on the host's root daemon, tagged by git short SHA, and stored
in a registry container on `127.0.0.1:5000`. Twenty clients each running `npm ci && npm run
build` on a shared 2 vCPU box is twenty times the work for one identical artefact. The registry
is on loopback because Docker treats loopback registries as insecure-by-default — which is
exactly why there is no TLS to configure, and exactly why it must never be reachable off-box.

A root-owned reverse proxy (Caddy) terminates TLS and forwards to each client's own
loopback-only port.

## Monitoring

Nothing here watches itself by default. [MONITORING.md](MONITORING.md) turns
that on in three phases, cheapest first — the dead-man's switch alone takes a
host from no coverage to "someone learns within 20 minutes", for no memory and
no account beyond a free heartbeat check.

`ops/bootstrap-host.sh` runs this for you on a fresh host, along with creating
a swapfile — the two things that make an oversubscribed box fail gracefully
rather than by OOM kill. `--no-monitoring` and `--no-swap` opt out.

```bash
ops/install-monitoring.sh              # timers, log caps, journald caps (a host bootstrapped earlier)
ops/install-monitoring.sh --with-alloy # once Grafana Cloud credentials exist
ops/status.sh --prom                   # what the collector reads
ops/status.sh --json                   # the same facts, for a script
ops/status.sh --quiet                  # exit status only, for a timer
```

## Hardening

The containers are narrow already; `ops/harden-host.sh` narrows the box they share.
`bootstrap-host.sh` runs it last (`--no-harden` opts out), and it is safe to run again.

```bash
ops/harden-host.sh --no-apply          # change nothing: print the files and the commands
ops/harden-host.sh                     # sshd keys-only, security upgrades, ufw, sysctl
ops/harden-host.sh --ssh-users "amit"  # also restrict SSH to named accounts
ops/harden-host.sh --audit             # Lynis; publishes webamend_host_hardening_index
```

- **sshd**: password sign-in off, in a drop-in named `00-…` because sshd keeps the first
  value it reads and cloud images ship a `50-cloud-init.conf` that says yes. Root sign-in is
  turned off only when an account in the `sudo` group has an `authorized_keys` file;
  otherwise root keeps key sign-in and the script says so. No key on any account: it refuses.
- **Upgrades**: `unattended-upgrades` daily, and a reboot at 04:00 host time when a kernel
  needs one (`--reboot-time`, `--no-auto-reboot`). A reboot interrupts a running request,
  which the app rebuilds from its pull request. Docker's own packages are not auto-upgraded.
- **Firewall**: ufw denies incoming except sshd's configured port, 80 and 443. Client ports
  need no rule: they are loopback-only.
- **sysctl**: dev-sec.io's `os_hardening` baseline, minus the four settings that break
  Docker, rootless mode, provider IPv6, or the journal budget. The file says which.
- **`--audit`** changes nothing. The index lands in the collector's textfile directory; the
  suggestions it prints are the next things worth doing.

## The scripts

| Script                                         | Run as | When                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap-host.sh`                            | root   | Once per VPS. Docker, the rootless prerequisites, `/srv/webamend`, the registry, a Compose ≥ 2.17 check.                                                                                                                                        |
| `provision-client.sh <slug> <hostname> <port>` | root   | Once per client. The user, its rootless daemon, the 0700 tree, a `.env` skeleton. Starts nothing.                                                                                                                                           |
| `release.sh [git-ref]`                         | root   | Every deploy. Builds and pushes both images, then rolls each client forward one at a time. `--client <slug>` for one.                                                                                                                       |
| `status.sh [<slug>]`                           | root   | Any time. One line per client, plus the host-wide agent total. `--logs` to see why one is unhappy.                                                                                                                                          |
| `set-env.sh NAME VALUE`                        | root   | When one setting changes for every client (`SMTP_FROM`, say). Edits each `.env`, validates it, and recreates the app one client at a time; a file that fails validation is restored and its container left alone. `--secret NAME` prompts with echo off, `--unset NAME` removes, `--client <slug>` for one, `--dry-run` to look first, `--no-recreate` to defer, `--check` to ask Compose whether every `.env` parses. |
| `launch-client.sh <slug> <hostname> [port]`    | root   | The four steps above for one new client, in order, with the hand steps between them: opens `.env` in an editor, mints the secrets, runs `check:env`, waits for DNS, adds the Caddy block, checks HTTPS. Re-run after a failure; it resumes. |

| `harden-host.sh`                               | root   | Once per host, and after adding an administrator. sshd, upgrades, firewall, sysctl. `--audit` measures. See Hardening above.                                                                                                              |
| `migrate-to-webamend.sh`                       | root   | Once, on a host provisioned before the product was renamed. Moves `/opt/prosel` and `/srv/lexi`, renames the `lexi-slots` group in place, reinstalls the daemon unit, the probe timers, the log wrapper and, where it is installed, Alloy's config and unit drop-in, and rewrites each client's `.env`. `--release` finishes by rolling every client onto the new image name. |

All four are idempotent. All four refuse rather than guess.

The rename script is idempotent too, and a host installed after the rename needs it
never: it exits without touching anything when there is nothing named `lexi` left.

Order: `bootstrap-host.sh` → `provision-client.sh` → fill in `.env` by hand → `release.sh`.
Or, for one client end to end: `bootstrap-host.sh` once, then `launch-client.sh` per client.

`provision-client.sh` deliberately mints no secrets and starts no stack. Secrets come from
`npm run gen:secrets`, appended to the client's `.env` by a person; a stack started before its
`.env` was filled in would only fail startup validation in a way that reads like a bug.

## From a fresh Ubuntu 24.04 VPS to one client serving traffic

```bash
# --- once per host, as root -------------------------------------------------
apt-get update && apt-get install -y git curl
mkdir -p /opt/webamend && git clone <this repository> /opt/webamend/src
cd /opt/webamend/src
ops/bootstrap-host.sh

apt-get install -y caddy          # or your proxy of choice

# --- once per client --------------------------------------------------------
ops/provision-client.sh acme edit.acme.example 3001

# Fill in the GitHub App, Netlify, OpenRouter, SMTP and ALLOWED_EMAILS values:
sudoedit /srv/webamend/acme/.env

# Mint the three secrets and append them AS the client user, so the file stays
# 0600 and no value is ever echoed to your terminal. The toolchain runs in a
# throwaway copy of the checkout so the host needs no Node installed, and so
# that /opt/webamend/src stays a clean build source.
docker run --rm -v /opt/webamend/src:/src:ro -w /build node:22-slim \
  sh -c 'cp -a /src/. /build && npm ci --silent \
         && npm run --silent gen:secrets' \
  | sudo -u acme tee -a /srv/webamend/acme/.env >/dev/null

# Later, once the stack is up: mint the client's enrollment link and send it
# to them. It shows the authenticator QR once and works for 24 hours. The
# secret itself is never printed.
docker run --rm -v /opt/webamend/src:/src:ro -v /srv/webamend/acme/.env:/secret/.env:ro -w /build node:22-slim \
  sh -c 'cp -a /src/. /build && cp /secret/.env /build/.env && npm ci --silent && npm run --silent enroll:link'

# Confirm it parses. It prints variable names and never values:
docker run --rm -v /opt/webamend/src:/src:ro -v /srv/webamend/acme/.env:/secret/.env:ro \
  -w /build node:22-slim \
  sh -c 'cp -a /src/. /build && cp /secret/.env /build/.env \
         && npm ci --silent && npm run --silent check:env'

# --- build and roll ---------------------------------------------------------
ops/release.sh --client acme

# --- hostname and TLS -------------------------------------------------------
# First, at the DNS provider: an A record for edit.acme.example -> this VPS's
# public IP (and AAAA for IPv6). Caddy cannot issue a certificate until it resolves.
cat >>/etc/caddy/Caddyfile <<'CADDY'
edit.acme.example {
    reverse_proxy 127.0.0.1:3001
}
CADDY
systemctl reload caddy
# The firewall already admits 80 and 443: bootstrap-host.sh ran harden-host.sh.

ops/status.sh
```

The second client is the last three blocks again with a new slug, hostname and port. Deploying
new code to all of them afterwards is one command: `ops/release.sh`.

## The two things not to get wrong

### 1. `state/` must stay 0700

`WEBAGENT_STATE_DIR` holds a full git checkout of the client's repository, one per running
request. The application makes each of those working trees **world-writable**, because the agent
container runs as a mapped subordinate UID that is nobody the host has heard of. That is
deliberate and it is not the hole — the hole would be a parent directory anyone can traverse.
The `0700` on `/srv/webamend/<slug>/` and on `state/` is the containment. Never relax it "so the
agent can write": the agent reaches its tree through a bind mount, which the daemon resolves
once, as `<slug>`, so the container process never traverses the parent at all.

`provision-client.sh` re-applies both modes on every run. If you change them by hand, re-run it
with `--force`.

### 2. The host admits agents through one queue

Each installation serves one site, and its site lock bounds it to one run at a time. Across
installations, `webamend-slotd` (`ops/slotd/`) decides how many agents run at once: a capacity
computed from the host's RAM and CPUs, a live check of available memory before every grant,
FIFO order, and a lease that lasts exactly as long as the app's connection to it. Design and
measurements: `docs/superpowers/specs/2026-09-14-host-admission-queue-design.md`.

`ops/bootstrap-host.sh` installs it; `ops/provision-client.sh` enrols each client in the
`webamend-slots` group (the daemon's authorization list and its client count) and writes
`SLOT_BROKER_SOCKET` into the client's `.env`. Remove that line and the installation runs
without the queue, exactly as before — the app fails open if the daemon is unreachable.

Tune it in `/etc/webamend/slots.env` (`ops/slotd/slots.env.example` explains every number), then
`systemctl reload webamend-slotd`. Read it with `python3 ops/slotd/webamend_slotd.py status`, in the
`SLOTS` line of `ops/status.sh`, and as `webamend_slots_*` in monitoring.

Budget roughly **400 MB of RAM per running agent** (measured 2026-09-14), on top of one app
container (~160 MB) per client. On a 3.8 GB, 2 vCPU host that is a capacity of 4, whatever the
client count; the rest queue.

To see it work without a host: `npm run stress:slotd` starts the daemon on your Mac with eight
fake clients that allocate real memory, inside a budget of a quarter of your RAM by default.

The per-client `MAX_CONCURRENT_RUNS` setting that used to live here was removed on 2026-09-15:
counted on a per-client daemon and sitting above a lock that already allows one, it never
bound anything.

## Notes

- **Image delivery.** `release.sh` pushes to the loopback registry and then tries `docker pull`
  as each client. A rootless daemon runs in its own network namespace with host-loopback access
  disabled by default, so that pull may not reach `127.0.0.1:5000`; when it does not, the script
  transfers the image with `docker save | docker load` and says so. Either path ends with the
  identical image reference on the client's daemon, so nothing downstream has to know which ran.
  The registry earns its place regardless: the image is built once and stored once.
- **`PORT` must never appear in a client `.env`.** That file is both interpolated by Compose and
  passed into the container, where Next reads `PORT` as its listen port — set it there and the
  published mapping stops matching. Use `PORT_HOST`, which `provision-client.sh` fills in.
- **Backups.** Each client's `.env`, which holds the authenticator secret. That is the entire list; `state/` is a
  cache that rebuilds itself, and everything else lives in GitHub and Netlify.
- **A client's daemon after a reboot.** `loginctl enable-linger` plus `systemctl --user enable
docker` is what brings it back with nobody logged in. `provision-client.sh` does both; if a
  client is `daemon: down` in `status.sh` after a reboot, that pair is what to check.
