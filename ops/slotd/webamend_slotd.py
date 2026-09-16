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
    # Test and demo only: while this file exists and holds an integer, it is
    # what mem_available() reports. Lets a harness show the brake holding and
    # releasing through the real process without guessing what the OS will do.
    mem_available_file: Optional[str] = None
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
        config.mem_available_file = source.get("SLOTD_MEM_AVAILABLE_FILE") or None
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


class OverridablePlatform(Platform):
    """Delegates everything; mem_available() comes from a file while one exists (tests and demos)."""

    def __init__(self, inner: Platform, path: str) -> None:
        self.inner = inner
        self.path = path

    def mem_total(self) -> int:
        return self.inner.mem_total()

    def mem_available(self) -> int:
        try:
            with open(self.path, encoding="utf8") as handle:
                text = handle.read().strip()
            if text:
                return int(text)
        except (OSError, ValueError):
            pass
        return self.inner.mem_available()

    def cpu_count(self) -> int:
        return self.inner.cpu_count()

    def peer_uid(self, sock: socket.socket) -> int:
        return self.inner.peer_uid(sock)

    def group_members(self, group: str) -> List[str]:
        return self.inner.group_members(group)

    def uid_to_name(self, uid: int) -> Optional[str]:
        return self.inner.uid_to_name(uid)


def detect_platform() -> Platform:
    return DarwinPlatform() if sys.platform == "darwin" else LinuxPlatform()


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
    config = Config.from_env()
    platform: Platform = detect_platform()
    if config.mem_available_file:
        platform = OverridablePlatform(platform, config.mem_available_file)
        log_line("slotd.memory_overridden", {"path": config.mem_available_file, "warning": "for local testing only"})
    asyncio.run(serve(config, platform, log_line))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
