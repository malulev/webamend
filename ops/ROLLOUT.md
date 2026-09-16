# Rollout: observability, step by step

Everything below is in the working tree and **nothing is deployed**. This is the
order to deploy it in, what to check after each step, and what breaks if you
skip one.

Steps 1–4 are worth doing on their own. Step 5 onwards needs accounts.

Replace `<host>` with the VPS address and `/opt/webamend/src` with your checkout
if it differs (the directory name predates the rename to Webamend).

---

## Step 0 — review and commit

```bash
git status
git diff --stat
npm run lint && npm run typecheck && npm test && npm run test:int
```

Expect all green: **1037 unit, 113 integration**. Then commit — `ops/release.sh`
warns on a dirty tree and tags images by git SHA, so an uncommitted rollout
produces an image whose tag does not identify what is in it.

---

## Step 1 — host prep (root, ~5 minutes)

None of this needs the new code. Do it first; it is the cheapest reliability
work in the whole plan.

**On a fresh host this is automatic** — `ops/bootstrap-host.sh` now creates the
swapfile and runs `ops/install-monitoring.sh` as part of preparing the box. An
existing host that was bootstrapped before that either re-runs it (idempotent,
though it briefly recreates the image registry container) or does this by hand:

```bash
ssh root@<host>

# Swap. Every client can run one agent at a time (~400 MB each, measured) and
# nothing in the product admits across clients, so the ceiling is the client
# count. With no swap the kernel resolves an overshoot by killing something,
# and it picks by size. Swap turns that into slowness. Optional: a stress test
# on 2026-09-14 recovered in a minute precisely because there was no swap to
# thrash through, and the lease daemon (see the admission-queue design) is the
# real fix; add swap only if you would rather have slow than killed meanwhile.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Cap the host daemon's container logs. Uncapped by default, on a filesystem
# shared with /srv/webamend and every client's image store.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker
```

**Verify:**

```bash
free -m          # the Swap row is no longer 0
swapon --show    # /swapfile, 2G
df -h /          # note the figure, to compare after a week
```

> Each **client's rootless daemon** has its own config and is not covered by
> `/etc/docker/daemon.json`. Their app containers are capped by the `logging:`
> block in `docker-compose.yml`, which arrives in step 2.

> `install-monitoring.sh` will **not** overwrite an existing
> `/etc/docker/daemon.json`. If you already had one, confirm yourself that it
> sets `log-opts`.

---

## Step 2 — deploy the code (root)

```bash
cd /opt/webamend/src && git pull
ops/release.sh
```

This is the release that starts enforcing things, so read what it now does
differently:

| New behaviour                                                         | Consequence                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Agent containers capped at 1 GiB, `MemorySwap` equal, `PidsLimit` 512 | A runaway agent dies alone instead of triggering the OOM killer                       |
| `mem_limit: 512m` and log rotation on the app service                 | Per-client log ceiling of 30 MB                                                       |
| Compose `healthcheck:` against `/api/health`                          | `docker ps` shows real health                                                         |
| Waits for `/api/health` **and** `/api/ready`                          | A release that starts but cannot reach GitHub now fails instead of passing            |
| **Rolls back on failure**                                             | A failed client returns to its previous image and reports `ROLLED-BACK`, not `FAILED` |
| Writes `APP_SHA` per client                                           | Version drift is visible from outside the box                                         |
| Holds `/var/lib/webamend/maintenance` while rolling                       | Alerts stay quiet during deploys                                                      |

**Verify:**

```bash
cd /tmp && /opt/webamend/src/ops/status.sh
```

Expect every client `up / running / :PORT ok / ready`, and the IMAGE column
carrying the new SHA. The `READY` column is new.

> Run `status.sh` from `/tmp`, not `/root`. It now passes `env -C /` so the
> old "APP absent" misreport is fixed, but the habit costs nothing.

**If a client comes back `ROLLED-BACK`:** it is still serving its previous
version — not down. Find out why before re-running:

```bash
curl -s 127.0.0.1:<PORT>/api/ready     # names the setting at fault
ops/status.sh <slug> --logs
```

Use `ops/release.sh --no-rollback` only when you want the broken container left
in place to inspect.

---

## Step 3 — check the new endpoints

