# Monitoring a Webamend host

What this host reports about itself, how to turn it on, and in what order.

The order matters more than the tooling. Each phase is useful on its own, and
the first one is worth more per minute spent than everything after it.

---

## Phase 1 — the dead-man's switch (15 minutes, no memory, $0)

Takes this host from *no coverage* to *someone learns within 20 minutes if it
dies*. Do this even if you do nothing else.

1. Create a check at a heartbeat service (healthchecks.io free, or similar):
   period **15 minutes**, grace **15 minutes**. Copy its ping URL.
2. On the host, as root. `ops/bootstrap-host.sh` already runs the installer on
   a fresh host, so on one of those only the last two lines are needed:

   ```bash
   /opt/webamend/src/ops/install-monitoring.sh   # idempotent; skip if bootstrap ran it
   $EDITOR /etc/webamend/monitoring.env            # paste HEARTBEAT_URL
   systemctl restart webamend-probe.timer
   ```

3. Prove it: `systemctl stop webamend-probe.timer`, wait for the grace to expire,
   confirm the email arrives, then **`systemctl start webamend-probe.timer`**.
   **An alert never tested is an alert that does not exist.**

   The test only means something once `HEARTBEAT_URL` is filled in *and* the
   check has already received at least one ping — an empty URL makes `probe.sh`
   skip the ping entirely, so there is nothing to go silent. Only the 60-second
   run pings; `webamend-probe-full.timer` deliberately does not, so stopping the one
   timer is enough.

The ping is conditional — `ops/probe.sh` only pings when `ops/status.sh
--quiet` says every client is healthy. A timer that pings unconditionally
proves only that the timer runs.

## Phase 2 — metrics and logs (Grafana Cloud free tier)

1. Sign up. From Connections, take the Prometheus push URL and user id, the
   Loki push URL and user id, and one access policy token with `metrics:write`
   and `logs:write`.
2. Fill them into `/etc/webamend/monitoring.env`. Names only ever appear in
   output; no value is printed by any script here.
3. Install Alloy, then re-run the installer:

   ```bash
   # Grafana's install script, from their docs — pinned by your own package
   # manager, not by this file.
   /opt/webamend/src/ops/install-monitoring.sh --with-alloy
   ```

4. Confirm: `systemctl status alloy`, then look for `webamend_clients_total`
   in Grafana's metrics explorer.

## Phase 3 — alerts

`ops/monitoring/grafana/alert-rules.md` has every rule, its query, its window
and why it is in the tier it is. Enter tier A first; the digest can wait.

Add Synthetic Monitoring checks against `https://<client-host>/api/health` for
each client — that is the only check that sees DNS, Caddy and the certificate.

---

## What each piece reports

| Source | Gives you |
|---|---|
| `ops/status.sh --prom` → textfile | per-client app/daemon/health/readiness, agents running vs limit, **summed ceiling across clients**, image and commit, maintenance flag |
| `prometheus.exporter.unix` | CPU, memory, load, disk, filesystem, per-unit systemd state |
| container logs → Loki | every `request.ended`: outcome, errorCode, duration and per-stage durations, cost, tokens, files changed |
| journald → Loki | dockerd, sshd, each client's rootless daemon, and Caddy's *service* log. **Not** Caddy access logs: v2 writes those only where a site block carries a `log` directive, and the Caddyfile has none — so per-client HTTP status and latency are not collected today |
| heartbeat service | the one signal that survives the box being gone |

## Where to look

[ROLLOUT.md](ROLLOUT.md#where-to-look) has the full list with copy-paste
queries. The short version:

- **On the box, no accounts:** `cd /tmp && ops/status.sh` for fleet state,
  `ops/status.sh <slug> --logs` for one client's JSON log,
  `journalctl -u caddy` for the proxy's own service log (access logs are off
  — see the table above), and
  `/var/lib/node_exporter/textfile/webamend.prom` for what the collector reads.
