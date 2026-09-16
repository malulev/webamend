# Alert rules

Queries, thresholds and the reason each one sits in the tier it does. Entered
in Grafana Cloud (Alerting → Alert rules), or pushed through its provisioning
API — they are written here as queries rather than as a provisioning YAML
because that file's shape is tied to a Grafana version, and a config that
cannot be imported verbatim is worse than a query you can paste.

`{job="webamend"}` selects the application logs; `slug` is the client.

**Every tier-A rule carries `unless webamend_maintenance == 1`.** `ops/release.sh`
touches `/var/lib/webamend/maintenance` while it rolls, and without that clause a
deploy pages you — which is how alert systems get muted, and a muted rule is
worse than no rule because it looks like coverage.

---

## The minimum set — start here

Five rules. Everything below this section is the full catalogue; enter it later,
or never. These five are chosen for one property: **the dead-man's switch
cannot raise any of them.**

The heartbeat already says "the box is alive and every client is healthy". It
says it in one bit, with no client identity, and it stays green while the app
serves 200 to a client whose every request is failing. That is the gap these
close.

| # | Rule | Query | For | The failure it catches |
|---|---|---|---|---|
| M1 | Which client is down | `webamend_client_health_ok == 0 unless on() webamend_maintenance == 1` | 5m | Turns a red heartbeat into a client name. Without it you SSH in to find out who. |
| M2 | Credential expired | `webamend_client_ready_ok == 0 unless on() webamend_maintenance == 1` | 15m | GitHub or Netlify stopped answering. `startup.ts` runs once at boot, so nothing else notices until a client's request fails. |
| M3 | **Requests failing** | `sum by (slug) (count_over_time({job="webamend", event="request.ended"} \| json \| outcome="failed" [15m])) >= 3` | 0m | App up, health 200, heartbeat green, **every request failing**. This happened on 2026-09-14 on a `:free` model and nothing could report it. M1, M2 and M4 all stay green throughout. |
| M4a | RAM | `node_memory_MemAvailable_bytes{project="webamend"} < 400e6` | 5m | No swap on this box: this is an OOM countdown, and the kill can just as easily take Caddy as an agent. |
| M4b | Disk | `1 - node_filesystem_avail_bytes{project="webamend", mountpoint="/"} / node_filesystem_size_bytes{project="webamend", mountpoint="/"} > 0.85` | 10m | Shared by every client. A full disk corrupts a git mirror mid-clone and no restart fixes it. |
| M5 | Runaway spend | `sum by (slug) (sum_over_time({job="webamend", event="request.ended"} \| json \| unwrap costUsd [1d])) > 5` | 0m | Ten requests at 90% of the per-request ceiling cost 9x the ceiling and raise nothing today. |

M3 is the one to enter first if you only enter one.

Add next, when there is a spare ten minutes: A6 (lock leak — a silent total
outage for one client behind a healthy-looking app) and A12 (auth burst).

### Contact point

One email contact point, all five rules. Grafana Cloud sends from its own
infrastructure, not from `SMTP_URL` — see the delivery note at the foot of this
file. Put `{{ $labels.slug }}` in every summary; a rule that cannot name the
client is only marginally better than the heartbeat.

### Dashboards

Two, both in this directory, importable as-is (Dashboards -> New -> Import ->
Upload JSON file, then pick the Prometheus and Loki data sources when prompted):

- `dashboard-health.json` — is it up, per client, right now; plus RAM against
  the summed agent ceiling, disk, load, agent containers against their limit,
  deployed sha per client, and a live error log.
- `dashboard-requests.json` — failure ratio, outcome mix, the `errorCode`
  breakdown, duration p50/p95, the per-stage split that answers "why was that
  slow", spend, slot wait, publish vs undo, and the failure lines with their
  reasons.

---

## Tier A — interrupt me

