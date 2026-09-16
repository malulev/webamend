# Host-wide admission queue for agent runs

**Status:** approved for implementation, 2026-09-15
**Supersedes:** the per-client `MAX_CONCURRENT_RUNS` setting, removed 2026-09-15

## The requirement, in one sentence

Each client performs one change at a time. Several clients may perform changes
at the same time — as long as the host can start another agent container
without impairing the ones already running. Beyond that point, requests queue.

## The problem, as observed

A Webamend host runs one installation per client: one Linux user, one rootless
Docker daemon, one app container. Nothing coordinates agent runs *between*
those installations, and on 2026-09-14 a stress test on the production host
measured what that costs.

| Concurrent agents | Peak RAM used | Min available | Peak load (2 vCPU) | Memory PSI (full) | Outcome |
|---|---|---|---|---|---|
| 2 | 2168 MB | 1651 MB | 4.05 | 0.60 | healthy |
| 4 | 3195 MB | 624 MB | 4.05 | 1.26 | CPU-saturated, RAM tight |
| 8 | 3819 MB | **0 MB** | **115.00** | **87.65** | host unreachable |

At eight agents the box held 0 MB available for roughly fifteen seconds, load
reached 115, and it stopped accepting new SSH logins entirely. It recovered on
its own once the kernel killed the agents. Both client apps survived, but only
because the OOM killer scores by size and the agents were the largest thing
running — that is luck, not a guarantee.

A measured agent run holds **~400 MB** RSS (388–399 MB across the samples) and
saturates roughly one core while it is working. The "roughly 1 GB per run"
figure that the ops documentation carried was 2.5x too high; it was corrected
throughout on 2026-09-15.

### Why nothing today prevents this

**The site lock** (`src/lib/lock/lock.ts`) is single-flight over one site's
repository, taken at the start of `runRequest` before anything else. One
installation serves one site, so a client can hold at most one in-flight
request — and therefore at most one agent container. This is a per-client
bound and it is the only one that binds.

**Nothing bounds the host.** Each client's app can only see its own daemon.
The per-client `MAX_CONCURRENT_RUNS` setting that used to exist counted
containers on that daemon and, sitting above a lock that already allows one,
never bound anything; it was removed rather than kept as false comfort. Ten
clients each editing at once is ten concurrent agents — about 4 GB of agents on
a 3.8 GB host — and no setting anywhere prevents it. **The host ceiling is the
number of clients provisioned on it.** `ops/status.sh` now reports that number
as `webamend_clients_total` so the gap is at least visible until this design lands.

## Goals

1. Concurrent agent runs across *all* clients on a host never exceed what the
   host can carry — by a computed ceiling *and* by a live check of headroom.
2. Requests over that ceiling **queue, in arrival order**, rather than fail or
   degrade each other.
3. Capacity is derived from host resources, not hand-set per client.
4. A queued client sees an honest, calm state; a client who cannot be served in
   reasonable time is told so promptly, not after fifteen minutes.
5. The new machinery failing degrades protection, never availability.
6. A running agent cannot impair the client apps: it yields CPU to them and is
   bounded in memory.

## Non-goals

- Fair-share or per-client quotas. FIFO only; the site lock already prevents
  one client from queueing twice. Revisit if one client is observed
  monopolising the queue.
- Cross-host scheduling. One host, one queue.
- Any change to what a client sees. The queued and `too_busy` states already
  exist with correct copy in all four locales.
- Replacing the site lock. It answers a different question — "is this site
  already busy?" — and it is what keeps the queue bounded by client count.

## Design

A small host daemon, **`webamend-slotd`**, owns the queue. Client apps ask it for
permission before starting an agent and hold the lease for the run's duration.

```
  malulev app ─┐
  imidan  app ─┼──▶ /run/webamend/slotd.sock ──▶ webamend-slotd ──▶ FIFO queue
  ...     app ─┘    (0660, group webamend-slots)     │            capacity N
                                                 ├─ identity: SO_PEERCRED
                                                 ├─ brake:    MemAvailable
                                                 └─ grant:    {memoryBytes}
```

### Capacity: a computed ceiling, plus a live brake

**The ceiling** is computed once at daemon start and on `SIGHUP`:

```
mem_slots = floor((MemTotal - reserve) / AGENT_MEM_ESTIMATE)
reserve   = clients * APP_RSS_ESTIMATE + HOST_RESERVE
cpu_slots = floor(nproc * CPU_OVERSUBSCRIBE)
capacity  = max(1, min(mem_slots, cpu_slots))
```