- **Per request:** the durable record is a comment on the pull request in the
  client's repository — outcome, cost, tokens, per-stage timestamps, and the
  agent's last output lines, which exist nowhere else by design.
- **In Grafana:** Explore → Loki for `{job="webamend"}`, Explore → Prometheus for
  `webamend_*` and `node_*`, Alerting → Alert rules for what is firing.
- **Dashboards:** `monitoring/grafana/dashboard-health.json` (is it up, per
  client, right now) and `monitoring/grafana/dashboard-requests.json` (did the
  requests work, why were they slow, what did they cost). Push them from the
  repository, so the copy in Grafana never drifts from the one in git:

  ```bash
  GRAFANA_URL=https://<stack>.grafana.net GRAFANA_TOKEN=<service account token, Editor> \
    ops/monitoring/grafana/push-dashboards.sh --remove-old
  ```

  Re-run after any change to the JSON. `--remove-old` deletes the copies
  imported before the product was renamed, which nothing has fed since; the
  data before the rename is still in Loki under `{job="lexi"}` and in
  Prometheus as `lexi_*`, with `project="lexi"`. Upload by hand works too
  (Dashboards → New → Import → Upload JSON file), once. Add the prebuilt Node
  Exporter Full dashboard (ID `1860`) for the deep host view.

## The numbers a person should look at

- **Success ratio** per client over 24h — the one number that says "is this working".
- **Spend per client per day** — the aggregate the per-request ceiling cannot see.
- **Publish rate** — previews the client chose *not* to ship. The product-quality metric.
- **Undo count** — they published, then rejected it. Worse than a preview never published.
- **Memory available vs `webamend_slots_capacity × 400 MB`** (before the daemon is installed, `webamend_clients_total`) — what the host admits at once against what it has; this is how you find out the ceiling is wrong before the kernel decides.
- **`webamend_slots_queued` and `webamend_slots_refused_total`** — the admission queue's early warning. Queued for minutes means clients are waiting on each other; refused means one was told to come back later. Both say "more RAM or another host".

## Constraints worth knowing before you extend it

- **Label discipline.** Only `project`, `job`, `slug`, `unit`, `level`, `event`
  and `stream` may be labels. `project="webamend"` is stamped on every metric
  (`external_labels`) and every log line, so one Grafana Cloud stack — the free
  tier allows exactly one — can hold several projects without `node_*` metrics
  or journald logs from different hosts mixing together. `requestId`, `conversationNumber`, `commitSha` are unbounded
  and stay as JSON fields, which in Loki cost nothing at query time. One
  mistake here burns the free-tier series allowance in a day.
- **Agent output never leaves the box.** The container log glob matches agent
  containers too — raw model output over a client's private tree. `config.alloy`
  drops any line without an `event` field, which is what excludes it. Do not
  relax that filter.
- **`errorDetail` is not in `request.ended`** for the same reason. The durable
  record in the pull request keeps it, where the client controls access.
- **Alloy is capped** at `MemoryMax=200M` by a systemd drop-in. The summed agent
  ceiling across clients can exceed free memory by design, so the cap makes
  Alloy the process the kernel kills rather than Caddy or a client's app.
  `ops/bootstrap-host.sh` also creates a swapfile, which turns an overshoot into
  slowness instead of a kill — check `swapon --show` on an older host.
- **Secrets** live in `/etc/webamend/monitoring.env`, 0600 root — never in a client
  `.env`, because a client user can read their own and these tokens are
  host-wide authority.

## Honest gaps

- `costUsd` is **self-reported by the agent** into `/control/result.json` and
  defaults to 0 when absent. Nothing here can detect spend the agent
  under-reports. The ground truth is OpenRouter's own API; a monthly
  reconciliation is not yet built.
- `webamend_client_agents_running` is a poll, so a run finishing between two
  scrapes shows as a brief dip or spike rather than a fault. That is why A5
  carries a 15-minute window.
- Grafana Cloud's free allowances and retention change. Verify them against
  current published limits rather than against any number written here.