| # | Rule | Query | For | Why this tier |
|---|---|---|---|---|
| A1 | Client app down | `webamend_client_health_ok == 0` | 3m | A client typing into a dead editor gets nothing. 3m tolerates a normal roll. |
| A2 | Outside-in down | Synthetic Monitoring HTTP check on `https://<host>/api/health` | 3m | A1 cannot see DNS, Caddy or the certificate. This is the only rule that tests what the client actually experiences. |
| A3 | Dead-man missed | the heartbeat service's own alert, period 15m, grace 15m | — | Fires when the box, the network or Alloy is gone — i.e. when no other rule *can* fire. |
| A4 | Disk critical | `node_filesystem_avail_bytes{project="webamend",mountpoint="/"} / node_filesystem_size_bytes{project="webamend",mountpoint="/"} < 0.10` | 10m | The filesystem is shared by every client. A full disk corrupts git mirrors mid-clone and is not fixed by a restart. |
| A4b | Disk trending full | `predict_linear(node_filesystem_avail_bytes{project="webamend",mountpoint="/"}[6h], 4*3600) < 0` | 30m | Catches the log or mirror that is growing steadily, while there is still time. |
| A5 | RAM vs agent ceiling | `node_memory_MemAvailable_bytes{project="webamend"} < (webamend_slots_capacity or webamend_clients_total) * 419430400` | 15m | The demand line is what the host admits at once (`webamend_slots_capacity`) times the measured ~400 MB per agent; before the daemon is installed it falls back to the client count, since each client can run one. `for: 15m` so a run finishing does not page. |
| A5b | RAM hard floor | `node_memory_MemAvailable_bytes{project="webamend"} < 300e6` | 5m | The immediate form of A5. No swap on this box: this is an OOM countdown. |
| A5c | Queue never drains | `webamend_slots_queued > 0` | 10m | Capacity pressure: demand exceeds what the host admits for ten straight minutes. Add RAM or another host; or the estimates in /etc/webamend/slots.env are too conservative. |
| A5d | Requests turned away | `increase(webamend_slots_refused_total{reason="projected_wait_exceeds_ceiling"}[1h]) > 0` | instant | A client was told "busy" because the projected wait exceeded 15 minutes. The host is under-sized for its clients; A5c will already be firing. |
| A5e | Admission daemon down | `webamend_slots_up == 0` | 5m | The app falls back to no host cap; protection is gone until the daemon answers. `systemctl status webamend-slotd`. |
| A6 | Lock leak | `count_over_time({job="webamend", event="request.lock_leak"}[10m]) > 0` | instant | That client accepts no further request until the lock goes stale. Total outage of the core function behind a healthy-looking app. |
| A6b | Started, never ended | `sum(count_over_time({job="webamend", event="request.started"}[1h])) - sum(count_over_time({job="webamend", event="request.ended"}[1h])) > 1` | 30m | Catches a process that died before it could log A6. Imprecise by construction; the long window is the mitigation. |
| A7 | Startup refusal loop | `count_over_time({job="webamend", event="startup.refused"}[15m]) >= 3` | instant | `process.exit(1)` plus `restart: unless-stopped` is an infinite loop that looks like "app down" but has a one-line fix. **Put `faultSettings` in the subject.** |
| A8 | Slot counting broken | `count_over_time({job="webamend", event="slots.count_failed"}[15m]) > 0` | instant | The cap has silently stopped existing — the precondition for A5 ten minutes later. Catching the cause beats catching the symptom. |
| A9 | TLS expiring | `probe_ssl_earliest_cert_expiry - time() < 7*86400` | 1h | Caddy renews at 30 days. Under 7 means renewal has been failing for three weeks. |
| A10 | Runaway spend | `sum by (slug) (sum_over_time({job="webamend", event="request.ended"} | json | unwrap costUsd [1d])) > 10 * <costCeilingUsd>` | instant | Ten requests at 90% of the per-request ceiling. A 10× day is a loop or a bug, not a busy day. |
| A11 | Client refused outright | `count_over_time({job="webamend", event="request.ended"} | json | errorCode="too_busy" [15m]) > 0` | instant | A client asked and was turned away by capacity. The visible face of A5. |
| A12 | Auth burst | `count_over_time({job="webamend", event="auth.refused"}[10m]) > 50` | instant | Credential stuffing against the six-digit code. |
| A13 | Readiness degraded | `webamend_client_ready_ok == 0` | 10m | The app serves but cannot reach GitHub or Netlify — an expired credential, invisible until now. |
| A14 | Provider limit | `count_over_time({job="webamend", event="request.ended"} \| json \| errorCode=~"model_quota\|model_credit\|hosting_limit" [15m]) > 0` | instant | The model quota, the model account, or the hosting plan is out. Every request on that client ends the same way until a person tops something up. The client is told so and `alertContact` is mailed, but SMTP is not monitoring. `provider.failed` carries the provider's own sentence; `request.failed` carries a stack for anything still landing in `internal_error`. |

## Tier B — daily digest, one email

| # | What | Query |
|---|---|---|
| B1 | Spend per client per day | `sum by (slug) (sum_over_time({job="webamend", event="request.ended"} | json | unwrap costUsd [1d]))` |
| B2 | Outcome mix | `sum by (slug, outcome, errorCode) (count_over_time({job="webamend", event="request.ended"} | json [1d]))` |
| B3 | Duration p50/p95 | `quantile_over_time(0.95, {job="webamend", event="request.ended"} | json | unwrap durationMs [1d]) by (slug)` |
| B4 | Where the time went | same, unwrapping `runningMs`, `buildingMs`, `preparingMs` |
| B5 | Queue pressure | `quantile_over_time(0.9, {job="webamend", event="slot.waited"} | json | unwrap waitedMs [1d])` |
| B6 | Publish rate | `count(… event="publication.ended" … kind="publish")` ÷ `count(… outcome="succeeded" … hasPreview=true)` |
| B7 | Undo count | `count_over_time({job="webamend", event="publication.ended"} | json | kind="undo" [1d])` |
| B8 | Version drift | `count(count by (sha) (webamend_client_info)) > 1` sustained 24h |
| B9 | Disk at 75% + per-client bytes | `webamend_client_state_bytes` |
| B10 | Notification failures | `count_over_time({job="webamend", event="notify.failed"}[1d])` |
| B11 | Stale locks broken | `count_over_time({job="webamend", event="lock.broken_stale"}[1d])` |
| B12 | Alloy self | RSS, dropped samples, active series against the free-tier cap |

B12 is not housekeeping: at the cap Grafana **drops data**, and quiet looks
exactly like "nothing is happening". You want to learn you are approaching it
before the graphs go silent.

## Recording rules

Tier-A alerts on log-derived data should run against recorded series, not
against a raw log scan — cheaper, faster, and retained far longer.

```
webamend:requests:count1d{slug,outcome}
webamend:request_cost_usd:sum1d{slug}
webamend:request_duration_seconds:p90_1h{slug}
webamend:slot_wait_seconds:p90_1d{slug}
```