`clients` is the membership of the `webamend-slots` group, which provisioning
maintains — no filesystem permissions to reason about. Defaults, all
overridable in `/etc/webamend/slots.env`:

| Name | Default | Basis |
|---|---|---|
| `AGENT_MEM_ESTIMATE` | `400M` | Measured working set, 2026-09-14 |
| `AGENT_MEM_CAP` | `800M` | 2x the working set; handed to each run with its grant |
| `APP_RSS_ESTIMATE` | `160M` | `next-server` measured at 149 MB |
| `HOST_RESERVE` | `600M` | Root, Caddy, registry, sshd, page cache |
| `CPU_OVERSUBSCRIBE` | `2.0` | Load 4.05 on 2 vCPU was survivable; 8 agents was not |
| `BRAKE_MARGIN` | `200M` | Headroom kept beyond one agent's estimate |

On this host today: `(3819 - (2*160 + 600)) / 400 = 7` memory slots,
`2 * 2.0 = 4` CPU slots → **capacity 4**, which matches the measured survivable
point exactly. At ten clients: `(3819 - (10*160 + 600)) / 400 = 4`, CPU still
4 → **capacity 4**, with six requests queueing.

**The brake** is the live half of the requirement. A free slot is not enough:
before granting, the daemon reads `MemAvailable` from `/proc/meminfo` and, if
it is below `AGENT_MEM_ESTIMATE + BRAKE_MARGIN`, holds the head of the queue
and re-checks each second. Order is preserved — the brake only delays. It
catches what the ceiling cannot: a client app that has grown, a burst of page
cache, an agent that is larger than its estimate. Time spent braked counts
toward the waiter's ceiling like any other waiting.

### Identity comes from the kernel, not the client

A shared socket where the client names itself is a socket where any client can
claim to be any other. The daemon instead reads `SO_PEERCRED` on each
connection: the kernel reports the connecting process's uid. The app container
runs as container-root, which rootless Docker maps to the client's own host
uid — `1000` is `malulev` straight from `/etc/passwd`. If a container ever runs
as a non-root user, the uid lands in that client's `/etc/subuid` range; the
same lookup, one more file. An uid that maps to no client is refused.

With identity real, **one lease per client** is enforced daemon-side: a second
`acquire` from a uid that already holds one is refused. The site lock already
prevents this in a healthy app; this is what prevents it in a broken one.

### Protocol

Newline-delimited JSON over a unix stream socket. The connection *is* the
lease: there is no release message, and nothing to leak.

```
client → {"op":"acquire","requestId":"req-123"}          // identity from SO_PEERCRED
server → {"event":"queued","position":3}                   // only if it must wait
server → {"event":"granted","memoryBytes":838860800}       // run starts now
server → {"event":"refused","reason":"<see below>"}
```

`requestId` is for log correlation only; nothing is decided on it.

Refusal reasons: `projected_wait_exceeds_ceiling`, `already_holding`,
`unknown_client`. The client maps every refusal to the existing `too_busy`
path and records the reason in the durable record's `errorDetail`, never in
client-facing prose (Principle I).

**Lease lifetime is connection lifetime.** The client holds the connection open
for the whole run and closes it when the run ends, by any path. If the app
crashes, the container is killed, or the host reboots, the kernel closes the
socket and the daemon frees the slot and dequeues the waiter. This is the same
property the old container-counting approach valued — a dead holder simply
stops being counted, with no stale state to reason about — except the daemon
now arbitrates exactly, so two waiters cannot both observe the same free slot.

### Refusing early instead of waiting in vain

The daemon keeps a ring of recent lease durations. When a new waiter's
projected wait — `(position / capacity) * p50_lease_duration` — already
exceeds the ceiling, it answers `refused` at once. The client gets the honest
message in two seconds rather than after fifteen minutes of false hope:

> "Things are busy right now, so your change did not run. Please try again in
> a few minutes. Nothing was published."

Until the ring has data (the first runs after a daemon restart), no projection
is made and waiters simply queue.

### The grant carries the memory cap

The per-container memory cap was removed on 2026-09-14 because, at 1 GB, it
never bound a ~400 MB run and only suggested protection that was not there. It
returns here, sized to bind, and from one source of truth: the grant. The
daemon's `AGENT_MEM_CAP` arrives as `memoryBytes`, and the app applies it to
the container it is about to create:

