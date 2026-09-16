# Host Admission Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-wide FIFO admission queue so that any number of clients editing at once never start more agent containers than the host can carry — and a local stress harness that proves it on a developer's Mac within a memory budget.

**Architecture:** A stdlib-only Python daemon (`webamend-slotd`) owns the queue behind a unix socket; the connection is the lease, the kernel names the client (`SO_PEERCRED`), capacity is a computed ceiling with a live `MemAvailable` brake, and each grant carries the agent's memory cap. The TypeScript app gains one `AgentSlots` implementation that talks to it and falls back to today's behavior if it is unreachable. Ops scripts install the daemon under systemd and enrol each client.

**Tech Stack:** Python 3.9+ standard library (`asyncio`, `socket`, `struct`, `pwd`, `grp`) and `unittest`; TypeScript with `node:net`, Vitest; bash + systemd for ops.

**Spec:** `docs/superpowers/specs/2026-09-14-host-admission-queue-design.md`

## Global Constraints

- **Python ≥ 3.9.** The VPS has 3.12; the developer Mac has 3.9.6. No `match`, no `X | Y` at runtime, no `asyncio.TaskGroup`/`asyncio.timeout`, no `dataclass(slots=True)`. Use `from __future__ import annotations`.
- **Standard library only** for the daemon, its tests, and the harness. No `pip install` anywhere.
- **The daemon file is `ops/slotd/webamend_slotd.py`** (underscore, so tests import it). The spec wrote `webamend-slotd.py`; the systemd unit and docs use the underscore name.
- **Socket mode is `0666`, not the spec's `0660`.** A rootless container's process does not carry the client's host group memberships, so a group-restricted socket would refuse the very apps it serves. Reachability is not authorization: every connection is identified by `SO_PEERCRED` and refused unless its uid maps to a member of `webamend-slots`. The group is the authorization list and the client count; the mode is only reachability.
- **Compose mounts the directory `/run/webamend`, not the socket file.** A bind mount of a missing file makes Docker create a *directory* at that path; a missing directory is harmless and lets the socket appear later.
- **No new client-facing strings.** Refusal reasons go into `errorDetail`, never prose (Principle I). The four locales are untouched.
- **`tsconfig`:** `strict`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: false`.
- **Log event names are a closed union** in `src/lib/log/events.ts`; a new event must be added there or it will not compile.
- **Tests run without root** and without Docker. The daemon's tests use a temp socket and a fake platform; identity tests use the test's own uid.
- **Every test name is a sentence about behavior**, matching the repo's existing style.
- **Commits:** the working tree already carries unrelated uncommitted work in some of the files this plan touches (`ops/status.sh`, `ops/README.md`, `docker-compose.yml`, `ops/monitoring/*`). `git add` exactly the paths each task names; where a file has pre-existing hunks, say so in the commit body. Branch first: `git checkout -b host-admission-queue`.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `ops/slotd/webamend_slotd.py` | The daemon: sizes/config, capacity, platform layer, broker (queue), server (protocol + identity), `status` CLI |
| `ops/slotd/test_webamend_slotd.py` | `unittest` suite for all of the above |
| `ops/slotd/stress.py` | Local stress harness: spawns the daemon and N memory-allocating fake clients inside a budget, prints the timeline, verifies the cap |
| `ops/slotd/slots.env.example` | Every tunable with its default and basis |
| `ops/slotd/systemd/webamend-slotd.socket`, `webamend-slotd.service` | Socket-activated unit, unprivileged service |
| `src/lib/runner/lease-slots.ts` | `createLeaseSlots`: the app-side client of the daemon, with fallback |
| `tests/unit/runner/lease-slots.test.ts` | Against a scripted fake broker on a temp unix socket |

**Modified**

| Path | Change |
|---|---|
| `src/lib/runner/slots.ts` | `SlotOutcome` gains `release`, `memoryBytes`, `reason`; `acquire` takes `requestId` |
| `src/lib/jobs/run.ts` | Hoists the slot, releases in `finally`, passes `memoryBytes` to the runner, records refusal reason |
| `src/lib/runner/types.ts` | `RunRequest.memoryBytes?` |
| `src/lib/runner/docker.ts` | `Memory`/`MemorySwap` from the request, `CpuShares: 512` |
| `src/lib/config/env.ts`, `src/types/index.ts` | `SLOT_BROKER_SOCKET` → `env.slotBrokerSocket?` |
| `src/lib/installation.ts` | Wires `createLeaseSlots` when configured |
| `src/lib/log/events.ts` | `'slots.broker_unavailable'` |
| `tests/integration/slots.test.ts` | Fakes return `release`; new cases for release discipline, refusal reason, `memoryBytes` propagation |
| `tests/unit/runner/isolation.test.ts`, `tests/unit/runner/slots.test.ts`, `tests/unit/config/env.test.ts` | New assertions |
| `docker-compose.yml` | `/run/webamend` bind mount |
| `ops/bootstrap-host.sh` | `install_slotd` |
| `ops/provision-client.sh` | `enroll_in_slots`, `SLOT_BROKER_SOCKET` in the skeleton |
| `ops/probe.sh`, `ops/status.sh` | `webamend_slots_*` metrics and a `SLOTS` line |
| `package.json`, `.github/workflows/ci.yml` | `test:slotd`, `stress:slotd`; CI step |
| `ops/README.md`, `ops/MONITORING.md`, `ops/monitoring/grafana/alert-rules.md`, `ops/monitoring/grafana/dashboard-health.json` | Document and switch the demand line to `webamend_slots_capacity` |

---

## Phase 1 — the daemon and the local stress test

Everything the user needs to run `npm run stress:slotd` on a Mac and watch the queue work. Tasks 1–5.

### Task 1: Sizes, configuration, capacity

**Files:**
- Create: `ops/slotd/webamend_slotd.py`
- Create: `ops/slotd/test_webamend_slotd.py`
- Create: `ops/slotd/__init__.py` (empty — makes `python3 -m unittest discover -s ops/slotd` import the module)

**Interfaces:**
- Produces: `parse_size(text: str) -> int`; `Config` dataclass with `from_env(env: dict | None) -> Config`; `compute_capacity(mem_total: int, cpu_count: int, clients: int, config: Config) -> int`.

- [ ] **Step 1: Write the failing tests**

```python
# ops/slotd/test_webamend_slotd.py
"""
Tests for webamend-slotd. Standard library only, no root, no Docker.
Run: python3 -m unittest discover -s ops/slotd -p 'test_*.py' -v
"""
from __future__ import annotations

import unittest

import webamend_slotd as slotd


class SizesAndConfig(unittest.TestCase):
    def test_parse_size_reads_bytes_kilo_mega_giga(self):
        self.assertEqual(slotd.parse_size("400"), 400)
        self.assertEqual(slotd.parse_size("400K"), 400 * 1024)
        self.assertEqual(slotd.parse_size("400M"), 400 * 1024 ** 2)
        self.assertEqual(slotd.parse_size("2G"), 2 * 1024 ** 3)
        self.assertEqual(slotd.parse_size(" 800m "), 800 * 1024 ** 2)

    def test_parse_size_refuses_nonsense(self):
        for bad in ("", "M", "4.5G", "four", "-1M"):
            with self.assertRaises(ValueError, msg=bad):
                slotd.parse_size(bad)

    def test_config_defaults_match_the_spec(self):
        config = slotd.Config.from_env({})
        self.assertEqual(config.agent_mem_estimate, slotd.parse_size("400M"))
        self.assertEqual(config.agent_mem_cap, slotd.parse_size("800M"))
        self.assertEqual(config.app_rss_estimate, slotd.parse_size("160M"))
        self.assertEqual(config.host_reserve, slotd.parse_size("600M"))
        self.assertEqual(config.cpu_oversubscribe, 2.0)
        self.assertEqual(config.brake_margin, slotd.parse_size("200M"))
        self.assertEqual(config.identity, "peer")
        self.assertEqual(config.group, "webamend-slots")
        self.assertEqual(config.socket_path, "/run/webamend/slotd.sock")
        self.assertIsNone(config.clients_override)
        self.assertIsNone(config.capacity_override)

    def test_config_reads_every_override(self):
        config = slotd.Config.from_env({
            "AGENT_MEM_ESTIMATE": "300M",
            "AGENT_MEM_CAP": "1G",
            "APP_RSS_ESTIMATE": "100M",
            "HOST_RESERVE": "1G",
            "CPU_OVERSUBSCRIBE": "1.5",
            "BRAKE_MARGIN": "50M",
            "SLOTD_IDENTITY": "claimed",
            "SLOTD_GROUP": "editors",
            "SLOTD_SOCKET": "/tmp/x.sock",
            "SLOTD_CLIENTS": "7",
            "SLOTD_CAPACITY": "3",
        })
        self.assertEqual(config.agent_mem_estimate, slotd.parse_size("300M"))
        self.assertEqual(config.agent_mem_cap, slotd.parse_size("1G"))
        self.assertEqual(config.app_rss_estimate, slotd.parse_size("100M"))
        self.assertEqual(config.host_reserve, slotd.parse_size("1G"))
        self.assertEqual(config.cpu_oversubscribe, 1.5)
        self.assertEqual(config.brake_margin, slotd.parse_size("50M"))
        self.assertEqual(config.identity, "claimed")
        self.assertEqual(config.group, "editors")
        self.assertEqual(config.socket_path, "/tmp/x.sock")
        self.assertEqual(config.clients_override, 7)
        self.assertEqual(config.capacity_override, 3)

    def test_config_refuses_an_unknown_identity_mode(self):
        with self.assertRaises(ValueError):
            slotd.Config.from_env({"SLOTD_IDENTITY": "trust-me"})


class Capacity(unittest.TestCase):
    """The table in the spec, on the measured host: 3819 MB, 2 vCPU."""

    MB = 1024 ** 2

    def test_two_clients_on_the_measured_host_is_four_slots(self):
        config = slotd.Config.from_env({})
        self.assertEqual(slotd.compute_capacity(3819 * self.MB, 2, 2, config), 4)

    def test_ten_clients_on_the_measured_host_is_still_four_slots(self):
        config = slotd.Config.from_env({})
        self.assertEqual(slotd.compute_capacity(3819 * self.MB, 10, 10, config), 4)

    def test_memory_binds_before_cpu_when_the_reserve_is_large(self):
        config = slotd.Config.from_env({})
        # 20 clients: reserve 20*160+600 = 3800 MB; nothing left -> floor of 1.
        self.assertEqual(slotd.compute_capacity(3819 * self.MB, 8, 20, config), 1)

    def test_cpu_binds_on_a_big_box(self):
        config = slotd.Config.from_env({})
        # 64 GB, 4 cores, 2 clients: memory allows ~160, CPU allows 8.
        self.assertEqual(slotd.compute_capacity(64 * 1024 * self.MB, 4, 2, config), 8)

    def test_never_below_one(self):
        config = slotd.Config.from_env({})
        self.assertEqual(slotd.compute_capacity(100 * self.MB, 1, 50, config), 1)

    def test_overrides_change_the_answer(self):
        config = slotd.Config.from_env({"AGENT_MEM_ESTIMATE": "200M", "CPU_OVERSUBSCRIBE": "4"})
        self.assertEqual(slotd.compute_capacity(3819 * self.MB, 2, 2, config), 8)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `touch ops/slotd/__init__.py && python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `ModuleNotFoundError: No module named 'webamend_slotd'`

- [ ] **Step 3: Write the module header, sizes, config, capacity**

```python
#!/usr/bin/env python3
"""
webamend-slotd: host-wide admission for agent runs.

One daemon per host. Client apps connect over a unix socket, ask for a slot,
and hold the connection for as long as their agent runs. The connection is the
lease: there is no release message, so a client that dies is a client whose
slot the kernel gives back. Design and the measurements behind every default:
docs/superpowers/specs/2026-09-14-host-admission-queue-design.md

Python 3.9+, standard library only. Runs on Linux in production and on macOS
for a developer's stress test; the two differ only inside the Platform classes.
"""
from __future__ import annotations

import asyncio
import grp
import json
import os
import pwd
import signal
import socket
import struct
import subprocess
import sys
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, Dict, List, Optional

# ---------------------------------------------------------------------------
# Sizes and configuration
# ---------------------------------------------------------------------------

_UNITS = {"K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}


def parse_size(text: str) -> int:
    """'400M' -> 419430400. Bare digits are bytes."""
    raw = text.strip().upper()
    multiplier = 1
    if raw and raw[-1] in _UNITS:
        multiplier = _UNITS[raw[-1]]
        raw = raw[:-1]
    if not raw.isdigit():
        raise ValueError(f"not a size: {text!r}")
    return int(raw) * multiplier


@dataclass
class Config:
    """Every tunable, with the defaults the spec derived from measurement."""

    agent_mem_estimate: int = parse_size("400M")
    agent_mem_cap: int = parse_size("800M")
    app_rss_estimate: int = parse_size("160M")
    host_reserve: int = parse_size("600M")
    cpu_oversubscribe: float = 2.0
    brake_margin: int = parse_size("200M")
    # "peer": the kernel names the client (SO_PEERCRED). "claimed": the client
    # names itself in the acquire message. The second exists so a developer can
    # run ten fake clients from one uid on a Mac; it is never set in production.
    identity: str = "peer"
    group: str = "webamend-slots"
    socket_path: str = "/run/webamend/slotd.sock"
    clients_override: Optional[int] = None
    capacity_override: Optional[int] = None
    ring_size: int = 50
    tick_seconds: float = 1.0

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> "Config":
        source: Dict[str, str] = dict(os.environ) if env is None else env
        config = cls()
        sizes = {
            "AGENT_MEM_ESTIMATE": "agent_mem_estimate",
            "AGENT_MEM_CAP": "agent_mem_cap",
            "APP_RSS_ESTIMATE": "app_rss_estimate",
            "HOST_RESERVE": "host_reserve",
            "BRAKE_MARGIN": "brake_margin",
        }
        for name, attribute in sizes.items():
            if name in source:
                setattr(config, attribute, parse_size(source[name]))
        if "CPU_OVERSUBSCRIBE" in source:
            config.cpu_oversubscribe = float(source["CPU_OVERSUBSCRIBE"])
        config.identity = source.get("SLOTD_IDENTITY", config.identity)
        if config.identity not in ("peer", "claimed"):
            raise ValueError(f"SLOTD_IDENTITY must be 'peer' or 'claimed', not {config.identity!r}")
        config.group = source.get("SLOTD_GROUP", config.group)
        config.socket_path = source.get("SLOTD_SOCKET", config.socket_path)
        if "SLOTD_CLIENTS" in source:
            config.clients_override = int(source["SLOTD_CLIENTS"])
        if "SLOTD_CAPACITY" in source:
            config.capacity_override = int(source["SLOTD_CAPACITY"])
        return config


def compute_capacity(mem_total: int, cpu_count: int, clients: int, config: Config) -> int:
    """
    How many agents fit: what memory allows after every client's app and the
    host itself are reserved, capped by what the CPUs can carry. Never below
    one, or a small box could admit nobody forever.
    """
    reserve = clients * config.app_rss_estimate + config.host_reserve
    mem_slots = (mem_total - reserve) // config.agent_mem_estimate
    cpu_slots = int(cpu_count * config.cpu_oversubscribe)
    return max(1, min(mem_slots, cpu_slots))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `OK` with 12 tests

- [ ] **Step 5: Commit**

```bash
git checkout -b host-admission-queue
git add ops/slotd/__init__.py ops/slotd/webamend_slotd.py ops/slotd/test_webamend_slotd.py
git commit -m "feat(slotd): sizes, configuration and capacity formula

The formula and every default trace to the 2026-09-14 stress test; the table
in the spec is the test suite.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 2: The platform layer

**Files:**
- Modify: `ops/slotd/webamend_slotd.py` (append after `compute_capacity`)
- Modify: `ops/slotd/test_webamend_slotd.py` (append)

**Interfaces:**
- Produces: `class Platform` with `mem_total() -> int`, `mem_available() -> int`, `cpu_count() -> int`, `peer_uid(sock) -> int`, `group_members(group) -> list[str]`, `uid_to_name(uid) -> str | None`; `LinuxPlatform`, `DarwinPlatform`, `FakePlatform(mem_total, mem_available, cpu_count, uid, members, names)`; `detect_platform() -> Platform`; pure helpers `parse_meminfo(text) -> dict`, `parse_subuid(text, uid) -> str | None`, `parse_vm_stat(text) -> int`.

- [ ] **Step 1: Write the failing tests**

```python
# append to ops/slotd/test_webamend_slotd.py
import os
import socket


MEMINFO = """MemTotal:        3910784 kB
MemFree:          855040 kB
MemAvailable:    2928640 kB
Buffers:          123456 kB
"""

SUBUID = """malulev:100000:65536
imidan:165536:65536
claude:231072:65536
"""

VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4355.
Pages active:                            375519.
Pages inactive:                          373570.
Pages speculative:                          516.
Pages throttled:                              0.
Pages wired down:                        190991.
Pages purgeable:                          15148.
"""


class PlatformParsing(unittest.TestCase):
    def test_meminfo_is_read_in_bytes(self):
        values = slotd.parse_meminfo(MEMINFO)
        self.assertEqual(values["MemTotal"], 3910784 * 1024)
        self.assertEqual(values["MemAvailable"], 2928640 * 1024)

    def test_subuid_maps_a_subordinate_uid_to_its_owner(self):
        self.assertEqual(slotd.parse_subuid(SUBUID, 165536), "imidan")
        self.assertEqual(slotd.parse_subuid(SUBUID, 165536 + 65535), "imidan")
        self.assertEqual(slotd.parse_subuid(SUBUID, 100000), "malulev")
        self.assertIsNone(slotd.parse_subuid(SUBUID, 99999))
        self.assertIsNone(slotd.parse_subuid(SUBUID, 1000))

    def test_vm_stat_approximates_available_memory(self):
        expected = (4355 + 373570 + 516 + 15148) * 16384
        self.assertEqual(slotd.parse_vm_stat(VM_STAT), expected)


class PlatformOnThisMachine(unittest.TestCase):
    """The one real kernel call: the peer of a socketpair is this process."""

    def test_peer_uid_of_a_socketpair_is_our_own_uid(self):
        platform = slotd.detect_platform()
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.assertEqual(platform.peer_uid(right), os.getuid())
        finally:
            left.close()
            right.close()

    def test_real_readings_are_positive(self):
        platform = slotd.detect_platform()
        self.assertGreater(platform.mem_total(), 0)
        self.assertGreater(platform.mem_available(), 0)
        self.assertGreaterEqual(platform.cpu_count(), 1)

    def test_our_own_uid_has_a_name(self):
        platform = slotd.detect_platform()
        self.assertEqual(platform.uid_to_name(os.getuid()), pwd_name())


def pwd_name() -> str:
    import pwd
    return pwd.getpwuid(os.getuid()).pw_name


class FakePlatformBehaves(unittest.TestCase):
    def test_every_reading_is_settable(self):
        fake = slotd.FakePlatform(mem_total=10, mem_available=5, cpu_count=3, uid=42,
                                  members=["a", "b"], names={42: "a"})
        self.assertEqual(fake.mem_total(), 10)
        self.assertEqual(fake.mem_available(), 5)
        self.assertEqual(fake.cpu_count(), 3)
        self.assertEqual(fake.peer_uid(None), 42)
        self.assertEqual(fake.group_members("anything"), ["a", "b"])
        self.assertEqual(fake.uid_to_name(42), "a")
        self.assertIsNone(fake.uid_to_name(7))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `AttributeError: module 'webamend_slotd' has no attribute 'parse_meminfo'` (and siblings)

- [ ] **Step 3: Write the platform layer**

```python
# append to ops/slotd/webamend_slotd.py

# ---------------------------------------------------------------------------
# Platform: what the daemon needs from the host
# ---------------------------------------------------------------------------


class Platform:
    """Linux in production, Darwin on a developer's Mac, Fake in tests."""

    def mem_total(self) -> int:
        raise NotImplementedError

    def mem_available(self) -> int:
        raise NotImplementedError

    def cpu_count(self) -> int:
        return os.cpu_count() or 1

    def peer_uid(self, sock: socket.socket) -> int:
        raise NotImplementedError

    def group_members(self, group: str) -> List[str]:
        try:
            return list(grp.getgrnam(group).gr_mem)
        except KeyError:
            return []

    def uid_to_name(self, uid: int) -> Optional[str]:
        try:
            return pwd.getpwuid(uid).pw_name
        except KeyError:
            return None


def parse_meminfo(text: str) -> Dict[str, int]:
    """/proc/meminfo lines ('MemTotal:  3910784 kB') to bytes."""
    values: Dict[str, int] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        parts = rest.split()
        if not parts or not parts[0].isdigit():
            continue
        amount = int(parts[0])
        if len(parts) > 1 and parts[1].lower() == "kb":
            amount *= 1024
        values[key.strip()] = amount
    return values


def parse_subuid(text: str, uid: int) -> Optional[str]:
    """The /etc/subuid owner of a subordinate uid, or None if it is nobody's."""
    for line in text.splitlines():
        parts = line.strip().split(":")
        if len(parts) != 3 or not (parts[1].isdigit() and parts[2].isdigit()):
            continue
        start, count = int(parts[1]), int(parts[2])
        if start <= uid < start + count:
            return parts[0]
    return None


class LinuxPlatform(Platform):
    def _meminfo(self) -> Dict[str, int]:
        with open("/proc/meminfo", encoding="utf8") as handle:
            return parse_meminfo(handle.read())

    def mem_total(self) -> int:
        return self._meminfo()["MemTotal"]

    def mem_available(self) -> int:
        return self._meminfo()["MemAvailable"]

    def peer_uid(self, sock: socket.socket) -> int:
        credentials = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", credentials)
        return uid

    def uid_to_name(self, uid: int) -> Optional[str]:
        # A container process that is not root inside lands in the client's
        # subordinate range rather than on the client's own uid.
        name = super().uid_to_name(uid)
        if name is not None:
            return name
        try:
            with open("/etc/subuid", encoding="utf8") as handle:
                return parse_subuid(handle.read(), uid)
        except OSError:
            return None


def parse_vm_stat(text: str) -> int:
    """
    macOS `vm_stat` to an approximation of Linux's MemAvailable: pages that
    are free, inactive, speculative or purgeable, times the page size. Good
    enough to drive a brake on a developer's Mac; never used in production.
    """
    page_size = 4096
    pages: Dict[str, int] = {}
    for line in text.splitlines():
        if "page size of" in line:
            page_size = int(line.split("page size of")[1].split()[0])
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        value = value.strip().rstrip(".")
        if value.isdigit():
            pages[key.strip()] = int(value)
    wanted = ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable")
    return sum(pages.get(key, 0) for key in wanted) * page_size


class DarwinPlatform(Platform):
    # Python does not export these on macOS. getsockopt(SOL_LOCAL, LOCAL_PEERCRED)
    # fills a struct xucred whose first two fields are the version and the uid;
    # the rest (group list) is not needed and its layout is not relied on.
    _SOL_LOCAL = 0
    _LOCAL_PEERCRED = 0x0001
    _XUCRED_SIZE = 76

    def mem_total(self) -> int:
        return int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]).decode().strip())

    def mem_available(self) -> int:
        return parse_vm_stat(subprocess.check_output(["vm_stat"]).decode())

    def peer_uid(self, sock: socket.socket) -> int:
        credentials = sock.getsockopt(self._SOL_LOCAL, self._LOCAL_PEERCRED, self._XUCRED_SIZE)
        _version, uid = struct.unpack_from("II", credentials)
        return uid


class FakePlatform(Platform):
    """Every reading settable: tests, and the harness when it fakes memory."""

    def __init__(
        self,
        mem_total: int = 8 * 1024 ** 3,
        mem_available: int = 4 * 1024 ** 3,
        cpu_count: int = 4,
        uid: int = 1000,
        members: Optional[List[str]] = None,
        names: Optional[Dict[int, str]] = None,
    ) -> None:
        self.total = mem_total
        self.available = mem_available
        self.cpus = cpu_count
        self.uid = uid
        self.members = list(members or [])
        self.names: Dict[int, str] = dict(names or {})

    def mem_total(self) -> int:
        return self.total

    def mem_available(self) -> int:
        return self.available

    def cpu_count(self) -> int:
        return self.cpus

    def peer_uid(self, sock: object) -> int:
        return self.uid

    def group_members(self, group: str) -> List[str]:
        return list(self.members)

    def uid_to_name(self, uid: int) -> Optional[str]:
        return self.names.get(uid)


def detect_platform() -> Platform:
    return DarwinPlatform() if sys.platform == "darwin" else LinuxPlatform()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `OK` with 19 tests

- [ ] **Step 5: Commit**

```bash
git add ops/slotd/webamend_slotd.py ops/slotd/test_webamend_slotd.py
git commit -m "feat(slotd): platform layer for Linux, macOS and tests

Identity from SO_PEERCRED on Linux and LOCAL_PEERCRED on Darwin; memory from
/proc/meminfo and vm_stat. The daemon never learns which it is running on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 3: The broker — FIFO, capacity, brake, early refusal

**Files:**
- Modify: `ops/slotd/webamend_slotd.py` (append)
- Modify: `ops/slotd/test_webamend_slotd.py` (append)

**Interfaces:**
- Produces: `class Grant(memory_bytes: int, waited_seconds: float)`; `class Refusal(reason: str)`; `class Broker(config, platform, capacity, clock=time.monotonic, log=noop)` with `async acquire(client, request_id, max_wait_ms, on_queued) -> Grant | Refusal`, `release(client)`, `refuse(client, request_id, reason) -> Refusal`, `pump()`, `status() -> dict`, attribute `capacity` (settable), `braked: bool`.

- [ ] **Step 1: Write the failing tests**

```python
# append to ops/slotd/test_webamend_slotd.py
import asyncio


class Clock:
    """Deterministic time for the broker; advance() also lets the loop run."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    async def advance(self, seconds: float) -> None:
        self.now += seconds
        await asyncio.sleep(0)


def make_broker(capacity=2, mem_available=None, ring=None, clock=None, tick_seconds=0.01):
    config = slotd.Config.from_env({})
    config.tick_seconds = tick_seconds
    platform = slotd.FakePlatform(mem_available=mem_available if mem_available is not None else 4 * 1024 ** 3)
    broker = slotd.Broker(config, platform, capacity, clock=clock or Clock())
    for held in ring or []:
        broker.held_ring.append(held)
    return broker, platform


async def ask(broker, client, request_id="r", max_wait_ms=None):
    """Start an acquire; returns (task, list of queued positions announced)."""
    positions: list = []
    task = asyncio.ensure_future(broker.acquire(client, request_id, max_wait_ms, positions.append))
    await asyncio.sleep(0)
    return task, positions


class BrokerQueue(unittest.IsolatedAsyncioTestCase):
    async def test_grants_at_once_below_capacity_without_announcing_a_wait(self):
        broker, _ = make_broker(capacity=2)
        task, positions = await ask(broker, "a")
        grant = await task
        self.assertIsInstance(grant, slotd.Grant)
        self.assertEqual(grant.memory_bytes, slotd.parse_size("800M"))
        self.assertEqual(positions, [])

    async def test_queues_in_arrival_order_and_promotes_exactly_the_next_on_release(self):
        broker, _ = make_broker(capacity=1)
        first, _ = await ask(broker, "a")
        second, second_positions = await ask(broker, "b")
        third, third_positions = await ask(broker, "c")
        self.assertTrue(first.done())
        self.assertFalse(second.done())
        self.assertFalse(third.done())
        self.assertEqual(second_positions, [1])
        self.assertEqual(third_positions, [2])

        broker.release("a")
        await asyncio.sleep(0)
        self.assertTrue(second.done())
        self.assertFalse(third.done())

        broker.release("b")
        await asyncio.sleep(0)
        self.assertTrue(third.done())

    async def test_a_client_that_already_holds_or_waits_is_refused(self):
        broker, _ = make_broker(capacity=1)
        holder, _ = await ask(broker, "a")
        await holder
        again, _ = await ask(broker, "a")
        self.assertEqual((await again).reason, "already_holding")

        waiter, _ = await ask(broker, "b")
        twice, _ = await ask(broker, "b")
        self.assertEqual((await twice).reason, "already_holding")
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter

    async def test_a_waiter_that_leaves_is_withdrawn_and_the_next_is_served(self):
        broker, _ = make_broker(capacity=1)
        holder, _ = await ask(broker, "a")
        await holder
        leaver, _ = await ask(broker, "b")
        stayer, _ = await ask(broker, "c")
        leaver.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await leaver
        broker.release("a")
        await asyncio.sleep(0)
        self.assertTrue(stayer.done())
        self.assertEqual(broker.status()["queued"], 0)

    async def test_release_records_how_long_the_lease_was_held(self):
        clock = Clock()
        broker, _ = make_broker(capacity=1, clock=clock)
        task, _ = await ask(broker, "a")
        await task
        await clock.advance(12.5)
        broker.release("a")
        self.assertEqual(list(broker.held_ring), [12.5])

    async def test_capacity_can_be_raised_live(self):
        broker, _ = make_broker(capacity=1)
        first, _ = await ask(broker, "a")
        await first
        second, _ = await ask(broker, "b")
        self.assertFalse(second.done())
        broker.capacity = 2
        broker.pump()
        await asyncio.sleep(0)
        self.assertTrue(second.done())


class BrokerEarlyRefusal(unittest.IsolatedAsyncioTestCase):
    async def test_without_history_a_long_queue_simply_queues(self):
        broker, _ = make_broker(capacity=1)
        first, _ = await ask(broker, "a")
        await first
        waiter, positions = await ask(broker, "b", max_wait_ms=1000)
        self.assertFalse(waiter.done())
        self.assertEqual(positions, [1])
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter

    async def test_with_history_a_projected_wait_past_the_ceiling_is_refused_at_once(self):
        # p50 held = 60s, capacity 1: position 1 projects 60s; a 30s ceiling is hopeless.
        broker, _ = make_broker(capacity=1, ring=[60.0, 60.0, 60.0])
        first, _ = await ask(broker, "a")
        await first
        hopeless, positions = await ask(broker, "b", max_wait_ms=30_000)
        self.assertEqual((await hopeless).reason, "projected_wait_exceeds_ceiling")
        self.assertEqual(positions, [])
        self.assertEqual(broker.status()["refused"]["projected_wait_exceeds_ceiling"], 1)

    async def test_with_history_a_reachable_wait_queues(self):
        broker, _ = make_broker(capacity=1, ring=[10.0])
        first, _ = await ask(broker, "a")
        await first
        fine, _ = await ask(broker, "b", max_wait_ms=30_000)
        self.assertFalse(fine.done())
        fine.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await fine


class BrokerBrake(unittest.IsolatedAsyncioTestCase):
    async def test_a_free_slot_is_not_granted_while_available_memory_is_below_the_threshold(self):
        # threshold = 400M estimate + 200M margin = 600M
        broker, platform = make_broker(capacity=2, mem_available=slotd.parse_size("500M"))
        task, positions = await ask(broker, "a")
        self.assertFalse(task.done())
        self.assertEqual(positions, [1])
        self.assertTrue(broker.braked)
        self.assertTrue(broker.status()["braked"])

        platform.available = slotd.parse_size("700M")
        await asyncio.sleep(0.05)  # a tick
        self.assertTrue(task.done())
        self.assertFalse(broker.braked)

    async def test_a_braked_head_that_reaches_its_ceiling_is_refused(self):
        clock = Clock()
        broker, _ = make_broker(capacity=2, mem_available=slotd.parse_size("100M"), clock=clock)
        task, _ = await ask(broker, "a", max_wait_ms=5_000)
        self.assertFalse(task.done())
        await clock.advance(6)
        await asyncio.sleep(0.05)
        self.assertEqual((await task).reason, "projected_wait_exceeds_ceiling")
        self.assertEqual(broker.status()["queued"], 0)


class BrokerStatus(unittest.IsolatedAsyncioTestCase):
    async def test_status_reports_the_whole_picture(self):
        broker, platform = make_broker(capacity=2, ring=[4.0, 6.0, 8.0])
        holder, _ = await ask(broker, "a", request_id="req-a")
        await holder
        status = broker.status()
        self.assertEqual(status["capacity"], 2)
        self.assertEqual(status["leased"], 1)
        self.assertEqual(status["queued"], 0)
        self.assertEqual(status["braked"], False)
        self.assertEqual(status["memoryBytes"], slotd.parse_size("800M"))
        self.assertEqual(status["memAvailable"], platform.available)
        self.assertEqual(status["heldSecondsP50"], 6.0)
        self.assertEqual(status["holders"], {"a": "req-a"})
        self.assertEqual(status["refused"], {})
        self.assertIsNone(status["waitSecondsP50"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `AttributeError: module 'webamend_slotd' has no attribute 'Broker'`

- [ ] **Step 3: Write the broker**

```python
# append to ops/slotd/webamend_slotd.py

# ---------------------------------------------------------------------------
# Broker: the queue
# ---------------------------------------------------------------------------

LogFn = Callable[[str, Dict[str, object]], None]


def _no_log(event: str, fields: Dict[str, object]) -> None:
    return None


@dataclass
class Grant:
    memory_bytes: int
    waited_seconds: float


@dataclass
class Refusal:
    reason: str


@dataclass
class _Waiter:
    client: str
    request_id: str
    deadline: Optional[float]
    enqueued_at: float
    future: "asyncio.Future[object]"
    on_queued: Callable[[int], None]
    announced: bool = False


@dataclass
class _Lease:
    request_id: str
    granted_at: float


def _p50(values: Deque[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


class Broker:
    """
    Owns nothing but memory. Every fact about who holds what lives exactly as
    long as the connection that established it, which is what makes a crashed
    client a freed slot rather than a stale one.
    """

    def __init__(
        self,
        config: Config,
        platform: Platform,
        capacity: int,
        clock: Callable[[], float] = time.monotonic,
        log: LogFn = _no_log,
    ) -> None:
        self.config = config
        self.platform = platform
        self.capacity = capacity
        self.clock = clock
        self.log = log
        self.leases: Dict[str, _Lease] = {}
        self.queue: Deque[_Waiter] = deque()
        # How long leases were held: the basis for projecting a new waiter's wait.
        self.held_ring: Deque[float] = deque(maxlen=config.ring_size)
        # How long waiters waited: the metric an operator watches.
        self.wait_ring: Deque[float] = deque(maxlen=config.ring_size)
        self.refused: Dict[str, int] = {}
        self.braked = False
        self._ticker: Optional["asyncio.Task[None]"] = None

    # -- reading ------------------------------------------------------------

    def projected_wait_seconds(self, position: int) -> Optional[float]:
        p50 = _p50(self.held_ring)
        if p50 is None:
            return None
        return (position / self.capacity) * p50

    def status(self) -> Dict[str, object]:
        return {
            "capacity": self.capacity,
            "leased": len(self.leases),
            "queued": len(self.queue),
            "braked": self.braked,
            "memAvailable": self.platform.mem_available(),
            "memoryBytes": self.config.agent_mem_cap,
            "heldSecondsP50": _p50(self.held_ring),
            "waitSecondsP50": _p50(self.wait_ring),
            "refused": dict(self.refused),
            "holders": {client: lease.request_id for client, lease in self.leases.items()},
        }

    # -- writing ------------------------------------------------------------

    async def acquire(
        self,
        client: str,
        request_id: str,
        max_wait_ms: Optional[int],
        on_queued: Callable[[int], None],
    ) -> object:
        """Resolves to a Grant or a Refusal. Cancel it to leave the queue."""
        if client in self.leases or any(waiter.client == client for waiter in self.queue):
            return self.refuse(client, request_id, "already_holding")

        position = len(self.queue) + 1
        if max_wait_ms is not None:
            projected = self.projected_wait_seconds(position)
            if projected is not None and projected * 1000 > max_wait_ms:
                return self.refuse(client, request_id, "projected_wait_exceeds_ceiling")

        now = self.clock()
        deadline = now + max_wait_ms / 1000 if max_wait_ms is not None else None
        waiter = _Waiter(client, request_id, deadline, now, asyncio.get_running_loop().create_future(), on_queued)
        self.queue.append(waiter)
        self.pump()
        if not waiter.future.done():
            self._announce(waiter)
            self._ensure_ticker()
        try:
            return await waiter.future
        except asyncio.CancelledError:
            self._withdraw(waiter)
            raise

    def release(self, client: str) -> None:
        lease = self.leases.pop(client, None)
        if lease is None:
            return
        held = self.clock() - lease.granted_at
        self.held_ring.append(held)
        self.log("slotd.released", {"client": client, "requestId": lease.request_id, "heldSeconds": round(held, 3)})
        self.pump()

    def refuse(self, client: str, request_id: str, reason: str) -> Refusal:
        self.refused[reason] = self.refused.get(reason, 0) + 1
        self.log("slotd.refused", {"client": client, "requestId": request_id, "reason": reason})
        return Refusal(reason)

    def pump(self) -> None:
        """Grant to the head of the queue for as long as there is room, memory permitting."""
        self._expire()
        while self.queue and len(self.leases) < self.capacity:
            if self._brake_holds():
                if not self.braked:
                    self.braked = True
                    self.log("slotd.braked", {"memAvailable": self.platform.mem_available(), "threshold": self._brake_threshold()})
                self._ensure_ticker()
                return
            if self.braked:
                self.braked = False
                self.log("slotd.unbraked", {"memAvailable": self.platform.mem_available()})
            waiter = self.queue.popleft()
            now = self.clock()
            waited = now - waiter.enqueued_at
            self.leases[waiter.client] = _Lease(waiter.request_id, now)
            self.wait_ring.append(waited)
            self.log("slotd.granted", {"client": waiter.client, "requestId": waiter.request_id, "waitedSeconds": round(waited, 3), "leased": len(self.leases)})
            waiter.future.set_result(Grant(self.config.agent_mem_cap, waited))
        if not self.queue and self.braked:
            self.braked = False

    # -- internals ----------------------------------------------------------

    def _brake_threshold(self) -> int:
        return self.config.agent_mem_estimate + self.config.brake_margin

    def _brake_holds(self) -> bool:
        return self.platform.mem_available() < self._brake_threshold()

    def _announce(self, waiter: _Waiter) -> None:
        if waiter.announced:
            return
        waiter.announced = True
        waiter.on_queued(list(self.queue).index(waiter) + 1)

    def _withdraw(self, waiter: _Waiter) -> None:
        try:
            self.queue.remove(waiter)
        except ValueError:
            return
        self.log("slotd.withdrawn", {"client": waiter.client, "requestId": waiter.request_id})
        self.pump()

    def _expire(self) -> None:
        now = self.clock()
        for waiter in list(self.queue):
            if waiter.deadline is not None and now >= waiter.deadline:
                self.queue.remove(waiter)
                waiter.future.set_result(self.refuse(waiter.client, waiter.request_id, "projected_wait_exceeds_ceiling"))

    def _ensure_ticker(self) -> None:
        if self._ticker is None or self._ticker.done():
            self._ticker = asyncio.get_running_loop().create_task(self._tick())

    async def _tick(self) -> None:
        # Runs only while somebody waits: re-reads memory for the brake and
        # expires waiters whose ceiling passed with nothing else happening.
        while self.queue:
            await asyncio.sleep(self.config.tick_seconds)
            self.pump()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `OK` with 32 tests

- [ ] **Step 5: Commit**

```bash
git add ops/slotd/webamend_slotd.py ops/slotd/test_webamend_slotd.py
git commit -m "feat(slotd): FIFO broker with capacity, memory brake and early refusal

A lease is a future; cancelling it is leaving the queue. The brake holds the
head while MemAvailable is under estimate+margin and re-reads it every tick.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 4: The server — protocol, identity, socket, signals, `status` CLI

**Files:**
- Modify: `ops/slotd/webamend_slotd.py` (append)
- Modify: `ops/slotd/test_webamend_slotd.py` (append)

**Interfaces:**
- Produces: `class Server(config, platform, broker, log)` with `async handle(reader, writer)`; `listening_socket(config) -> socket.socket`; `current_capacity(config, platform, log) -> int`; `async serve(config, platform, log)`; `log_line(event, fields)`; `render_prom(status: dict) -> str`; `status_command(argv) -> int`; `main(argv) -> int`.
- Wire protocol (newline-delimited JSON):
  - `{"op":"acquire","requestId":"…","maxWaitMs":900000}` (`"client":"…"` only honored when `SLOTD_IDENTITY=claimed`)
  - `{"event":"queued","position":N}` · `{"event":"granted","memoryBytes":N}` · `{"event":"refused","reason":"already_holding|projected_wait_exceeds_ceiling|unknown_client|bad_request"}`
  - `{"op":"status"}` → the `Broker.status()` dict

- [ ] **Step 1: Write the failing tests**

```python
# append to ops/slotd/test_webamend_slotd.py
import json
import tempfile


class ServerHarness:
    """A real daemon on a temp socket, in-process, with a fake platform."""

    def __init__(self, capacity=2, identity="claimed", platform=None, config_env=None):
        self.dir = tempfile.TemporaryDirectory()
        env = {"SLOTD_SOCKET": os.path.join(self.dir.name, "s.sock"), "SLOTD_IDENTITY": identity}
        env.update(config_env or {})
        self.config = slotd.Config.from_env(env)
        self.config.tick_seconds = 0.01
        self.platform = platform or slotd.FakePlatform()
        self.events: list = []
        self.broker = slotd.Broker(self.config, self.platform, capacity, log=self.record)
        self.server_logic = slotd.Server(self.config, self.platform, self.broker, log=self.record)
        self.server = None

    def record(self, event, fields):
        self.events.append((event, fields))

    async def __aenter__(self):
        sock = slotd.listening_socket(self.config)
        self.server = await asyncio.start_unix_server(self.server_logic.handle, sock=sock)
        return self

    async def __aexit__(self, *exc):
        self.server.close()
        await self.server.wait_closed()
        self.dir.cleanup()

    async def connect(self):
        return await asyncio.open_unix_connection(self.config.socket_path)


async def send(writer, message):
    writer.write((json.dumps(message) + "\n").encode())
    await writer.drain()


async def receive(reader, timeout=2.0):
    line = await asyncio.wait_for(reader.readline(), timeout)
    return json.loads(line)


async def acquire(harness, client, request_id="r", max_wait_ms=None):
    reader, writer = await harness.connect()
    message = {"op": "acquire", "client": client, "requestId": request_id}
    if max_wait_ms is not None:
        message["maxWaitMs"] = max_wait_ms
    await send(writer, message)
    return reader, writer


class ServerProtocol(unittest.IsolatedAsyncioTestCase):
    async def test_a_client_below_capacity_is_granted_with_the_memory_cap(self):
        async with ServerHarness(capacity=1) as harness:
            reader, writer = await acquire(harness, "a", "req-1")
            self.assertEqual(await receive(reader), {"event": "granted", "memoryBytes": slotd.parse_size("800M")})
            self.assertEqual(harness.broker.status()["holders"], {"a": "req-1"})
            writer.close()

    async def test_closing_the_connection_releases_the_lease_and_promotes_the_next_waiter(self):
        async with ServerHarness(capacity=1) as harness:
            first_reader, first_writer = await acquire(harness, "a")
            await receive(first_reader)
            second_reader, second_writer = await acquire(harness, "b")
            self.assertEqual(await receive(second_reader), {"event": "queued", "position": 1})

            first_writer.close()
            await first_writer.wait_closed()
            self.assertEqual(await receive(second_reader), {"event": "granted", "memoryBytes": slotd.parse_size("800M")})
            self.assertEqual(harness.broker.status()["holders"], {"b": "r"})
            second_writer.close()

    async def test_a_waiter_that_hangs_up_is_withdrawn(self):
        async with ServerHarness(capacity=1) as harness:
            holder_reader, holder_writer = await acquire(harness, "a")
            await receive(holder_reader)
            leaver_reader, leaver_writer = await acquire(harness, "b")
            await receive(leaver_reader)
            stayer_reader, stayer_writer = await acquire(harness, "c")
            self.assertEqual(await receive(stayer_reader), {"event": "queued", "position": 2})

            leaver_writer.close()
            await leaver_writer.wait_closed()
            await asyncio.sleep(0.05)
            self.assertEqual(harness.broker.status()["queued"], 1)

            holder_writer.close()
            await holder_writer.wait_closed()
            self.assertEqual((await receive(stayer_reader))["event"], "granted")
            stayer_writer.close()

    async def test_a_refusal_is_answered_and_the_connection_closed(self):
        async with ServerHarness(capacity=1) as harness:
            reader, writer = await acquire(harness, "a")
            await receive(reader)
            again_reader, again_writer = await acquire(harness, "a")
            self.assertEqual(await receive(again_reader), {"event": "refused", "reason": "already_holding"})
            self.assertEqual(await again_reader.read(), b"")
            writer.close()

    async def test_a_malformed_request_is_refused_as_bad_request(self):
        async with ServerHarness() as harness:
            reader, writer = await harness.connect()
            writer.write(b"this is not json\n")
            await writer.drain()
            self.assertEqual(await receive(reader), {"event": "refused", "reason": "bad_request"})
            reader2, writer2 = await harness.connect()
            await send(writer2, {"op": "dance"})
            self.assertEqual(await receive(reader2), {"event": "refused", "reason": "bad_request"})

    async def test_status_answers_the_broker_picture(self):
        async with ServerHarness(capacity=3) as harness:
            reader, writer = await harness.connect()
            await send(writer, {"op": "status"})
            status = await receive(reader)
            self.assertEqual(status["capacity"], 3)
            self.assertEqual(status["leased"], 0)
            self.assertIn("memAvailable", status)


class ServerIdentity(unittest.IsolatedAsyncioTestCase):
    async def test_peer_mode_names_the_client_from_its_uid_and_ignores_what_it_claims(self):
        platform = slotd.FakePlatform(uid=1000, members=["malulev"], names={1000: "malulev"})
        async with ServerHarness(capacity=1, identity="peer", platform=platform) as harness:
            reader, writer = await acquire(harness, "someone-else", "req-9")
            self.assertEqual((await receive(reader))["event"], "granted")
            self.assertEqual(harness.broker.status()["holders"], {"malulev": "req-9"})
            writer.close()

    async def test_peer_mode_refuses_a_uid_that_is_not_an_enrolled_client(self):
        platform = slotd.FakePlatform(uid=1002, members=["malulev"], names={1002: "claude"})
        async with ServerHarness(capacity=1, identity="peer", platform=platform) as harness:
            reader, writer = await acquire(harness, "malulev")
            self.assertEqual(await receive(reader), {"event": "refused", "reason": "unknown_client"})
            self.assertEqual(harness.broker.status()["refused"], {"unknown_client": 1})
            self.assertIn(("slotd.unknown_client", {"uid": 1002, "name": "claude"}), harness.events)

    async def test_peer_mode_refuses_a_uid_with_no_name_at_all(self):
        platform = slotd.FakePlatform(uid=4242, members=["malulev"], names={})
        async with ServerHarness(capacity=1, identity="peer", platform=platform) as harness:
            reader, writer = await acquire(harness, "malulev")
            self.assertEqual(await receive(reader), {"event": "refused", "reason": "unknown_client"})

    async def test_peer_mode_against_the_real_kernel_sees_this_process(self):
        me = pwd_name()
        platform = slotd.FakePlatform(members=[me], names={os.getuid(): me})
        platform.peer_uid = slotd.detect_platform().peer_uid  # the one real call
        async with ServerHarness(capacity=1, identity="peer", platform=platform) as harness:
            reader, writer = await acquire(harness, "ignored")
            self.assertEqual((await receive(reader))["event"], "granted")
            self.assertEqual(list(harness.broker.status()["holders"]), [me])
            writer.close()

    async def test_claimed_mode_refuses_a_request_that_names_nobody(self):
        async with ServerHarness(capacity=1, identity="claimed") as harness:
            reader, writer = await harness.connect()
            await send(writer, {"op": "acquire", "requestId": "r"})
            self.assertEqual(await receive(reader), {"event": "refused", "reason": "unknown_client"})


class CapacityAtStartup(unittest.TestCase):
    def test_computed_from_the_group_size_unless_overridden(self):
        events = []
        platform = slotd.FakePlatform(mem_total=3819 * 1024 ** 2, cpu_count=2, members=["a", "b"])
        config = slotd.Config.from_env({})
        self.assertEqual(slotd.current_capacity(config, platform, lambda e, f: events.append((e, f))), 4)
        self.assertEqual(events[0][0], "slotd.capacity")
        self.assertEqual(events[0][1]["source"], "computed")
        self.assertEqual(events[0][1]["clients"], 2)

    def test_an_empty_group_counts_as_one_client(self):
        platform = slotd.FakePlatform(mem_total=3819 * 1024 ** 2, cpu_count=2, members=[])
        config = slotd.Config.from_env({})
        events = []
        slotd.current_capacity(config, platform, lambda e, f: events.append((e, f)))
        self.assertEqual(events[0][1]["clients"], 1)

    def test_overrides_win(self):
        platform = slotd.FakePlatform(members=["a"])
        config = slotd.Config.from_env({"SLOTD_CAPACITY": "9"})
        self.assertEqual(slotd.current_capacity(config, platform, lambda e, f: None), 9)
        config = slotd.Config.from_env({"SLOTD_CLIENTS": "20"})
        platform = slotd.FakePlatform(mem_total=3819 * 1024 ** 2, cpu_count=2, members=["a"])
        self.assertEqual(slotd.current_capacity(config, platform, lambda e, f: None), 1)


class PromRendering(unittest.TestCase):
    def test_renders_every_metric_with_known_reasons_present_at_zero(self):
        text = slotd.render_prom({
            "capacity": 4, "leased": 2, "queued": 6, "braked": True,
            "waitSecondsP50": 12.4, "heldSecondsP50": 40.0,
            "refused": {"already_holding": 1}, "memoryBytes": 5, "memAvailable": 9, "holders": {},
        })
        self.assertIn("webamend_slots_capacity 4\n", text)
        self.assertIn("webamend_slots_leased 2\n", text)
        self.assertIn("webamend_slots_queued 6\n", text)
        self.assertIn("webamend_slots_braked 1\n", text)
        self.assertIn("webamend_slots_wait_seconds_p50 12.4\n", text)
        self.assertIn('webamend_slots_refused_total{reason="already_holding"} 1\n', text)
        self.assertIn('webamend_slots_refused_total{reason="projected_wait_exceeds_ceiling"} 0\n', text)
        self.assertIn('webamend_slots_refused_total{reason="unknown_client"} 0\n', text)
        self.assertIn("# TYPE webamend_slots_capacity gauge\n", text)

    def test_omits_the_wait_percentile_before_there_is_one(self):
        text = slotd.render_prom({"capacity": 1, "leased": 0, "queued": 0, "braked": False,
                                  "waitSecondsP50": None, "heldSecondsP50": None, "refused": {},
                                  "memoryBytes": 5, "memAvailable": 9, "holders": {}})
        self.assertNotIn("webamend_slots_wait_seconds_p50", text)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `AttributeError: module 'webamend_slotd' has no attribute 'Server'`

- [ ] **Step 3: Write the server, the socket, capacity-at-startup, logging, CLI**

```python
# append to ops/slotd/webamend_slotd.py

# ---------------------------------------------------------------------------
# Server: the wire protocol and who is on the other end
# ---------------------------------------------------------------------------


def _json_line(payload: object) -> bytes:
    return (json.dumps(payload, separators=(",", ":")) + "\n").encode()


class Server:
    def __init__(self, config: Config, platform: Platform, broker: Broker, log: LogFn = _no_log) -> None:
        self.config = config
        self.platform = platform
        self.broker = broker
        self.log = log

    def identify(self, sock: socket.socket, message: Dict[str, object]) -> Optional[str]:
        """The client's name, or None if this connection may not take a slot."""
        if self.config.identity == "claimed":
            claimed = message.get("client")
            return str(claimed) if claimed else None
        uid = self.platform.peer_uid(sock)
        name = self.platform.uid_to_name(uid)
        if name is None or name not in self.platform.group_members(self.config.group):
            self.log("slotd.unknown_client", {"uid": uid, "name": name})
            return None
        return name

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        sock = writer.get_extra_info("socket")
        try:
            raw = await reader.readline()
            if not raw:
                return
            try:
                message = json.loads(raw)
            except ValueError:
                message = None
            if not isinstance(message, dict):
                writer.write(_json_line({"event": "refused", "reason": "bad_request"}))
                return

            operation = message.get("op")
            if operation == "status":
                writer.write(_json_line(self.broker.status()))
                await writer.drain()
                return
            if operation != "acquire":
                writer.write(_json_line({"event": "refused", "reason": "bad_request"}))
                return

            request_id = str(message.get("requestId", ""))
            client = self.identify(sock, message)
            if client is None:
                self.broker.refuse("?", request_id, "unknown_client")
                writer.write(_json_line({"event": "refused", "reason": "unknown_client"}))
                return

            raw_wait = message.get("maxWaitMs")
            max_wait_ms = int(raw_wait) if isinstance(raw_wait, (int, float)) and raw_wait > 0 else None

            def on_queued(position: int) -> None:
                writer.write(_json_line({"event": "queued", "position": position}))

            # The client sends nothing after `acquire`; the next thing on this
            # socket is its EOF, which is the lease ending — or the wait ending.
            hangup = asyncio.ensure_future(reader.read())
            decision = asyncio.ensure_future(self.broker.acquire(client, request_id, max_wait_ms, on_queued))
            done, _pending = await asyncio.wait({hangup, decision}, return_when=asyncio.FIRST_COMPLETED)
            if decision not in done:
                decision.cancel()
                try:
                    await decision
                except asyncio.CancelledError:
                    pass
                return

            outcome = decision.result()
            if isinstance(outcome, Refusal):
                hangup.cancel()
                writer.write(_json_line({"event": "refused", "reason": outcome.reason}))
                return

            writer.write(_json_line({"event": "granted", "memoryBytes": outcome.memory_bytes}))
            await writer.drain()
            try:
                await hangup
            finally:
                self.broker.release(client)
        finally:
            writer.close()


# ---------------------------------------------------------------------------
# Process: socket, capacity, signals, logging
# ---------------------------------------------------------------------------


def log_line(event: str, fields: Dict[str, object]) -> None:
    """One JSON object per line on stdout; journald keeps them."""
    record: Dict[str, object] = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event}
    record.update(fields)
    sys.stdout.write(json.dumps(record, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def listening_socket(config: Config) -> socket.socket:
    """systemd's socket when activated (fd 3), otherwise bind the path ourselves."""
    if os.environ.get("LISTEN_FDS") == "1" and os.environ.get("LISTEN_PID") == str(os.getpid()):
        return socket.socket(fileno=3)
    path = config.socket_path
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(path)
    # 0666 on purpose. Reachability is not authorization here: every connection
    # is identified by its peer credentials and refused unless that uid maps to
    # an enrolled client. A rootless container's process does not carry the
    # client's host group memberships, so a group-restricted socket would
    # refuse exactly the apps this serves.
    os.chmod(path, 0o666)
    sock.listen(64)
    return sock


def current_capacity(config: Config, platform: Platform, log: LogFn) -> int:
    if config.capacity_override is not None:
        capacity = config.capacity_override
        clients = config.clients_override
        source = "override"
    else:
        clients = config.clients_override
        if clients is None:
            clients = max(1, len(platform.group_members(config.group)))
        capacity = compute_capacity(platform.mem_total(), platform.cpu_count(), clients, config)
        source = "computed"
    log("slotd.capacity", {
        "capacity": capacity, "source": source, "clients": clients,
        "memTotal": platform.mem_total(), "cpuCount": platform.cpu_count(),
        "agentMemEstimate": config.agent_mem_estimate, "agentMemCap": config.agent_mem_cap,
    })
    return capacity


async def serve(config: Config, platform: Platform, log: LogFn) -> None:
    broker = Broker(config, platform, current_capacity(config, platform, log), log=log)
    logic = Server(config, platform, broker, log=log)
    server = await asyncio.start_unix_server(logic.handle, sock=listening_socket(config))

    loop = asyncio.get_running_loop()
    stopping: "asyncio.Future[None]" = loop.create_future()

    def on_hup() -> None:
        broker.capacity = current_capacity(config, platform, log)
        broker.pump()

    def on_stop() -> None:
        if not stopping.done():
            stopping.set_result(None)

    loop.add_signal_handler(signal.SIGHUP, on_hup)
    loop.add_signal_handler(signal.SIGTERM, on_stop)
    loop.add_signal_handler(signal.SIGINT, on_stop)

    log("slotd.started", {"socket": config.socket_path, "identity": config.identity, "capacity": broker.capacity})
    if config.identity == "claimed":
        log("slotd.identity_claimed", {"warning": "clients name themselves; for local testing only"})
    async with server:
        await stopping
    log("slotd.stopped", {})


# ---------------------------------------------------------------------------
# `status` command: what ops/probe.sh and ops/status.sh call
# ---------------------------------------------------------------------------

_KNOWN_REASONS = ("already_holding", "projected_wait_exceeds_ceiling", "unknown_client")


def render_prom(status: Dict[str, object]) -> str:
    lines: List[str] = []

    def gauge(name: str, help_text: str, value: object) -> None:
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name} {value}")

    gauge("webamend_slots_capacity", "Agent runs this host admits at once.", status["capacity"])
    gauge("webamend_slots_leased", "Agent runs holding a slot now.", status["leased"])
    gauge("webamend_slots_queued", "Requests waiting for a slot.", status["queued"])
    gauge("webamend_slots_braked", "1 while the memory brake holds the head of the queue.", 1 if status["braked"] else 0)
    if status.get("waitSecondsP50") is not None:
        gauge("webamend_slots_wait_seconds_p50", "Median wait of recent granted requests.", status["waitSecondsP50"])
    lines.append("# HELP webamend_slots_refused_total Requests refused since the daemon started, by reason.")
    lines.append("# TYPE webamend_slots_refused_total counter")
    refused = status.get("refused") or {}
    assert isinstance(refused, dict)
    for reason in sorted(set(_KNOWN_REASONS) | set(refused)):
        lines.append(f'webamend_slots_refused_total{{reason="{reason}"}} {refused.get(reason, 0)}')
    return "\n".join(lines) + "\n"


def status_command(argv: List[str]) -> int:
    path = Config.from_env().socket_path
    prom = False
    index = 0
    while index < len(argv):
        if argv[index] == "--socket" and index + 1 < len(argv):
            path = argv[index + 1]
            index += 2
        elif argv[index] == "--prom":
            prom = True
            index += 1
        else:
            sys.stderr.write("usage: webamend_slotd.py status [--socket PATH] [--prom]\n")
            return 2
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(path)
        sock.sendall(_json_line({"op": "status"}))
        data = b""
        while not data.endswith(b"\n"):
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    status = json.loads(data)
    if prom:
        sys.stdout.write(render_prom(status))
    else:
        sys.stdout.write(json.dumps(status, indent=2) + "\n")
    return 0


def main(argv: List[str]) -> int:
    if argv and argv[0] == "status":
        return status_command(argv[1:])
    if argv:
        sys.stderr.write("usage: webamend_slotd.py            # run the daemon (configuration from the environment)\n"
                         "       webamend_slotd.py status [--socket PATH] [--prom]\n")
        return 2
    asyncio.run(serve(Config.from_env(), detect_platform(), log_line))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `OK` with 48 tests

- [ ] **Step 5: Smoke the real process end to end**

Run:
```bash
SLOTD_SOCKET=/tmp/slotd-smoke.sock SLOTD_IDENTITY=claimed SLOTD_CAPACITY=1 python3 ops/slotd/webamend_slotd.py &
sleep 0.5
python3 ops/slotd/webamend_slotd.py status --socket /tmp/slotd-smoke.sock --prom | head -4
kill %1
```
Expected: three JSON log lines (`slotd.capacity`, `slotd.started`, `slotd.identity_claimed`), then `webamend_slots_capacity 1` among the metrics.

- [ ] **Step 6: Commit**

```bash
git add ops/slotd/webamend_slotd.py ops/slotd/test_webamend_slotd.py
git commit -m "feat(slotd): unix-socket server, peer-credential identity, status command

The connection is the lease. Identity comes from the kernel and is checked
against the webamend-slots group; the socket is 0666 because a rootless container
does not carry its user's host groups, and reachability is not authorization.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 5: The local stress harness

**Files:**
- Create: `ops/slotd/stress.py`
- Modify: `ops/slotd/test_webamend_slotd.py` (append one automated run with tiny sizes)
- Modify: `package.json` (scripts)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the daemon as a subprocess (`python3 ops/slotd/webamend_slotd.py` with `SLOTD_*` env) and the wire protocol from Task 4.
- Produces: `python3 ops/slotd/stress.py [--clients N] [--capacity C] [--agent-mb M] [--hold-seconds S] [--budget-mb B] [--brake-threshold-mb T]`; exit 0 iff the observed peak concurrency never exceeded `C`. Importable `run_stress(options) -> Summary` for the test.

- [ ] **Step 1: Write the failing test**

```python
# append to ops/slotd/test_webamend_slotd.py
import stress


class StressHarness(unittest.TestCase):
    """A tiny run: enough to prove the harness measures what it says it measures."""

    def test_a_small_run_never_exceeds_capacity_and_serves_everyone_in_order(self):
        summary = stress.run_stress(stress.Options(
            clients=4, capacity=2, agent_mb=8, hold_seconds=0.5, budget_mb=64,
            brake_threshold_mb=0, quiet=True,
        ))
        self.assertEqual(summary.peak_concurrent, 2)
        self.assertEqual(summary.granted_order, ["client-1", "client-2", "client-3", "client-4"])
        self.assertEqual(summary.refused, {})
        self.assertFalse(summary.over_capacity)

    def test_refuses_to_start_a_run_that_would_exceed_the_budget(self):
        with self.assertRaises(stress.BudgetExceeded):
            stress.run_stress(stress.Options(clients=2, capacity=2, agent_mb=100, hold_seconds=0.1, budget_mb=150,
                                             brake_threshold_mb=0, quiet=True))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `ModuleNotFoundError: No module named 'stress'`

- [ ] **Step 3: Write the harness**

```python
#!/usr/bin/env python3
"""
Local stress test for webamend-slotd.

Starts the daemon on a temp socket with a fixed capacity, then launches N
fake clients that each ask for a slot, allocate a real block of memory while
they hold it, and let go. Prints a timeline and the daemon's own view every
half second, then says whether the cap held.

Memory is bounded twice: the harness refuses to start unless
capacity x agent_mb fits inside --budget-mb, and every client frees its block
the moment its hold ends. Nothing here touches Docker.

    python3 ops/slotd/stress.py                       # 8 clients, capacity 4, 200 MB each
    python3 ops/slotd/stress.py --clients 10 --capacity 3 --agent-mb 300 --budget-mb 2048

--brake-threshold-mb sets the MemAvailable figure below which the daemon holds
the queue. Left unset, it is chosen so the brake trips once during the run —
when the last slot is about to be filled — so you can watch it hold and then
release as earlier clients finish. Pass 0 to disable the brake.
"""
from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import webamend_slotd as slotd  # noqa: E402

MB = 1024 ** 2
DAEMON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webamend_slotd.py")


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class Options:
    clients: int = 8
    capacity: int = 4
    agent_mb: int = 200
    hold_seconds: float = 8.0
    budget_mb: int = 0            # 0 = a quarter of this machine's RAM
    brake_threshold_mb: int = -1  # -1 = choose so the brake trips once; 0 = off
    max_wait_ms: int = 120_000
    quiet: bool = False


@dataclass
class Summary:
    peak_concurrent: int = 0
    granted_order: List[str] = field(default_factory=list)
    refused: Dict[str, int] = field(default_factory=dict)
    brake_tripped: bool = False
    over_capacity: bool = False


# ---------------------------------------------------------------------------
# One fake client (runs in its own process so its memory is really its own)
# ---------------------------------------------------------------------------


def _send(sock: socket.socket, payload: object) -> None:
    sock.sendall((json.dumps(payload) + "\n").encode())


def _read_line(sock: socket.socket, timeout: float) -> Optional[dict]:
    sock.settimeout(timeout)
    data = b""
    while not data.endswith(b"\n"):
        chunk = sock.recv(4096)
        if not chunk:
            return None
        data += chunk
    return json.loads(data)


def _touch(block: bytearray) -> None:
    # A calloc'd block costs nothing until it is written; one byte per page
    # makes the allocation real, which is the point.
    for offset in range(0, len(block), 4096):
        block[offset] = 1


def fake_client(name: str, socket_path: str, agent_mb: int, hold_seconds: float, max_wait_ms: int, events) -> None:
    started = time.monotonic()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(socket_path)
        _send(sock, {"op": "acquire", "client": name, "requestId": f"req-{name}", "maxWaitMs": max_wait_ms})
        while True:
            message = _read_line(sock, timeout=max_wait_ms / 1000 + 5)
            if message is None:
                events.put((name, "hung_up", time.monotonic() - started, ""))
                return
            if message["event"] == "queued":
                events.put((name, "queued", time.monotonic() - started, f"position {message['position']}"))
                continue
            if message["event"] == "refused":
                events.put((name, "refused", time.monotonic() - started, message["reason"]))
                return
            if message["event"] == "granted":
                events.put((name, "granted", time.monotonic() - started, f"cap {message['memoryBytes'] // MB} MB"))
                block = bytearray(agent_mb * MB)
                _touch(block)
                events.put((name, "allocated", time.monotonic() - started, f"{agent_mb} MB touched"))
                time.sleep(hold_seconds)
                del block
                events.put((name, "released", time.monotonic() - started, ""))
                return


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def _status(socket_path: str) -> Optional[dict]:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect(socket_path)
            _send(sock, {"op": "status"})
            return _read_line(sock, 2)
    except OSError:
        return None


def _choose_brake_threshold_mb(options: Options, available_now_mb: int) -> int:
    if options.brake_threshold_mb >= 0:
        return options.brake_threshold_mb
    # Trip when the last slot is about to be filled: after capacity-1 clients
    # have allocated, available memory sits about (capacity-1)*agent_mb below
    # now; a threshold half an agent above that point catches exactly that.
    return max(0, available_now_mb - (options.capacity - 1) * options.agent_mb + options.agent_mb // 2)


def run_stress(options: Options) -> Summary:
    platform = slotd.detect_platform()
    total_mb = platform.mem_total() // MB
    budget_mb = options.budget_mb or total_mb // 4
    needed_mb = options.capacity * options.agent_mb
    if needed_mb > budget_mb:
        raise BudgetExceeded(f"capacity {options.capacity} x {options.agent_mb} MB = {needed_mb} MB exceeds the budget of {budget_mb} MB")

    available_now_mb = platform.mem_available() // MB
    threshold_mb = _choose_brake_threshold_mb(options, available_now_mb)
    say = (lambda *a, **k: None) if options.quiet else print

    say(f"host: {total_mb} MB total, ~{available_now_mb} MB available now; budget {budget_mb} MB")
    say(f"run: {options.clients} clients, capacity {options.capacity}, {options.agent_mb} MB each, held {options.hold_seconds}s")
    say(f"brake: {'off' if threshold_mb == 0 else f'holds the queue while available < {threshold_mb} MB'}")
    say("")

    with tempfile.TemporaryDirectory() as directory:
        socket_path = os.path.join(directory, "slotd.sock")
        env = dict(os.environ)
        env.update({
            "SLOTD_SOCKET": socket_path,
            "SLOTD_IDENTITY": "claimed",
            "SLOTD_CAPACITY": str(options.capacity),
            "AGENT_MEM_ESTIMATE": f"{options.agent_mb}M",
            "AGENT_MEM_CAP": f"{options.agent_mb * 2}M",
            # threshold = estimate + margin, so margin = threshold - estimate
            "BRAKE_MARGIN": f"{max(0, threshold_mb - options.agent_mb)}M" if threshold_mb else "0",
        })
        if threshold_mb == 0:
            env["AGENT_MEM_ESTIMATE"] = "0"   # threshold 0: the brake can never hold
        daemon = subprocess.Popen([sys.executable, DAEMON], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not os.path.exists(socket_path):
                if time.monotonic() > deadline:
                    raise RuntimeError("daemon did not create its socket: " + daemon.stderr.read().decode())
                time.sleep(0.05)

            summary = Summary()
            events: "multiprocessing.Queue" = multiprocessing.Queue()
            workers = [
                multiprocessing.Process(
                    target=fake_client,
                    args=(f"client-{index}", socket_path, options.agent_mb, options.hold_seconds, options.max_wait_ms, events),
                )
                for index in range(1, options.clients + 1)
            ]
            started = time.monotonic()
            for worker in workers:
                worker.start()
                time.sleep(0.05)   # arrival order is the FIFO order we assert on

            stop_sampling = threading.Event()
            samples: List[dict] = []

            def sample() -> None:
                while not stop_sampling.is_set():
                    status = _status(socket_path)
                    if status:
                        samples.append(status)
                        summary.peak_concurrent = max(summary.peak_concurrent, status["leased"])
                        summary.brake_tripped = summary.brake_tripped or bool(status["braked"])
                        say(f"  [{time.monotonic() - started:5.1f}s] daemon: leased={status['leased']}/{status['capacity']} "
                            f"queued={status['queued']} braked={'yes' if status['braked'] else 'no'} "
                            f"available={status['memAvailable'] // MB} MB")
                    stop_sampling.wait(0.5)

            sampler = threading.Thread(target=sample, daemon=True)
            sampler.start()

            finished = 0
            while finished < options.clients:
                name, kind, at, detail = events.get(timeout=options.max_wait_ms / 1000 + 30)
                say(f"  [{at:5.1f}s] {name:<10} {kind:<10} {detail}")
                if kind == "granted":
                    summary.granted_order.append(name)
                if kind == "refused":
                    summary.refused[detail] = summary.refused.get(detail, 0) + 1
                if kind in ("released", "refused", "hung_up"):
                    finished += 1

            stop_sampling.set()
            sampler.join(timeout=2)
            for worker in workers:
                worker.join(timeout=5)

            final = _status(socket_path) or {}
            summary.over_capacity = summary.peak_concurrent > options.capacity
            say("")
            say(f"peak concurrent: {summary.peak_concurrent} (capacity {options.capacity}) -> {'OVER CAPACITY' if summary.over_capacity else 'held'}")
            say(f"granted order:   {', '.join(summary.granted_order)}")
            say(f"brake tripped:   {'yes' if summary.brake_tripped else 'no'}")
            say(f"refused:         {summary.refused or 'none'}")
            say(f"daemon totals:   {final.get('refused', {})}, median wait {final.get('waitSecondsP50')}s")
            return summary
        finally:
            daemon.terminate()
            daemon.wait(timeout=5)


def parse_args(argv: List[str]) -> Options:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--clients", type=int, default=8)
    parser.add_argument("--capacity", type=int, default=4)
    parser.add_argument("--agent-mb", type=int, default=200)
    parser.add_argument("--hold-seconds", type=float, default=8.0)
    parser.add_argument("--budget-mb", type=int, default=0, help="hard ceiling on capacity x agent-mb (default: a quarter of RAM)")
    parser.add_argument("--brake-threshold-mb", type=int, default=-1, help="hold the queue below this MemAvailable (default: trips once; 0 = off)")
    parser.add_argument("--max-wait-ms", type=int, default=120_000)
    args = parser.parse_args(argv)
    return Options(clients=args.clients, capacity=args.capacity, agent_mb=args.agent_mb, hold_seconds=args.hold_seconds,
                   budget_mb=args.budget_mb, brake_threshold_mb=args.brake_threshold_mb, max_wait_ms=args.max_wait_ms)


if __name__ == "__main__":
    summary = run_stress(parse_args(sys.argv[1:]))
    sys.exit(1 if summary.over_capacity else 0)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s ops/slotd -p 'test_*.py' 2>&1 | tail -3`
Expected: `OK` with 50 tests (the stress test takes ~2 s)

- [ ] **Step 5: Add the npm scripts and the CI step**

In `package.json`, after `"enroll:link"`:

```json
    "enroll:link": "tsx scripts/enroll-link.ts",
    "test:slotd": "python3 -m unittest discover -s ops/slotd -p 'test_*.py'",
    "stress:slotd": "python3 ops/slotd/stress.py"
```

In `.github/workflows/ci.yml`, after the `Integration tests` step:

```yaml
      # The admission daemon is Python, standard library only; ubuntu-latest
      # ships python3. Runs without root, Docker or a real socket path.
      - name: Slot daemon tests
        run: npm run test:slotd
```

Run: `npm run test:slotd 2>&1 | tail -2`
Expected: `OK`

- [ ] **Step 6: Run the real stress test on this Mac and read it**

Run: `npm run stress:slotd -- --clients 8 --capacity 4 --agent-mb 200 --hold-seconds 6`
Expected, in order: the host line; eight `queued`/`granted` lines with clients 5–8 queued at positions 1–4; daemon samples showing `leased=4/4 queued=4`; at some point `braked=yes` when the last slot would be filled, then `braked=no` as the first clients release; `peak concurrent: 4 (capacity 4) -> held`; `granted order: client-1 … client-8`; exit 0.

- [ ] **Step 7: Commit**

```bash
git add ops/slotd/stress.py ops/slotd/test_webamend_slotd.py package.json .github/workflows/ci.yml
git commit -m "feat(slotd): local stress harness with a memory budget

Fake clients allocate real memory while they hold a slot, so the brake trips
on real numbers; the harness refuses to start past --budget-mb.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

**Phase 1 checkpoint.** The user can now run `npm run stress:slotd` and watch the queue, the cap and the brake. Nothing in the app has changed yet.

---

## Phase 2 — the app asks the daemon

### Task 6: `SlotOutcome` learns to release; `run.ts` releases on every path

**Files:**
- Modify: `src/lib/runner/slots.ts`
- Modify: `src/lib/jobs/run.ts` (the `execute` function; `waitForSlot`; `runAgent` signature)
- Modify: `tests/unit/runner/slots.test.ts`
- Modify: `tests/integration/slots.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SlotOutcome =
    | { ok: true; waitedMs: number; memoryBytes?: number; release(): Promise<void> }
    | { ok: false; waitedMs: number; reason?: string };
  export interface AgentSlots {
    acquire(options?: { onWait?: () => void; requestId?: string }): Promise<SlotOutcome>;
  }
  ```
- Consumes: nothing new. `RunRequest.memoryBytes` is added in Task 7; this task passes it through `runAgent` as a parameter only.

- [ ] **Step 1: Write the failing unit test**

Replace the `UNLIMITED_SLOTS` block in `tests/unit/runner/slots.test.ts`:

```ts
describe('UNLIMITED_SLOTS', () => {
  it('never waits, never announces a wait, and hands back a release that does nothing', async () => {
    const onWait = vi.fn();
    const outcome = await UNLIMITED_SLOTS.acquire({ onWait, requestId: 'r1' });
    expect(outcome.ok).toBe(true);
    expect(outcome.waitedMs).toBe(0);
    expect(onWait).not.toHaveBeenCalled();
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.memoryBytes).toBeUndefined();
    await expect(outcome.release()).resolves.toBeUndefined();
    await expect(outcome.release()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the failing integration tests**

In `tests/integration/slots.test.ts`, update the two fakes and add a third plus a helper, then add a `describe`:

```ts
/** Slots that make the caller wait once, then let it through. */
function slotsThatQueueOnce(): AgentSlots & { readonly waits: number } {
  let waits = 0;
  return {
    get waits() {
      return waits;
    },
    async acquire(options) {
      waits += 1;
      options?.onWait?.();
      return { ok: true, waitedMs: 0, release: async () => {} };
    },
  };
}