```bash
# Liveness: no I/O, answers even when GitHub is down
curl -s 127.0.0.1:<PORT>/api/health
# {"status":"ok","sha":"<short sha>"}

# Readiness: re-runs the four startup probes, cached
curl -s 127.0.0.1:<PORT>/api/ready
# {"status":"ready","checkedAt":"...","ageMs":...}
```

Confirm the cache is working — the second call should return a larger `ageMs`
without a pause, rather than making fresh calls to GitHub:

```bash
curl -s 127.0.0.1:<PORT>/api/ready; sleep 2; curl -s 127.0.0.1:<PORT>/api/ready
```

And confirm the structured logs are flowing:

```bash
cd /tmp && ops/status.sh <slug> --logs --tail 20
```

Lines should now be single-line JSON with `ts`, `level` and `event`. Send one
change request through the editor and look for `request.ended` carrying
`outcome`, `costUsd`, `durationMs` and the per-stage durations.

---

## Step 4 — the dead-man's switch (~15 minutes, no accounts beyond a free check)

**The highest value per minute in this whole document.** It takes the host from
no coverage to "someone learns within 20 minutes if it dies" — and it is the
only monitor that can fire when the box, the network or the collector is gone,
because silence is its signal.

1. Create a check at a heartbeat service (healthchecks.io free tier, or
   similar). Period **15 minutes**, grace **15 minutes**. Copy the ping URL.

2. On the host, as root:

   ```bash
   /opt/webamend/src/ops/install-monitoring.sh
   ```

   It writes `/etc/webamend/monitoring.env` (0600 root), creates
   `/var/lib/node_exporter/textfile`, installs and starts the two probe timers,
   and caps journald. It prints variable **names** only — never values.

3. Paste the ping URL:

   ```bash
   $EDITOR /etc/webamend/monitoring.env      # HEARTBEAT_URL=...
   systemctl restart webamend-probe.timer
   ```

**Verify:**

```bash
systemctl list-timers 'webamend-*'            # both timers scheduled
systemctl start webamend-probe.service        # run one collection now
cat /var/lib/node_exporter/textfile/webamend.prom | head -20
```

You should see `webamend_client_app_up`, `webamend_client_ready_ok`, and
`webamend_clients_total` — the host's agent ceiling (each client can run one at a
time), which nothing in the product can see.

**Then prove the alert actually fires:**

```bash
systemctl stop webamend-probe.timer
# wait out the grace period; confirm the email arrives
systemctl start webamend-probe.timer      # do not forget this
```

Only the 60-second run pings — `webamend-probe-full.timer` deliberately does not,
so stopping this one timer is enough to make the check go red. And the test
proves nothing until `HEARTBEAT_URL` is set and the check has had at least one
successful ping: with an empty URL `probe.sh` never pings, so there is no
signal to lose.

An alert you have never seen fire is not an alert.

> The ping is **conditional** — `ops/probe.sh` only pings when
> `ops/status.sh --quiet` says every client is healthy. A timer that pings
> unconditionally proves only that the timer runs.

---

## Step 5 — Grafana Cloud (accounts required)

1. Sign up for the free tier. From **Connections**, collect:
   - the Prometheus push URL and its numeric user id
   - the Loki push URL and its numeric user id
   - one access policy token with `metrics:write` and `logs:write`

2. Put them in `/etc/webamend/monitoring.env`. That file is 0600 root and never a
   client `.env` — a client user can read their own, and these tokens are
   host-wide authority over the whole fleet's telemetry.

3. Install Alloy per Grafana's current instructions for Ubuntu 24.04.

4. **Validate the config before enabling it** — this is the one artifact that
   was never executed during development, because `alloy` is not installed on
   this box:

   ```bash
   alloy fmt /opt/webamend/src/ops/monitoring/alloy/config.alloy
   alloy validate /opt/webamend/src/ops/monitoring/alloy/config.alloy
   ```

   Fix anything it reports before continuing. The blocks most likely to need
   adjusting for your Alloy version are `discovery.relabel`, `stage.drop` and
   `loki.relabel`.

5. Then:

   ```bash
   /opt/webamend/src/ops/install-monitoring.sh --with-alloy
   ```

   It installs the config and a systemd drop-in capping Alloy at
   `MemoryMax=200M` — deliberate, so that on a box whose agent ceiling already
   exceeds free memory, Alloy is what the kernel kills rather than Caddy.

**Verify:**

```bash
systemctl status alloy
journalctl -u alloy -n 30 --no-pager
systemctl show alloy -p MemoryCurrent      # should stay well under 200M
```