```ts
HostConfig: {
  Memory: grant.memoryBytes,
  MemorySwap: grant.memoryBytes,   // equal, so the cap is a cap and not a suggestion
  CpuShares: 512,                  // always: half the default weight
  PidsLimit: 512,
  ...
}
```

Capacity and per-agent bound now come from the same `/etc/webamend/slots.env`, so
they cannot drift apart, and the budget becomes provable: `capacity ×
AGENT_MEM_CAP` against `MemTotal - reserve`. In fallback mode (no daemon) no
cap is applied — today's behavior exactly.

`CpuShares: 512` is unconditional. It is the most direct answer to "without
impairing existing ones": when CPU saturates — and it did at four agents — the
kernel gives client apps and Caddy twice an agent's share, so the sites stay
responsive through the burst.

### Client side

**The interface gains a release.** Today a slot is held implicitly, so
`SlotOutcome` carries only `ok` and `waitedMs`. A lease must be given back:

```ts
export type SlotOutcome =
  | { ok: true; waitedMs: number; memoryBytes?: number; release(): Promise<void> }
  | { ok: false; waitedMs: number; reason?: string };
```

`UNLIMITED_SLOTS` returns a no-op `release` and no `memoryBytes`, so its
behavior is unchanged.

**`run.ts` releases on every path.** The slot handle is hoisted alongside
`tree` and `controlDir` and released in the `finally` that already exists,
next to `handle.release()` for the site lock. A slot released anywhere but a
`finally` leaks capacity on the failure paths, and leaked capacity is a host
that quietly stops admitting anyone.

**The implementation:**

```ts
// src/lib/runner/lease-slots.ts
export function createLeaseSlots(options: {
  socketPath: string;
  fallback: AgentSlots;          // UNLIMITED_SLOTS in production
}): AgentSlots
```

`acquire` connects, sends `acquire`, fires `onWait` on the first `queued`
event (preserving the once-only contract), resolves `{ok: true, memoryBytes,
release}` on `granted` or `{ok: false, reason}` on `refused`. `release` closes
the socket and is idempotent.

**Fail-open.** If the socket is absent, refuses the connection, or drops
mid-wait, `createLeaseSlots` logs `slots.broker_unavailable` at error level
and delegates to `fallback`. A dead daemon degrades protection; it never stops
a client editing their site. This follows the reasoning the old module wrote
down: refusing every request because the arbiter cannot answer turns a
monitoring fault into an outage.

Wiring in `src/lib/installation.ts`:

```ts
slots: env.slotBrokerSocket
  ? createLeaseSlots({ socketPath: env.slotBrokerSocket, fallback: UNLIMITED_SLOTS })
  : UNLIMITED_SLOTS,
```

`SLOT_BROKER_SOCKET` unset — a development machine, or a host not yet upgraded
— means today's behavior exactly. The feature is opt-in per installation and
reversible by removing one line from a `.env`.

### Host integration

**The daemon** is a single stdlib-only Python 3 file, `ops/slotd/webamend-slotd.py`
(`asyncio`, `socket`, `struct`, `pwd`). Python 3.12 is already on the host, so
nothing is installed. It is not containerised on purpose: the queue that
protects the host must not depend on the Docker daemons it is protecting.
Node was considered and rejected — it has no `SO_PEERCRED` API, and would have
needed a runtime installed to deliver a weaker identity guarantee.

**Systemd owns the socket**, so the daemon never runs as root:

```ini
# webamend-slotd.socket
[Socket]
ListenStream=/run/webamend/slotd.sock
SocketMode=0660
SocketGroup=webamend-slots

# webamend-slotd.service
[Service]
ExecStart=/usr/bin/python3 /opt/webamend/src/ops/slotd/webamend-slotd.py
EnvironmentFile=-/etc/webamend/slots.env
DynamicUser=yes
SupplementaryGroups=webamend-slots
OOMScoreAdjust=-900
```

`OOMScoreAdjust=-900` because the admission controller is the last thing that
should die when memory is short.

**Clients reach it** through one bind mount added to `docker-compose.yml`
alongside the two that exist:

```yaml
- ${SLOT_BROKER_SOCKET:-/run/webamend/slotd.sock}:/run/webamend/slotd.sock
```

`provision-client.sh` adds each client user to `webamend-slots`, writes
`SLOT_BROKER_SOCKET` into the client `.env`, and signals the daemon to
recompute capacity. `bootstrap-host.sh` creates the group and installs the
units.

### Observability