const slotsThatNeverFree: AgentSlots = {
  async acquire(options) {
    options?.onWait?.();
    return { ok: false, waitedMs: 15 * 60_000 };
  },
};

const slotsThatRefuse: AgentSlots = {
  async acquire() {
    return { ok: false, waitedMs: 40, reason: 'projected_wait_exceeds_ceiling' };
  },
};

/** Slots that count releases and hand the run a memory cap, like a lease daemon would. */
function slotsThatLease(): AgentSlots & { readonly releases: number; readonly requestIds: string[] } {
  let releases = 0;
  const requestIds: string[] = [];
  return {
    get releases() {
      return releases;
    },
    requestIds,
    async acquire(options) {
      if (options?.requestId) requestIds.push(options.requestId);
      return {
        ok: true,
        waitedMs: 0,
        memoryBytes: 838_860_800,
        release: async () => {
          releases += 1;
        },
      };
    },
  };
}
```

and append:

```ts
describe('a leased slot', () => {
  it('is released exactly once when the request succeeds, and the run gets the memory cap', async () => {
    const slots = slotsThatLease();
    harness = await createHarness({ script: editsTheHomepage, slots, previewTimeoutMs: 500 });
    const pullRequest = await openConversation(harness.client);

    const begun = await beginRequest(harness.deps, {
      conversationNumber: pullRequest.number,
      branch: pullRequest.headRef,
      baseBranch: 'main',
      message: 'Shorten the headline',
      history: [],
    });
    if (!begun.started) throw new Error('the request should have started');
    await begun.completed;

    expect(slots.releases).toBe(1);
    expect(slots.requestIds).toEqual([begun.requestId]);
    expect(harness.runner.calls[0]?.memoryBytes).toBe(838_860_800);
  });

  it('is released exactly once when the agent fails', async () => {
    const slots = slotsThatLease();
    harness = await createHarness({ script: { outcome: 'completed', exitCode: 1 }, slots });
    const pullRequest = await openConversation(harness.client);

    const outcome = await runRequest(harness.deps, {
      conversationNumber: pullRequest.number,
      branch: pullRequest.headRef,
      baseBranch: 'main',
      message: 'Shorten the headline',
      history: [],
    });

    expect(outcome.started && outcome.outcome).toBe('failed');
    expect(slots.releases).toBe(1);
  });

  it('records the daemon\'s reason when refused, while the client sees the busy sentence', async () => {
    harness = await createHarness({ script: editsTheHomepage, slots: slotsThatRefuse });
    const pullRequest = await openConversation(harness.client);

    const outcome = await runRequest(harness.deps, {
      conversationNumber: pullRequest.number,
      branch: pullRequest.headRef,
      baseBranch: 'main',
      message: 'Shorten the headline',
      history: [],
    });

    expect(outcome.started && outcome.outcome).toBe('failed');
    expect(harness.runner.calls).toHaveLength(0);
    const parsed = parseComment((await harness.client.listComments(pullRequest.number)).at(-1)!);
    expect(parsed.record?.errorCode).toBe('too_busy');
    expect(parsed.record?.errorDetail).toBe('the host refused an agent slot: projected_wait_exceeds_ceiling');
    expect(parsed.prose).toBe(CLIENT_MESSAGES.too_busy);
    // No queued stage: a refusal is immediate.
    expect(parsed.record?.stages.map((event) => event.stage)).toEqual(['failed']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: type errors — `requestId` is not a known option; `release` does not exist on `{ ok: true; waitedMs: number }`.

- [ ] **Step 4: Change the interface**

In `src/lib/runner/slots.ts`, replace `SlotOutcome`, `AgentSlots` and `UNLIMITED_SLOTS`:

```ts
/**
 * `waitedMs` on both branches, not only on failure.
 *
 * It used to exist only when a request gave up, which meant capacity pressure
 * was invisible until it became an outright refusal — the one point at which
 * it is too late to act on. A request that waited eight minutes and then ran
 * is the early warning.
 *
 * A granted slot carries `release`, because a lease held by an open socket
 * has to be given back; `memoryBytes` is the cap the host wants on this run,
 * when the host has an opinion. A refusal may carry the host's `reason`,
 * which goes into the durable record and never into client prose.
 */
export type SlotOutcome =
  | { ok: true; waitedMs: number; memoryBytes?: number; release(): Promise<void> }
  | { ok: false; waitedMs: number; reason?: string };

export interface AgentSlots {
  /**
   * Resolves once the host has room. `onWait` fires once, the first time the
   * caller actually has to wait, so the orchestrator can announce a `queued`
   * stage only to a request that queued. `requestId` is for correlating the
   * host's log with this installation's; nothing is decided on it.
   */
  acquire(options?: { onWait?: () => void; requestId?: string }): Promise<SlotOutcome>;
}

/** No admission control: every request runs at once, and there is nothing to give back. */
export const UNLIMITED_SLOTS: AgentSlots = {
  acquire: async () => ({ ok: true, waitedMs: 0, release: async () => {} }),
};
```

- [ ] **Step 5: Hoist, release, propagate in `run.ts`**

In `execute`, add the hoisted handle next to `tree`/`controlDir`:

```ts
  let tree: WorkingTree | null = null;
  let controlDir: string | null = null;
  // Held for the agent's whole run and given back in `finally`, whatever the
  // ending: a slot released anywhere else leaks host capacity on the failure
  // paths, and leaked capacity is a host that quietly stops admitting anyone.
  let slot: SlotOutcome | null = null;
```

Replace the slot block:

```ts
    slot = await waitForSlot(deps, machine, requestId);
    if (!slot.ok) {
      return finish(deps, input, machine, {
        requestId,
        startedAt,
        model,
        outcome: 'failed',
        errorCode: 'too_busy',
        errorDetail: slot.reason
          ? `the host refused an agent slot: ${slot.reason}`
          : `no agent slot became free within ${Math.round(slot.waitedMs / 60_000)} minutes`,
        prose: null,
      });
    }

    machine.advance('running');
    const agent = await runAgent(deps, requestId, prepared, model, slot.memoryBytes);
```

In the `finally`, before `await handle.release();`:

```ts
    if (slot?.ok) await slot.release();
```

Change `waitForSlot` to pass the request id:

```ts
  const outcome = await deps.slots.acquire({ onWait: () => machine.advance('queued'), requestId });
```

and its log line gains the reason:

```ts
    log.info('slot.waited', {
      requestId,
      waitedMs: outcome.waitedMs,
      granted: outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason ?? 'timeout' }),
    });
```

Change `runAgent`'s signature and the runner call:

```ts
async function runAgent(
  deps: RunDeps,
  requestId: string,
  prepared: Prepared,
  model: string,
  memoryBytes?: number,
): Promise<AgentPass> {
  ...
  const run = await deps.runner.run({
    requestId,
    workDir: prepared.tree.dir,
    controlDir: prepared.controlDir,
    prompt: prepared.prompt,
    model,
    timeoutMs,
    memoryBytes,
    onOutput: (text) => {
```

`memoryBytes` on `RunRequest` does not exist until Task 7. To keep this task green on its own, add it to `src/lib/runner/types.ts` now:

```ts
  timeoutMs: number;
  /**
   * Memory cap for the container, when the host that admitted this run set
   * one (the lease daemon hands it over with the grant). Absent, no cap.
   */
  memoryBytes?: number;
  /** Called for each line of container stdout. Best effort; may be dropped. */
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsc --noEmit && npx vitest run tests/unit/runner/slots.test.ts tests/integration/slots.test.ts 2>&1 | grep -E "Test Files|Tests "`
Expected: `Test Files 2 passed`, all tests passing (2 + 6).

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: everything passes (the `slot.waited` log shape change touches no test).

- [ ] **Step 8: Commit**

```bash
git add src/lib/runner/slots.ts src/lib/runner/types.ts src/lib/jobs/run.ts tests/unit/runner/slots.test.ts tests/integration/slots.test.ts
git commit -m "feat(slots): a granted slot is released on every ending

SlotOutcome gains release, memoryBytes and reason; run.ts hoists the slot and
gives it back in the finally beside the site lock. Refusal reasons reach the
record, never the client.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 7: The container honours the grant's cap and yields CPU

**Files:**
- Modify: `src/lib/runner/docker.ts`
- Modify: `tests/unit/runner/isolation.test.ts`

**Interfaces:**
- Consumes: `RunRequest.memoryBytes?: number` (Task 6).
- Produces: `export const AGENT_CPU_SHARES = 512`.

- [ ] **Step 1: Write the failing tests**

Replace the test `bounds the process count one agent run may take, and leaves memory uncapped` in `tests/unit/runner/isolation.test.ts` with two:

```ts
  it('applies the memory cap the host handed over with the grant, and yields CPU to the apps', async () => {
    const calls: Docker.ContainerCreateOptions[] = [];
    const runner = createDockerRunner({
      image: 'webagent-agent:test',
      apiKey: 'or-key-abc123',
      docker: createFakeDocker(calls),
    });
    const request: RunRequest = {
      requestId: 'req-3',
      workDir: '/srv/webagent/jobs/req-3/work',
      controlDir: '/srv/webagent/jobs/req-3/control',
      prompt: samplePrompt,
      model: 'openrouter/anthropic/claude-sonnet-latest',
      timeoutMs: 10_000,
      memoryBytes: 838_860_800,
    };

    await runner.run(request);

    const host = calls[0]?.HostConfig;
    // The cap comes from the admission daemon's grant, so capacity and cap
    // share one configuration and cannot drift apart. Equal MemorySwap, or
    // the cap is a suggestion the container can swap past.
    expect(host?.Memory).toBe(838_860_800);
    expect(host?.MemorySwap).toBe(838_860_800);
    // Half the default weight: when CPU saturates, client apps and the reverse
    // proxy win. The most direct answer to "without impairing existing ones".
    expect(host?.CpuShares).toBe(512);
    expect(host?.PidsLimit).toBe(512);
    expect(host?.CapDrop).toEqual(['ALL']);
    expect(host?.SecurityOpt).toEqual(['no-new-privileges']);
  });

  it('leaves memory uncapped when no host set one, and still yields CPU', async () => {
    const calls: Docker.ContainerCreateOptions[] = [];
    const runner = createDockerRunner({
      image: 'webagent-agent:test',
      apiKey: 'or-key-abc123',
      docker: createFakeDocker(calls),
    });
    const request: RunRequest = {
      requestId: 'req-4',
      workDir: '/srv/webagent/jobs/req-4/work',
      controlDir: '/srv/webagent/jobs/req-4/control',
      prompt: samplePrompt,
      model: 'openrouter/anthropic/claude-sonnet-latest',
      timeoutMs: 10_000,
    };

    await runner.run(request);

    const host = calls[0]?.HostConfig;
    // No daemon (a development machine, or fail-open): today's behaviour.
    expect(host?.Memory).toBeUndefined();
    expect(host?.MemorySwap).toBeUndefined();
    expect(host?.CpuShares).toBe(512);
    expect(host?.PidsLimit).toBe(512);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/runner/isolation.test.ts 2>&1 | grep -E "✓|✗|×|Tests "`
Expected: the first new test fails on `Memory` (received `undefined`), the second on `CpuShares`.

- [ ] **Step 3: Apply the cap and the CPU weight**

In `src/lib/runner/docker.ts`, next to `AGENT_PIDS_LIMIT`:

```ts
/** Enough for node plus the agent's own children; far below the host's table. */
export const AGENT_PIDS_LIMIT = 512;

/**
 * Half the default weight (1024). When the CPUs saturate — and on the
 * measured host they did at four agents — the kernel gives client apps and
 * the reverse proxy twice an agent's share, so the sites stay responsive
 * through the burst. Weight, not a quota: an idle host still gives an agent
 * everything.
 */
export const AGENT_CPU_SHARES = 512;
```

Replace the memory comment block and `PidsLimit` line inside `HostConfig`:

```ts
      // The memory cap is not this module's opinion. The admission daemon
      // (ops/slotd) hands each run its cap with the grant, so how many agents
      // fit and how big each may get come from one configuration on the host
      // and cannot drift apart. No grant — a development machine, or the
      // daemon unreachable — means no cap, which is exactly today's behavior.
      // `MemorySwap` equal to `Memory`, or the cap is a suggestion the
      // container can swap past.
      ...(request.memoryBytes ? { Memory: request.memoryBytes, MemorySwap: request.memoryBytes } : {}),
      CpuShares: AGENT_CPU_SHARES,
      // `PidsLimit` bounds a fork bomb, which exhausts the host's process
      // table rather than this cgroup — no memory figure would have.
      PidsLimit: AGENT_PIDS_LIMIT,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/runner 2>&1 | grep -E "Test Files|Tests "`
Expected: all runner tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/runner/docker.ts tests/unit/runner/isolation.test.ts
git commit -m "feat(runner): apply the grant's memory cap and run agents at half CPU weight

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 8: `createLeaseSlots` — the app-side client

**Files:**
- Create: `src/lib/runner/lease-slots.ts`
- Create: `tests/unit/runner/lease-slots.test.ts`
- Modify: `src/lib/log/events.ts`

**Interfaces:**
- Consumes: `AgentSlots`, `SlotOutcome` (Task 6); the wire protocol (Task 4).
- Produces:
  ```ts
  export interface CreateLeaseSlotsOptions {
    socketPath: string;
    fallback: AgentSlots;
    maxWaitMs?: number;   // default 15 min; sent to the daemon so it can refuse early
    now?: () => number;
  }
  export function createLeaseSlots(options: CreateLeaseSlotsOptions): AgentSlots
  ```
  and the log event `'slots.broker_unavailable'`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/runner/lease-slots.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLeaseSlots } from '@/lib/runner/lease-slots';
import type { AgentSlots } from '@/lib/runner/slots';

/**
 * The app's side of the lease protocol, against a scripted daemon on a real
 * unix socket: what it sends, how it maps each answer, and — the part that
 * keeps a dead daemon from becoming an outage — when it falls back.
 */

type Script = (line: string, socket: Socket) => void;

interface FakeBroker {
  path: string;
  received: string[];
  closes: number;
  close(): Promise<void>;
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function fakeBroker(script: Script): Promise<FakeBroker> {
  const dir = await mkdtemp(join(tmpdir(), 'lease-'));
  const path = join(dir, 's.sock');
  const received: string[] = [];
  const state = { closes: 0 };
  const server: Server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        received.push(line);
        script(line, socket);
        index = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => {
      state.closes += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const broker: FakeBroker = {
    path,
    received,
    get closes() {
      return state.closes;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }).then(() => rm(dir, { recursive: true, force: true })),
  };
  cleanup.push(broker.close);
  return broker;
}

function fallbackSpy(): AgentSlots & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async acquire() {
      calls += 1;
      return { ok: true, waitedMs: 0, release: async () => {} };
    },
  };
}

const reply = (socket: Socket, payload: object) => socket.write(JSON.stringify(payload) + '\n');

describe('createLeaseSlots', () => {
  it('sends acquire with the request id and the ceiling, and maps a grant with its cap', async () => {
    const broker = await fakeBroker((_line, socket) => reply(socket, { event: 'granted', memoryBytes: 838860800 }));
    const fallback = fallbackSpy();
    const slots = createLeaseSlots({ socketPath: broker.path, fallback, maxWaitMs: 900_000 });
    const onWait = vi.fn();

    const outcome = await slots.acquire({ onWait, requestId: 'req-7' });

    expect(JSON.parse(broker.received[0]!)).toEqual({ op: 'acquire', requestId: 'req-7', maxWaitMs: 900_000 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.memoryBytes).toBe(838860800);
    expect(onWait).not.toHaveBeenCalled();
    expect(fallback.calls).toBe(0);
  });

  it('holds the connection open until release, then closes it, and release is idempotent', async () => {
    const broker = await fakeBroker((_line, socket) => reply(socket, { event: 'granted', memoryBytes: 1 }));
    const slots = createLeaseSlots({ socketPath: broker.path, fallback: fallbackSpy() });

    const outcome = await slots.acquire();
    if (!outcome.ok) throw new Error('unreachable');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broker.closes).toBe(0);

    await outcome.release();
    await outcome.release();
    await vi.waitFor(() => expect(broker.closes).toBe(1));
  });

  it('announces the wait exactly once however many queued events arrive, then resolves on grant', async () => {
    const broker = await fakeBroker((_line, socket) => {
      reply(socket, { event: 'queued', position: 3 });
      setTimeout(() => reply(socket, { event: 'queued', position: 1 }), 5);
      setTimeout(() => reply(socket, { event: 'granted', memoryBytes: 1 }), 15);
    });
    const slots = createLeaseSlots({ socketPath: broker.path, fallback: fallbackSpy(), now: (() => { let t = 0; return () => (t += 10); })() });
    const onWait = vi.fn();

    const outcome = await slots.acquire({ onWait });

    expect(onWait).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
    expect(outcome.waitedMs).toBeGreaterThan(0);
  });

  it('maps a refusal to a failed outcome carrying the reason', async () => {
    const broker = await fakeBroker((_line, socket) => reply(socket, { event: 'refused', reason: 'already_holding' }));
    const fallback = fallbackSpy();
    const slots = createLeaseSlots({ socketPath: broker.path, fallback });

    const outcome = await slots.acquire();

    expect(outcome).toEqual({ ok: false, waitedMs: expect.any(Number), reason: 'already_holding' });
    expect(fallback.calls).toBe(0);
  });

  it('falls back when there is no socket at the path', async () => {
    const fallback = fallbackSpy();
    const slots = createLeaseSlots({ socketPath: '/nonexistent/dir/slotd.sock', fallback });
    const onWait = vi.fn();

    const outcome = await slots.acquire({ onWait, requestId: 'r' });

    expect(outcome.ok).toBe(true);
    expect(fallback.calls).toBe(1);
    expect(onWait).not.toHaveBeenCalled();
  });

  it('falls back when the daemon hangs up before deciding', async () => {
    const broker = await fakeBroker((_line, socket) => {
      reply(socket, { event: 'queued', position: 2 });
      setTimeout(() => socket.destroy(), 5);
    });
    const fallback = fallbackSpy();
    const slots = createLeaseSlots({ socketPath: broker.path, fallback });

    const outcome = await slots.acquire();

    expect(outcome.ok).toBe(true);
    expect(fallback.calls).toBe(1);
  });

  it('falls back when the daemon answers nonsense', async () => {
    const broker = await fakeBroker((_line, socket) => socket.write('not json\n'));
    const fallback = fallbackSpy();
    const slots = createLeaseSlots({ socketPath: broker.path, fallback });

    await slots.acquire();

    expect(fallback.calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/runner/lease-slots.test.ts 2>&1 | tail -5`
Expected: `Failed to resolve import "@/lib/runner/lease-slots"`

- [ ] **Step 3: Register the log event**

In `src/lib/log/events.ts`, under `// Capacity.`:

```ts
  // Capacity.
  | 'slot.waited'
  | 'slots.count_failed'
  // The admission daemon could not be reached or stopped answering; the
  // request ran under the fallback. Protection degraded, availability kept.
  | 'slots.broker_unavailable'
```

- [ ] **Step 4: Write the client**

```ts
// src/lib/runner/lease-slots.ts
import { connect } from 'node:net';
import { log } from '@/lib/log';
import type { AgentSlots, SlotOutcome } from './slots';

/**
 * The app's side of the host admission queue (ops/slotd/webamend_slotd.py; design
 * in docs/superpowers/specs/2026-09-14-host-admission-queue-design.md).
 *
 * One connection per request. `acquire` is sent, the daemon answers `queued`
 * zero or more times and then exactly one of `granted` or `refused`, and a
 * granted request keeps the socket open for the agent's whole run: the
 * connection is the lease, so a crashed app is a freed slot rather than a
 * stale one.
 *
 * Fail-open. A daemon that cannot be reached, hangs up before deciding, or
 * answers something unparseable is logged and the `fallback` decides instead.
 * Refusing every request because the arbiter is down would turn a monitoring
 * fault into an outage for every client on the host.
 */

export interface CreateLeaseSlotsOptions {
  socketPath: string;
  fallback: AgentSlots;
  /** Sent to the daemon so it can refuse at once a wait that could never end in time. */
  maxWaitMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_WAIT_MS = 15 * 60_000;

type BrokerEvent =
  | { event: 'queued'; position: number }
  | { event: 'granted'; memoryBytes?: number }
  | { event: 'refused'; reason: string };

type Negotiation =
  | { kind: 'granted'; memoryBytes?: number; release(): Promise<void> }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable'; error: string };

function parseEvent(line: string): BrokerEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || !('event' in parsed)) return null;
    return parsed as BrokerEvent;
  } catch {
    return null;
  }
}

function negotiate(
  socketPath: string,
  requestId: string | undefined,
  maxWaitMs: number,
  onWait: (() => void) | undefined,
): Promise<Negotiation> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = '';
    let announced = false;
    let settled = false;

    const settle = (outcome: Negotiation) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const release = async () => {
      socket.destroy();
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ op: 'acquire', requestId, maxWaitMs }) + '\n');
    });
    socket.on('error', (error) => settle({ kind: 'unavailable', error: error.message }));
    socket.on('close', () => settle({ kind: 'unavailable', error: 'the daemon closed the connection before deciding' }));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        const event = parseEvent(line);
        if (!event) {
          settle({ kind: 'unavailable', error: `unparseable answer: ${line.slice(0, 80)}` });
          socket.destroy();
          return;
        }
        if (event.event === 'queued') {
          if (!announced) {
            announced = true;
            onWait?.();
          }
        } else if (event.event === 'granted') {
          settle({ kind: 'granted', memoryBytes: event.memoryBytes, release });
        } else if (event.event === 'refused') {
          settle({ kind: 'refused', reason: event.reason });
          socket.destroy();
        }
      }
    });
  });
}

export function createLeaseSlots(options: CreateLeaseSlotsOptions): AgentSlots {
  const now = options.now ?? Date.now;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  return {
    async acquire(acquireOptions = {}): Promise<SlotOutcome> {
      const startedAt = now();
      const lease = await negotiate(options.socketPath, acquireOptions.requestId, maxWaitMs, acquireOptions.onWait);
      const waitedMs = now() - startedAt;

      if (lease.kind === 'unavailable') {
        log.error('slots.broker_unavailable', {
          requestId: acquireOptions.requestId ?? '',
          socketPath: options.socketPath,
          error: lease.error,
        });
        return options.fallback.acquire(acquireOptions);
      }
      if (lease.kind === 'refused') {
        return { ok: false, waitedMs, reason: lease.reason };
      }
      return { ok: true, waitedMs, memoryBytes: lease.memoryBytes, release: lease.release };
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsc --noEmit && npx vitest run tests/unit/runner/lease-slots.test.ts 2>&1 | grep -E "Tests "`
Expected: `Tests 7 passed`

- [ ] **Step 6: Commit**

```bash
git add src/lib/runner/lease-slots.ts src/lib/log/events.ts tests/unit/runner/lease-slots.test.ts
git commit -m "feat(slots): createLeaseSlots, the app's client of the admission daemon

Connection-scoped lease over a unix socket; falls back to the given AgentSlots
when the daemon is unreachable, hangs up early, or answers nonsense.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 9: Configuration and wiring

**Files:**
- Modify: `src/lib/config/env.ts`
- Modify: `src/types/index.ts`
- Modify: `src/lib/installation.ts`
- Modify: `tests/unit/config/env.test.ts`

**Interfaces:**
- Produces: `Env.slotBrokerSocket?: string` from `SLOT_BROKER_SOCKET`.
- Consumes: `createLeaseSlots` (Task 8), `UNLIMITED_SLOTS`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/config/env.test.ts`, where the removed `MAX_CONCURRENT_RUNS` block was (after `expect(lineCount).toBeGreaterThanOrEqual(3); });`), add:

```ts
  describe('SLOT_BROKER_SOCKET', () => {
    it('is absent when unset, so the installation runs without a host queue', () => {
      expect(parseEnv(validRawEnv()).slotBrokerSocket).toBeUndefined();
    });

    it('reads the socket path', () => {
      expect(parseEnv({ ...validRawEnv(), SLOT_BROKER_SOCKET: '/run/webamend/slotd.sock' }).slotBrokerSocket).toBe(
        '/run/webamend/slotd.sock',
      );
    });

    it('rejects an empty value rather than silently disabling the queue', () => {
      expect(() => parseEnv({ ...validRawEnv(), SLOT_BROKER_SOCKET: '' })).toThrow(/SLOT_BROKER_SOCKET/);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/config/env.test.ts 2>&1 | grep -E "Tests "`
Expected: 2 of the 3 fail (`slotBrokerSocket` is not on `Env`; the empty value is accepted).

- [ ] **Step 3: Add the setting**

`src/lib/config/env.ts`, in `rawEnvSchema` after `PUBLIC_BASE_URL`:

```ts
  PUBLIC_BASE_URL: z.url({ message: 'must be a valid absolute URL' }),
  /**
   * The host admission daemon's socket, as seen from inside the container
   * (docker-compose.yml mounts /run/webamend at the same path). Unset means no
   * host-wide queue: a development machine, or a host not yet upgraded.
   */
  SLOT_BROKER_SOCKET: z.string().min(1, 'must be a socket path when set').optional(),
```

and in `toEnv`:

```ts
    publicBaseUrl: data.PUBLIC_BASE_URL,
    slotBrokerSocket: data.SLOT_BROKER_SOCKET,
```

`src/types/index.ts`, after `publicBaseUrl: string;`:

```ts
  publicBaseUrl: string;
  /** Unix socket of the host admission daemon; absent, requests run without a host queue. */
  slotBrokerSocket?: string;
```

- [ ] **Step 4: Wire it**

`src/lib/installation.ts`:

```ts
import { createLeaseSlots } from '@/lib/runner/lease-slots';
import { type AgentSlots, UNLIMITED_SLOTS } from '@/lib/runner/slots';
```

and replace the `slots:` line and its comment:

```ts
    // Host-wide admission, when the host runs the lease daemon (ops/slotd).
    // Each installation serves one site and the site lock bounds it to one
    // run, so without the daemon there is nothing to wait for here; with it,
    // every client on the host queues in one line. Fail-open: a daemon that
    // cannot be reached degrades to today's behaviour, never to an outage.
    slots: env.slotBrokerSocket
      ? createLeaseSlots({ socketPath: env.slotBrokerSocket, fallback: UNLIMITED_SLOTS })
      : UNLIMITED_SLOTS,
```

- [ ] **Step 5: Run the tests and the suite**

Run: `npx tsc --noEmit && npx eslint src/lib tests/unit/runner tests/unit/config && npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/config/env.ts src/types/index.ts src/lib/installation.ts tests/unit/config/env.test.ts
git commit -m "feat(config): SLOT_BROKER_SOCKET wires the admission daemon into an installation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

**Phase 2 checkpoint.** With `SLOT_BROKER_SOCKET` unset nothing has changed; with it set to a running daemon, the app queues. Verifiable locally: start the daemon with `SLOTD_IDENTITY=claimed` — no, the app sends no `client` field, so use the real kernel: `SLOTD_SOCKET=/tmp/s.sock SLOTD_IDENTITY=peer SLOTD_GROUP=staff SLOTD_CAPACITY=1 python3 ops/slotd/webamend_slotd.py` on a Mac (your uid is in `staff`), then `SLOT_BROKER_SOCKET=/tmp/s.sock npm run dev`.

---

## Phase 3 — the host runs it

### Task 10: Units, environment file, Compose mount, bootstrap and provisioning

**Files:**
- Create: `ops/slotd/systemd/webamend-slotd.socket`, `ops/slotd/systemd/webamend-slotd.service`
- Create: `ops/slotd/slots.env.example`
- Modify: `docker-compose.yml` (volumes)
- Modify: `ops/bootstrap-host.sh` (new `install_slotd`, called from `main` after `install_monitoring`)
- Modify: `ops/provision-client.sh` (new `enroll_in_slots`, called from `main` after `enable_linger`; `SLOT_BROKER_SOCKET` in the skeleton)

**Interfaces:**
- Consumes: the daemon (Task 4), `SLOT_BROKER_SOCKET` (Task 9).
- Produces: on a bootstrapped host, `/run/webamend/slotd.sock` served by `webamend-slotd.socket`; each provisioned client is a member of `webamend-slots` and has `SLOT_BROKER_SOCKET=/run/webamend/slotd.sock` in its `.env`.

- [ ] **Step 1: The units**

```ini
# ops/slotd/systemd/webamend-slotd.socket
[Unit]
Description=Webamend host admission queue (socket)
Documentation=file:///opt/webamend/src/docs/superpowers/specs/2026-09-14-host-admission-queue-design.md

[Socket]
ListenStream=/run/webamend/slotd.sock
# 0666 is deliberate: reachability is not authorization. The daemon identifies
# every connection by SO_PEERCRED and refuses any uid that is not an enrolled
# client. A rootless container's process does not carry its user's host group
# memberships, so a group-restricted socket would refuse the apps it serves.
SocketMode=0666
DirectoryMode=0755

[Install]
WantedBy=sockets.target
```

```ini
# ops/slotd/systemd/webamend-slotd.service
[Unit]
Description=Webamend host admission queue
Documentation=file:///opt/webamend/src/docs/superpowers/specs/2026-09-14-host-admission-queue-design.md
Requires=webamend-slotd.socket
After=webamend-slotd.socket

[Service]
ExecStart=/usr/bin/python3 /opt/webamend/src/ops/slotd/webamend_slotd.py
# Every tunable, with its default and the measurement behind it, in
# ops/slotd/slots.env.example. Absent file, spec defaults.
EnvironmentFile=-/etc/webamend/slots.env
DynamicUser=yes
# The daemon needs to read the group's membership, nothing else.
SupplementaryGroups=webamend-slots
# The admission controller is the last thing that should die when memory is short.
OOMScoreAdjust=-900
Restart=on-failure
RestartSec=2
# SIGHUP recomputes capacity; provision-client.sh sends it after enrolling a client.
ExecReload=/bin/kill -HUP $MAINPID
```

- [ ] **Step 2: The environment file**

```bash
# ops/slotd/slots.env.example
# Tunables for webamend-slotd, the host admission queue. Copy to /etc/webamend/slots.env
# (root, 0644 — nothing here is secret) and `systemctl reload webamend-slotd`.
# Every default is what the daemon uses when this file is absent.
#
# Sizes take K, M, G. Measurements: docs/superpowers/specs/2026-09-14-host-admission-queue-design.md

# What one agent run holds while working. Measured 388–399 MB on 2026-09-14.
#AGENT_MEM_ESTIMATE=400M

# The cap handed to each run with its grant: twice the working set, so it
# binds a runaway and never a normal run.
#AGENT_MEM_CAP=800M

# One client's app container at rest. next-server measured at 149 MB.
#APP_RSS_ESTIMATE=160M

# Root, Caddy, the registry, sshd and page cache.
#HOST_RESERVE=600M

# Agents per core. Load 4.05 on 2 vCPU was survivable; 8 agents was not.
#CPU_OVERSUBSCRIBE=2.0

# Headroom kept beyond one agent's estimate before a free slot is granted.
# The brake holds the head of the queue while MemAvailable < estimate + margin.
#BRAKE_MARGIN=200M

# Force the client count or the capacity instead of computing them. For a
# host whose clients are not all enrolled yet, or to hold a number steady.
#SLOTD_CLIENTS=
#SLOTD_CAPACITY=
```

- [ ] **Step 3: The Compose mount**

In `docker-compose.yml`, after the `WEBAGENT_STATE_DIR` volume line:

```yaml
      - ${WEBAGENT_STATE_DIR:-/var/lib/webagent}:${WEBAGENT_STATE_DIR:-/var/lib/webagent}
      # The host admission daemon's socket directory. The directory, not the
      # socket: a bind mount of a missing file makes Docker create a directory
      # with the socket's name, while a missing directory is harmless and
      # lets the socket appear later. Same path both sides, like the state
      # dir, so SLOT_BROKER_SOCKET in .env is right on the host and in here.
      - ${SLOT_BROKER_DIR:-/run/webamend}:/run/webamend
```

Run: `docker compose -f docker-compose.yml config --quiet 2>&1 | grep -v "variable is not set"; echo "exit ${PIPESTATUS[0]}"`
Expected: `exit 0`

- [ ] **Step 4: Bootstrap installs it**

In `ops/bootstrap-host.sh`, after `install_monitoring()`:

```bash
# The host admission queue: one daemon, socket-activated, unprivileged. The
# `webamend-slots` group is both its authorization list and its client count;
# provision-client.sh enrols each client. Python 3 is present on every
# supported host image; the daemon is standard library only.
install_slotd() {
  command -v python3 >/dev/null || die "python3 is required for webamend-slotd; apt-get install -y python3"
  getent group webamend-slots >/dev/null || groupadd --system webamend-slots
  install -d -m 755 /run/webamend /etc/webamend
  [ -f /etc/webamend/slots.env ] || install -m 644 "${SCRIPT_DIR}/slotd/slots.env.example" /etc/webamend/slots.env
  local unit
  for unit in webamend-slotd.socket webamend-slotd.service; do
    sed "s#/opt/webamend/src#${SCRIPT_DIR%/ops}#g" "${SCRIPT_DIR}/slotd/systemd/${unit}" \
      >"/etc/systemd/system/${unit}"
  done
  systemctl daemon-reload
  systemctl enable --now webamend-slotd.socket
  note "webamend-slotd listening on /run/webamend/slotd.sock; capacity: python3 ${SCRIPT_DIR}/slotd/webamend_slotd.py status"
}
```

and in `main`, after `install_monitoring`:

```bash
  install_monitoring
  install_slotd
```

Check `SCRIPT_DIR` is defined in the script (it is used by `install_monitoring`). Run: `bash -n ops/bootstrap-host.sh && echo ok`
Expected: `ok`

- [ ] **Step 5: Provisioning enrols the client**

In `ops/provision-client.sh`, after `enable_linger()`'s definition:

```bash
# Membership of webamend-slots is what lets this client's uid take a slot from the
# admission daemon, and what the daemon counts when it sizes capacity. The
# reload recomputes capacity for the new count; harmless if the daemon is not
# installed.
enroll_in_slots() {
  if ! getent group webamend-slots >/dev/null; then
    note "webamend-slots group absent (host bootstrapped before the admission queue); skipping enrolment"
    return 0
  fi
  usermod -aG webamend-slots "$SLUG" || die "could not add ${SLUG} to webamend-slots"
  systemctl reload webamend-slotd.service 2>/dev/null || true
  note "enrolled ${SLUG} in webamend-slots"
}
```

In `main`, after `enable_linger`:

```bash
  enable_linger
  enroll_in_slots
```

In `write_env_skeleton`'s heredoc, after the `DOCKER_SOCK` line:

```bash
# This client's own rootless daemon. Its authority is user ${SLUG}, not root.
DOCKER_SOCK=/run/user/${uid}/docker.sock

# The host admission queue. Same path on the host and in the container
# (docker-compose.yml mounts /run/webamend). Remove the line to run without it.
SLOT_BROKER_SOCKET=/run/webamend/slotd.sock
```

Run: `bash -n ops/provision-client.sh && echo ok`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add ops/slotd/systemd ops/slotd/slots.env.example docker-compose.yml ops/bootstrap-host.sh ops/provision-client.sh
git commit -m "ops: install webamend-slotd under systemd and enrol each client

Socket-activated, DynamicUser, OOMScoreAdjust -900. The webamend-slots group is
the authorization list and the client count. Compose mounts /run/webamend.

docker-compose.yml carries a pre-existing uncommitted hunk unrelated to this
change; it rides along here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

### Task 11: Metrics, status line, alerts, documentation

**Files:**
- Modify: `ops/probe.sh`
- Modify: `ops/status.sh`
- Modify: `ops/monitoring/grafana/alert-rules.md`
- Modify: `ops/monitoring/grafana/dashboard-health.json`
- Modify: `ops/MONITORING.md`
- Modify: `ops/README.md`

**Interfaces:**
- Consumes: `python3 ops/slotd/webamend_slotd.py status --prom` (Task 4).
- Produces: `webamend_slots_*` in the textfile collector; a `SLOTS` line in `ops/status.sh`.

- [ ] **Step 1: probe.sh appends the daemon's metrics**

In `ops/probe.sh`, after the block that appends `webamend_probe_last_success_timestamp_seconds` and before `chmod 644 "$tmp"`:

```bash
# The admission daemon's own view. Absent socket: no lines, no failure — a
# host without the daemon is not a broken host. A socket that does not answer
# is a fault worth the line below, but still not a reason to publish nothing.
if [ -S /run/webamend/slotd.sock ]; then
  if ! python3 "${SCRIPT_DIR}/slotd/webamend_slotd.py" status --socket /run/webamend/slotd.sock --prom >>"$tmp" 2>/dev/null; then
    echo "probe: webamend-slotd did not answer on /run/webamend/slotd.sock" >&2
    {
      echo '# HELP webamend_slots_up 1 when the admission daemon answered.'
      echo '# TYPE webamend_slots_up gauge'
      echo 'webamend_slots_up 0'
    } >>"$tmp"
  else
    {
      echo '# HELP webamend_slots_up 1 when the admission daemon answered.'
      echo '# TYPE webamend_slots_up gauge'
      echo 'webamend_slots_up 1'
    } >>"$tmp"
  fi
fi
```

- [ ] **Step 2: status.sh prints a SLOTS line**

In `ops/status.sh`, after the `TOTAL agent containers…` two `echo` lines:

```bash
  if [ -S /run/webamend/slotd.sock ]; then
    if slots_json="$(python3 "${SCRIPT_DIR}/slotd/webamend_slotd.py" status --socket /run/webamend/slotd.sock 2>/dev/null)"; then
      echo "SLOTS $(printf '%s' "$slots_json" | python3 -c 'import json,sys; s=json.load(sys.stdin); print(f"capacity {s[\"capacity\"]}, leased {s[\"leased\"]}, queued {s[\"queued\"]}, braked {\"yes\" if s[\"braked\"] else \"no\"}, refused {sum(s[\"refused\"].values())}")')"
    else
      echo "SLOTS daemon socket present but not answering — systemctl status webamend-slotd"
    fi
  else
    echo "SLOTS no admission daemon on this host (ops/bootstrap-host.sh installs it); ceiling is the client count above"
  fi
```

Check `SCRIPT_DIR` exists in `status.sh` (`grep -n SCRIPT_DIR ops/status.sh`); if not, add near the top: `SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"`.

Run: `bash -n ops/status.sh ops/probe.sh && echo ok`
Expected: `ok`

- [ ] **Step 3: Alerts and dashboard switch to the daemon's capacity**

`ops/monitoring/grafana/alert-rules.md` — replace row A5 and add two rows after A5b:

```markdown
| A5 | RAM vs agent ceiling | `node_memory_MemAvailable_bytes{project="webamend"} < (webamend_slots_capacity or webamend_clients_total) * 419430400` | 15m | The demand line is what the host admits at once (`webamend_slots_capacity`) times the measured ~400 MB per agent; before the daemon is installed it falls back to the client count, since each client can run one. `for: 15m` so a run finishing does not page. |
| A5b | RAM hard floor | `node_memory_MemAvailable_bytes{project="webamend"} < 300e6` | 5m | The immediate form of A5. No swap on this box: this is an OOM countdown. |
| A5c | Queue never drains | `webamend_slots_queued > 0` | 10m | Capacity pressure: demand exceeds what the host admits for ten straight minutes. Add RAM or another host; or the estimates in /etc/webamend/slots.env are too conservative. |
| A5d | Requests turned away | `increase(webamend_slots_refused_total{reason="projected_wait_exceeds_ceiling"}[1h]) > 0` | instant | A client was told "busy" because the projected wait exceeded 15 minutes. The host is under-sized for its clients; A5c will already be firing. |
| A5e | Admission daemon down | `webamend_slots_up == 0` | 5m | The app falls back to no host cap; protection is gone until the daemon answers. `systemctl status webamend-slotd`. |
```

`ops/monitoring/grafana/dashboard-health.json` — in panel id 5, replace target B's `expr` and `legendFormat`:

```json
          "expr": "(webamend_slots_capacity{project=\"webamend\"} or webamend_clients_total{project=\"webamend\"}) * 419430400",
          "legendFormat": "agent demand at capacity"
```

and update its `description` to:

```json
      "description": "No swap on this box. The demand line is what the admission daemon admits at once (webamend_slots_capacity; before it is installed, the client count) times the ~400 MB a measured agent run holds. When available crosses below it, the ceiling is wrong for this host.",
```

Run: `python3 -c "import json;json.load(open('ops/monitoring/grafana/dashboard-health.json'));print('ok')"`
Expected: `ok`

- [ ] **Step 4: Documentation**

`ops/MONITORING.md` — in the "What to look at" list, after the memory line, add:

```markdown
- **`webamend_slots_queued` and `webamend_slots_refused_total`** — the admission queue's early warning. Queued for minutes means clients are waiting on each other; refused means one was told to come back later. Both say "more RAM or another host".
```

`ops/README.md` — replace the section `### 2. The host's agent ceiling is the number of clients` with:

```markdown
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
```

- [ ] **Step 5: Verify and commit**

Run: `bash -n ops/status.sh ops/probe.sh && python3 -c "import json;json.load(open('ops/monitoring/grafana/dashboard-health.json'))" && npm run test:slotd 2>&1 | tail -1 && npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: all clean and green.

```bash
git add ops/probe.sh ops/status.sh ops/monitoring/grafana/alert-rules.md ops/monitoring/grafana/dashboard-health.json ops/MONITORING.md ops/README.md
git commit -m "ops: webamend_slots_* metrics, SLOTS status line, alerts and docs for the admission queue

ops/status.sh and ops/README.md carry pre-existing uncommitted hunks
unrelated to this change; they ride along here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NE8JfZUuxbvYCbLd8YfYTG"
```

---

## Rollout on the host (not part of the plan's automated steps)

Per the spec's Rollout section, after the branch is merged and released:

1. `cd /opt/webamend/src && bash ops/bootstrap-host.sh` (idempotent; installs the daemon), then `python3 ops/slotd/webamend_slotd.py status` — expect `"capacity": 4`.
2. For each existing client: `usermod -aG webamend-slots <slug>`, add `SLOT_BROKER_SOCKET=/run/webamend/slotd.sock` to `/srv/webamend/<slug>/.env`, `systemctl reload webamend-slotd`, recreate the app container.
3. Run one change on one client; confirm a `slotd.granted` line in `journalctl -u webamend-slotd` with that client's name from `SO_PEERCRED`.
4. Re-run the 2026-09-14 stress procedure **through the app** (not `docker run` directly) and confirm `webamend_slots_leased` never exceeds 4 and `MemAvailable` never approaches zero.

---

## Self-review

**Spec coverage.** Capacity formula → Task 1. Platform/identity/`SO_PEERCRED`/subuid → Task 2, Task 4. FIFO, one lease per client, brake, early refusal, ring, status → Task 3, Task 4. Protocol incl. `memoryBytes` in the grant → Task 4, Task 8. `SlotOutcome.release`, release in `finally`, refusal reason in `errorDetail`, client copy unchanged → Task 6. `Memory`/`MemorySwap`/`CpuShares` → Task 7. `createLeaseSlots` with fail-open → Task 8. `SLOT_BROKER_SOCKET` and wiring → Task 9. systemd (`DynamicUser`, `OOMScoreAdjust`), Compose mount, enrolment, `SIGHUP` → Task 10. `webamend_slots_*`, alerts, `SLOTS` line, docs → Task 11. Local stress test in a budget → Task 5. Two deliberate deviations from the spec are recorded in Global Constraints (socket mode `0666`; directory mount).

**Placeholder scan.** None. Every step has its code.

**Type consistency.** `SlotOutcome` shape (Task 6) is what `createLeaseSlots` returns (Task 8) and what `run.ts` reads (Task 6). `RunRequest.memoryBytes` is added in Task 6 and consumed in Task 7. `acquire`'s `requestId` option is defined in Task 6, sent in Task 8, passed in Task 6's `waitForSlot`. Python names — `Config`, `compute_capacity`, `FakePlatform`, `Broker.held_ring`, `Server`, `listening_socket`, `current_capacity`, `render_prom` — are used in tests exactly as defined. The harness reads `status["leased"|"queued"|"braked"|"memAvailable"|"capacity"]`, all present in `Broker.status()`.