In Grafana, query `webamend_clients_total` and
`{job="webamend"} | json | event="request.ended"`.

**Before you consider this step done, confirm no agent output is reaching
Loki.** The container-log glob matches agent containers too — raw model output
taken over a client's private tree. The `stage.drop` block is what excludes it:

```
{job="webamend"} | json | event=""
```

That query must return nothing.

---

## Step 6 — alerts

`ops/monitoring/grafana/alert-rules.md` has every rule with its query, window
and the reason it sits in its tier. Enter tier A first; the digest can wait a
week.

Two rules need something outside Grafana's metrics:

- **A2, outside-in probe.** Add a Synthetic Monitoring HTTP check against
  `https://<client-host>/api/health` for each client. This is the only check
  that sees DNS, Caddy and the certificate — everything else runs on the box
  and cannot tell you the box is unreachable.
- **A3, dead-man.** Already done in step 4.

**Every tier-A rule must carry `unless webamend_maintenance == 1`.** Without it,
`ops/release.sh` pages you on every deploy, and an alert system that cries
during normal work gets muted — which looks like coverage without being any.

**Then fire each one deliberately, once:**

| Rule               | How to trigger it safely                                                  |
| ------------------ | ------------------------------------------------------------------------- |
| A1 client down     | stop one client's app container, wait 3 min, start it                     |
| A4 disk            | `fallocate` a large file on a scratch path, then delete it                |
| A5b memory         | check the threshold against `free -m` rather than actually exhausting RAM |
| A7 startup refusal | break `NETLIFY_SITE_ID` in a scratch installation only                    |
| A13 readiness      | same scratch installation                                                 |

Never test A7 or A13 against a live client.

---

## Where to look

Three places, in increasing order of setup required. The first works today and
keeps working when the other two are down.

### 1. On the box — no accounts, nothing installed

| What                                 | Where                                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| Fleet state, one row per client      | `cd /tmp && ops/status.sh`                                 |
| Same, machine-readable               | `ops/status.sh --json` · `ops/status.sh --prom`            |
| One client's application log         | `ops/status.sh <slug> --logs --tail 200`                   |
| Raw container logs on disk           | `/home/<slug>/.local/share/docker/containers/*/*-json.log` |
| Caddy, dockerd, sshd                 | `journalctl -u caddy -n 100` · `journalctl -u docker`      |
| A client's rootless daemon           | `journalctl --user-unit docker -M <slug>@`                 |
| The metrics file the collector reads | `/var/lib/node_exporter/textfile/webamend.prom`                |
| Is a release in progress             | `ls /var/lib/webamend/maintenance`                             |

The application log is JSON, one object per line. Read it with `grep`, or more
comfortably:

```bash
ops/status.sh imidan --logs --tail 200 | grep request.ended
```

**And the one people forget:** every request's durable record is a **comment on
the pull request** in the client's own repository — outcome, error code, cost,
tokens, files changed, per-stage timestamps, the agent's last output lines. It
is the only place `errorDetail` exists, deliberately, because that is untrusted
model output over a client's private tree and it never leaves the box. When you
need to know what actually happened in one specific request, open the PR.

### 2. Grafana Cloud — after step 5

Everything lives under **Explore** (the compass icon), where you pick a data
source at the top left.

**Logs — pick your Loki data source**, then paste:

```logql
{job="webamend"}                                        # everything, all clients
{job="webamend", slug="imidan"}                         # one client
{job="webamend", level="error"}                         # only what went wrong
{job="webamend", event="request.ended"} | json          # every finished request
{job="webamend", event="request.ended"} | json | outcome="failed"
{job="webamend", event="slot.waited"} | json            # capacity pressure
{job="webamend-host", unit="caddy.service"}             # HTTP access logs
```

Click any line to expand the parsed fields — `costUsd`, `durationMs`,
`runningMs`, `buildingMs`, `errorCode` are all there.

**Metrics — pick your Prometheus data source**, then:

```promql
webamend_client_app_up                                  # 1 or 0 per client
webamend_client_ready_ok                                # credentials still valid
webamend_clients_total                                  # agent ceiling: one per client
node_memory_MemAvailable_bytes{project="webamend"}      # against the line above
node_filesystem_avail_bytes{project="webamend",mountpoint="/"}
webamend_client_info                                    # deployed image and commit
```