The daemon answers `{"op":"status"}` on the same socket with capacity, leased
count, queue depth, p50 wait, and refusal counters by reason. `ops/probe.sh`
queries it and writes metrics in the established `webamend_*` naming:

```
webamend_slots_capacity                 4
webamend_slots_leased                   2
webamend_slots_queued                   6
webamend_slots_braked                   0      # head is held by the memory brake
webamend_slots_wait_seconds_p50         12.4
webamend_slots_refused_total{reason=…}  3
```

`webamend_slots_capacity` replaces `webamend_clients_total` as the demand line on the
memory-headroom panel and in alert A5. Two alert rules join it:
`webamend_slots_queued > 0 for 10m` (capacity pressure) and any increase in
`webamend_slots_refused_total` (capacity below demand). Both mean "add RAM or
another host," which is the early warning the old `waitedMs` logging argued
for.

The daemon logs one structured line per grant, refusal, and release with the
client and `requestId`, so a request's wait can be traced end to end alongside
the app's own `slot.waited` event.

**The client-facing experience does not change.** A queued request still shows
"Waiting for a free turn" in the progress trail, and a refused one still gets
the `too_busy` message and HTTP 503. Queue position is deliberately not shown:
it would need new copy in four locales, ordinals in Hebrew, and a change to the
once-only `onWait` contract, for modest benefit. Capacity pressure is an
operator concern first.

## Failure modes

| Failure | Behavior | Rationale |
|---|---|---|
| Daemon down / socket missing | Log, fall back to `UNLIMITED_SLOTS` | Availability over protection; same as today |
| Daemon restarts mid-wait | Waiters' sockets close; they fall back for that request | The queue is ephemeral by design |
| App container killed mid-run | Lease frees while the agent still runs → overshoot of 1 | Accepted; the orphaned agent is already a leaked run the runner's `finally` handles |
| Client never closes the socket | Lease held until the connection dies | Bounded by the request's own timeout |
| Client claims another identity | Impossible; identity is `SO_PEERCRED` | — |
| Same client connects twice | Second refused `already_holding` | Defense in depth behind the site lock |
| Unknown uid connects | Refused `unknown_client`, logged | A misprovisioned client fails loudly |
| Memory brake holds for the whole ceiling | Head is refused `projected_wait_exceeds_ceiling` | An honest "busy" beats a silent stall |
| Capacity computed too high | The brake catches the live shortfall; a run over its cap is killed inside its own cgroup | Two independent bounds |
| Group has no members at start | Capacity from `clients = 1`, logged | Over-reserving is the safe direction |

## Testing

**Daemon** (`ops/slotd/test_webamend_slotd.py`, `unittest`, no root, temp socket):
- `compute_capacity()` — the table above, boundary cases, the `max(1, …)`
  floor, every override parsed from config.
- Identity — the test's own uid maps to its own name; an unmapped uid is
  refused `unknown_client`; a second connection from the same uid is refused
  `already_holding`.
- Queue — at most `capacity` granted at once; the rest granted in arrival
  order; closing a holder's socket promotes exactly the next waiter.
- Brake — with `MemAvailable` injected below the threshold, the head is held
  and `status` reports it braked; raising it releases the head.
- Early refusal — with ring data, a waiter whose projection exceeds the
  ceiling is refused at once; with no ring data, it queues.
- The grant carries `memoryBytes` equal to the configured cap.

**`createLeaseSlots`** (`tests/unit/runner/lease-slots.test.ts`, fake socket
server): `onWait` fires once and only when queueing; `granted` resolves ok with
`memoryBytes`; `refused` resolves not-ok with the reason; `release` closes the
socket and is safe to call twice; **socket absent, connection refused, and
mid-wait disconnect each delegate to the fallback.**

**Release discipline** (`tests/unit/jobs/`): with a spy slot, `release` is
called exactly once on each ending — success, agent failure, policy block,
thrown error — and *not* on the `too_busy` path where nothing was granted.

**Container options** (`tests/unit/runner/isolation.test.ts`): a run given
`memoryBytes` sets `Memory` and `MemorySwap` to it; a run without one sets
neither; `CpuShares` is 512 and `PidsLimit` 512 in both cases.

**Integration** (`tests/integration/slots.test.ts`, extending what is there):
the queued stage appears only for a request that waited, and a refused request
records the reason in `errorDetail` while the client sees `too_busy`.

**Verified on the host, not in tests:** capacity derived on the real box is 4;
re-running the 2026-09-14 stress procedure through the app (not around it)
never exceeds capacity and never approaches 0 MB available.

