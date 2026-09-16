# Multi-client deployment on one VPS

**Date:** 2026-09-05
**Status:** accepted, implemented in this branch

One installation serves one website (constitution VI). Serving 5–25 client sites therefore
means 5–25 installations, and the question this answers is what separates them from each other
when they share a machine — and what it costs to run that many.

---

## The constraint that decides everything

`docker-compose.yml` mounts `/var/run/docker.sock` into the app container, because the
application starts an agent container per request. **Access to that socket is root on the
host.** Two installations sharing one root daemon are therefore not isolated from each other at
all: a remote code execution in client A's app container reads client B's GitHub App key,
Netlify token, git mirror and conversation history.

That is not fixed by how the secrets are injected. Docker secrets, `*_FILE` indirection, a
vault — none of them survive an attacker who can create a container with
`Binds: ["/:/host"]`.

A socket proxy does not fix it either. `tecnativa/docker-socket-proxy` filters on HTTP path and
method; it does not inspect request bodies. The runner requires `POST /containers/create`
(`src/lib/runner/docker.ts`), and that endpoint's body carries `HostConfig.Binds` and
`Privileged`. Allowing the endpoint at all allows the escape.

**Rule: any path to `POST /containers/create` on a root daemon is root on the host.**

## Decision: one Linux user per client, each running its own rootless daemon

Client A's app container talks to a daemon running as user `A`. Three separate mechanisms then
do the work, all kernel-enforced:

1. **Authority.** Compromising A's socket yields user `A`, not root. The `Binds: ["/:/host"]`
   mount still succeeds, and every read of `/srv/webamend/B` is refused because that directory is
   mode 0700 owned by `B`.
2. **User namespaces.** `/etc/subuid` maps container UID 0 to A's host UID and container UIDs
   1..65536 into A's subordinate range. A container escape lands as an unprivileged host user.
3. **Ownership as the enforcement point.** Not policy, not configuration — `chown`/`chmod`,
   checked on every syscall.

Rejected alternatives:

- **Shared root daemon + per-client socket proxy.** Narrows the API surface, is not a tenant
  boundary, and reads as one — the most dangerous property a control can have.
- **Payload-validating broker per client** (a service that builds the `createContainer` call
  itself, pinning the image and forcing the binds). A genuine control, and compatible with this
  design, but it is a service to write, test, run and monitor; the rootless boundary is
  stronger per unit of effort. Left open as a later addition.
- **One VM per client.** Strongest, and the right answer above roughly 25 clients or for
  clients whose data warrants it. Rejected now on cost.

Honest limits: a shared kernel, so a kernel LPE crosses the boundary; a shared reverse proxy;
and provisioning that leaves a state directory at 0755 silently removes the containment. The
last of those is why provisioning is a script rather than a runbook.

## Decision: build once, distribute through a host-local registry

`docker-compose.yml` builds the app image inline. With 20 clients on 20 rootless daemons —
each with its own image store — that is 20 identical Next.js builds per release, roughly 40
minutes of CPU and 20 copies of the same layers.

Images are built once on the host's root daemon, tagged with the git short SHA, and pushed to a
registry container on `127.0.0.1:5000`. Each client's daemon pulls from it. Localhost registries
are insecure-by-default in Docker, so this adds no TLS to configure and exposes nothing off the
box.

`docker-compose.yml` gains `image:` alongside its existing `build:`, so a development machine
still builds inline while a client host runs a pulled tag.

## Decision: no application code knows about any of this

`dockerode` honours `DOCKER_HOST` (`node_modules/docker-modem/lib/modem.js`), and the Compose
file mounts `${DOCKER_SOCK}` onto the standard in-container socket path, so an installation is
pointed at its own rootless daemon by environment alone. `installation.ts`, `docker.ts` and
`slots.ts` are untouched by the topology.

## The bug this uncovered