**Alerting → Alert rules** shows what is firing and the history of what has
fired. That history is worth reading monthly: a rule that fires often and is
never acted on belongs in the digest, not in your inbox.

### 3. A dashboard — about ten minutes to build

Two dashboards ship in `ops/monitoring/grafana/`, pushed with
`push-dashboards.sh` (see [MONITORING.md](MONITORING.md#where-to-look)). The
panels below are what they contain, one query each — the list is here for
building the same view somewhere the JSON cannot be imported.

| Panel                    | Type                      | Query                                                                                                        |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Clients up               | Stat                      | `webamend_client_app_up`                                                                                         |
| Credentials valid        | Stat                      | `webamend_client_ready_ok`                                                                                       |
| Memory headroom          | Time series, two series   | `node_memory_MemAvailable_bytes` and `webamend_clients_total * 419430400` (every client running one agent at the measured ~400 MB each)                                    |
| Disk free                | Gauge                     | `node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}`                   |
| Requests by outcome      | Bar chart                 | `sum by (outcome) (count_over_time({job="webamend", event="request.ended"} \| json [1d]))`                       |
| Failures by cause        | Table                     | `sum by (errorCode) (count_over_time({job="webamend", event="request.ended"} \| json \| outcome="failed" [7d]))` |
| Duration p95             | Time series               | `quantile_over_time(0.95, {job="webamend", event="request.ended"} \| json \| unwrap durationMs [1h])`            |
| Where the time goes      | Time series, three series | same, unwrapping `runningMs`, `buildingMs`, `preparingMs`                                                    |
| Spend per client per day | Bar chart                 | `sum by (slug) (sum_over_time({job="webamend", event="request.ended"} \| json \| unwrap costUsd [1d]))`          |
| Queue wait p90           | Time series               | `quantile_over_time(0.9, {job="webamend", event="slot.waited"} \| json \| unwrap waitedMs [1d])`                 |
| Undos                    | Stat                      | `count_over_time({job="webamend", event="publication.ended"} \| json \| kind="undo" [7d])`                       |

Put **memory headroom** and **spend per client** at the top. They are the two
that tell you something before a client does: the first is this box's actual
constraint, and the second is the one the per-request cost ceiling structurally
cannot see.

Grafana Cloud also ships a prebuilt **Node Exporter Full** dashboard
(Dashboards → New → Import → ID `1860`) which covers CPU, memory, disk and
network with no work at all. Import it for the host view and keep your own
dashboard for the Webamend-specific panels above.

## If something goes wrong

| Symptom                              | What to do                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| A client is `ROLLED-BACK`            | It is serving its old version. `curl 127.0.0.1:<PORT>/api/ready` names the faulty setting.                                      |
| A client is `FAILED`                 | The rollback failed too — that client is down. `ops/status.sh <slug> --logs`.                                                   |
| Alerts firing during every deploy    | The `unless webamend_maintenance == 1` clause is missing from a rule.                                                               |
| Alerts silent after a crashed deploy | `rm -f /var/lib/webamend/maintenance` — the trap should clear it, but check.                                                        |
| Alloy eating memory                  | The drop-in caps it at 200M. If it is being killed repeatedly, reduce what `config.alloy` collects rather than raising the cap. |
| Free-tier data stops arriving        | You are probably at the cap. Drop `debug`-level logs first; keep `request.ended` always.                                        |

**To undo the code entirely:** `git revert` the rollout commit and run
`ops/release.sh`. Nothing here changes any persistent data format — the record
schema, the lock and the conversation-as-PR model are untouched.

---

## Known gaps — be aware, not surprised

- **`costUsd` is self-reported by the agent** into `/control/result.json` and
  defaults to 0 when absent. No alert here can catch spend the agent
  under-reports. The ground truth is OpenRouter's own API; a monthly
  reconciliation is not built.
- **`webamend_client_agents_running` is a poll**, and `slots.ts` documents its own
  check-then-act race — a momentary count above the limit is expected
  behaviour, which is why rule A5 carries a 15-minute window.
- **Grafana Cloud's free allowances and retention change.** Verify them against
  current published limits, not against any number written down here.
- **Grafana Cloud email comes from Grafana's sender**, not your SMTP. Your
  `SMTP_URL` still carries alerts the application itself raises, via
  `src/lib/notify/operator.ts`. The two paths fail independently, which is the
  point.