## Constitution notes

**VII — State Lives Where It Already Lives.** This adds shared state across
installations, which the old `slots.ts` explicitly declined. VII permits it on
two conditions, both met: the state is *ephemeral* (daemon memory, tied to open
sockets, gone on restart — not a datastore), and it answers "a named, observed
pain — not in anticipation of one." The stress test of 2026-09-14 is that
pain, and this document is the record VII asks be made.

**VIII — Ship the Smallest Thing That Proves the Loop.** FIFO with no fairness,
a static ceiling with one live check, one file of daemon, and no change to the
client UI.

**I — client-facing copy.** No new client-visible strings. Refusal reasons live
in `errorDetail`, never in prose.

## Rejected alternatives

**File-based FIFO on shared tmpfs.** Lock files in a group-owned directory,
position by arrival time, dead waiters reaped by testing their `flock`. No
daemon, same kernel-liveness property. Rejected as harder to reason about and
observe than a queue in one process, unable to project wait times, and unable
to identify clients without a daemon reading credentials anyway.

**A Node daemon.** Consistent with the app's language, but Node exposes no
`SO_PEERCRED`, so identity would have been a self-reported slug on a shared
socket, and Node would have had to be installed on every host. Python's is one
`getsockopt` and is already there.

**HTTP admission endpoint on loopback.** Rootless daemons run in their own
network namespace with host-loopback access disabled by default — the reason
`release.sh` falls back to `docker save | docker load`. Loopback HTTP is the
harder path here.

**Capacity from live `MemAvailable` alone.** Adapts, but makes admission
non-deterministic and hard to explain to a queued client. A computed ceiling
with the live check as a brake keeps admission predictable and still honors
the requirement's "as long as the host can."

**cgroup memory caps instead of a queue.** Kernel-enforced and code-free, but
they bound *damage*, not admission: over capacity a run is killed rather than
queued, which fails the goal. Worth adding on the user slices as an
independent backstop; not a substitute.

**Swap.** The observed failure was reclaim thrash (PSI full 87.65), not a clean
OOM; the host recovered in a minute precisely because there was no swap to
grind through first. With admission enforced there is no overcommit for swap
to absorb. `bootstrap-host.sh` keeps swap opt-out for operators who prefer
slow to killed in the meantime, with its comment corrected to say so.

**A cluster scheduler (Nomad, k3s, Swarm) or a job queue (Redis, Postgres).**
The conventional answers, and either would replace the one-daemon-per-client
isolation model or add a datastore against Principle VII — for one 2 vCPU box.

**A host-level runner service** — clients submit jobs, one service runs every
agent. Capacity becomes trivially exact and client apps lose the Docker socket
entirely, a real security gain. But every agent would run on one shared daemon
with work trees resolved by it, weakening the isolation boundary this topology
exists for. The right design from scratch, and the natural next step if a
shared agent pool is ever wanted; this daemon's protocol is a strict subset of
it, so nothing here is thrown away.

## Rollout

1. Land the daemon, `createLeaseSlots`, the `release` on `SlotOutcome`, the
   grant-carried cap and `CpuShares`, and every test. No behavior change while
   `SLOT_BROKER_SOCKET` is unset.
2. Install `webamend-slotd` on the host; verify `webamend_slots_capacity` reports 4.
3. Enable for one client; confirm a grant, then a queued request in the trail.
4. Enable for the rest. Re-run the stress procedure *through the app*; confirm
   the cap holds and available memory never approaches zero.
5. Switch the memory-headroom panel and alert A5 from `webamend_clients_total` to
   `webamend_slots_capacity`; add the queued and refused alerts.
6. Add `MemoryMax` on the client user slices and `OOMScoreAdjust` on Caddy and
   sshd as the independent backstop.

## Resolved questions

- **Keep `MAX_CONCURRENT_RUNS` as the fallback limit?** No — removed
  2026-09-15. It never bound under this topology; the fallback is
  `UNLIMITED_SLOTS`, which with the site lock is exactly today's behavior.
- **Static or live capacity?** Both: a computed ceiling, and a live brake on
  `MemAvailable` before each grant.
- **Who identifies the client?** The kernel, via `SO_PEERCRED`.
- **Where does the per-agent memory cap live?** In the grant.

## Open questions

- Should a queued client be able to cancel from the UI? Out of scope; the site
  lock already prevents them queueing twice, and closing the tab does not
  abandon the request today either.