The agent image runs as UID 10001 (`agent/Dockerfile`). The host process prepares the working
tree and the control directory as whoever it runs as — root under Compose, a developer's own
account under `npm run dev` — and `mkdtemp` creates the control directory at 0700
(`src/lib/jobs/run.ts`). Two unrelated uids, no shared group: **the agent could not write to
anything it was given, in any deployment, and never could.**

The failure is silent. The container starts, every edit fails, the run completes, and the
client is told the agent made no change — indistinguishable from a model that declined the
work. No test caught it because no test exercises a real daemon; the only runner test doubles
are `src/lib/runner/fake.ts` and `tests/unit/runner/fake-docker.ts`.

Fixed in two halves:

- **Host side** — `src/lib/runner/permissions.ts` widens the working tree and control directory
  so a foreign uid can traverse and write them, immediately before the container starts.
  Directories gain `o+rwx`, files `o+rw`, executables keep their execute bit, and symbolic
  links are stepped over rather than followed (a link the agent planted on an earlier run must
  not be able to widen anything outside the tree).
- **Container side** — `umask 000` in `agent/entrypoint.sh`, so files and directories the agent
  creates are ones the host can commit into and delete afterwards. Without it the failure moves
  later, to the commit and the cleanup, which is worse.

Both are contained by the same property: these are per-request directories inside an
installation's own 0700 state directory, destroyed when the run ends, holding no credential
(`contracts/repo-files.md`). **The 0700 state directory is load-bearing** — provisioning
enforces it, and `ops/README.md` names it as the thing an operator must not get wrong.

Rejected alternative: running the agent container as the tree's owner. Under Compose the host
process is root, so this would make the agent root inside its own container — trading a
documented structural property for a mode bit.

## What `MAX_CONCURRENT_RUNS` now means

`countRunningAgents` asks *its own* daemon how many containers carry the agent label
(`src/lib/runner/slots.ts`). With a daemon per client, the count is per client, not host-wide as
that module's comments assume. The host total is the sum across installations, so the budget is
`MAX_CONCURRENT_RUNS × clients ≈ RAM available after the app containers`, at roughly 1 GB per
concurrent run. Documented in `ops/README.md` and the README rather than changed in code:
making the count host-wide again would require shared state the product deliberately does not
have (constitution VII).

## Why not a managed container platform

Considered and rejected on measurement, not preference. Local `docker create` + `start` on a
warm image is ~1s; a request's four-minute budget is spent in the model run and the Netlify
build. Fargate task start is 30–60s and Cloud Run Jobs 10–30s, so moving agent execution to a
managed platform makes the visible latency worse.

Neither offers a Docker socket, so the app would need a new `JobRunner` written against a
platform API — and `RunRequest` is defined in host paths (`workDir`, `controlDir` are bind
mounts, `src/lib/runner/types.ts`), because the app does all the git work and the agent image
deliberately has neither git nor credentials. A remote runner means shipping the tree out and
back, which changes the agent contract, not just an implementation.

Scale-to-zero is unavailable regardless: the app holds an SSE stream open during a run and
polls Netlify for deploys.

The revisit signal is explicit: agent runs queueing regularly (clients seeing "Waiting for a
free turn"), or more than ~25 installations on one box. Fly Machines is the target if that day
comes — 1–3s starts, per-second billing — not Fargate.

## Operations layer

| Script | Purpose |
|---|---|
| `ops/bootstrap-host.sh` | Once per VPS: Docker, rootless prerequisites, `/srv/webamend`, the local registry. |
| `ops/provision-client.sh <slug> <hostname> <port>` | One client: user, linger, rootless daemon, 0700 tree, `.env` skeleton. Never invents secrets, never starts the stack. |
| `ops/release.sh [ref]` | Build both images once, push, roll each client forward one at a time. One client's failure does not abort the rest. |
| `ops/status.sh` | Per client: daemon, container, HTTP, running agents, deployed tag. |

Shell scripts rather than Ansible: at 5–25 clients on one host, Ansible's advantages
(multi-host, drift correction) do not pay for their machinery, and the scripts define the same
steps a playbook would if that changes.
