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

--brake chooses how the memory brake is exercised:

  inject   (default) one second before the first wave of clients lets go, the
           daemon is fed a low MemAvailable reading through a file it watches
           (SLOTD_MEM_AVAILABLE_FILE); you see it hold the queue with a slot
           free, then grant when the reading is withdrawn. Deterministic. The
           real process, real sockets, real queue — only the number is chosen,
           because an OS's "available" figure (macOS especially) does not fall
           one-for-one with what clients allocate, so a natural trip cannot be
           arranged reliably.
  natural  real readings only; --brake-threshold-mb sets the figure below
           which the queue holds (default: a guess that trips when the last
           slot is about to fill — may or may not, depending on the OS).
  off      no brake.
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
    brake: str = "inject"         # inject | natural | off
    brake_threshold_mb: int = -1  # natural mode: -1 = guess; else the figure
    brake_inject_seconds: float = 3.0
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


def fake_client(name: str, socket_path: str, agent_mb: int, hold_seconds: float, max_wait_ms: int, events, started: float) -> None:
    # `started` is the harness's wall-clock reference, so every process's
    # timestamps land on one timeline. (monotonic bases differ per process on
    # macOS; a few milliseconds of wall-clock drift over a 20-second run do not.)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(socket_path)
        _send(sock, {"op": "acquire", "client": name, "requestId": f"req-{name}", "maxWaitMs": max_wait_ms})
        while True:
            message = _read_line(sock, timeout=max_wait_ms / 1000 + 5)
            if message is None:
                events.put((name, "hung_up", time.time() - started, ""))
                return
            if message["event"] == "queued":
                events.put((name, "queued", time.time() - started, f"position {message['position']}"))
                continue
            if message["event"] == "refused":
                events.put((name, "refused", time.time() - started, message["reason"]))
                return
            if message["event"] == "granted":
                block = bytearray(agent_mb * MB)
                _touch(block)
                events.put((name, "allocated", time.time() - started, f"{agent_mb} MB touched (cap {message['memoryBytes'] // MB} MB)"))
                time.sleep(hold_seconds)
                del block
                events.put((name, "released", time.time() - started, ""))
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
    if options.brake == "off":
        return 0
    if options.brake == "inject":
        # Below any dip the run itself can cause — every slot's worth of
        # allocation plus one more — so real readings never trip it and the
        # only hold you see is the injected one.
        return max(1, available_now_mb - (options.capacity + 1) * options.agent_mb)
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
    if options.brake == "off":
        say("brake: off")
    elif options.brake == "inject":
        say(f"brake: holds the queue while available < {threshold_mb} MB; a reading of "
            f"{threshold_mb - options.agent_mb} MB will be injected for {options.brake_inject_seconds}s "
            f"starting {max(0.0, options.hold_seconds - 1.0):.1f}s in")
    else:
        say(f"brake: natural; holds the queue while available < {threshold_mb} MB")
    say("")

    with tempfile.TemporaryDirectory() as directory:
        socket_path = os.path.join(directory, "slotd.sock")
        mem_file = os.path.join(directory, "mem_available")
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
        if options.brake == "inject":
            env["SLOTD_MEM_AVAILABLE_FILE"] = mem_file
        # The daemon's own log is the record of what it decided, in the order
        # it decided it: clients reporting "granted" race each other across
        # processes and can arrive out of order when several are granted at once.
        daemon_log = open(os.path.join(directory, "slotd.log"), "w+")
        daemon = subprocess.Popen([sys.executable, DAEMON], env=env, stdout=daemon_log, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not os.path.exists(socket_path):
                if time.monotonic() > deadline:
                    raise RuntimeError("daemon did not create its socket: " + daemon.stderr.read().decode())
                time.sleep(0.05)

            summary = Summary()
            events: "multiprocessing.Queue" = multiprocessing.Queue()
            started = time.time()
            workers = [
                multiprocessing.Process(
                    target=fake_client,
                    args=(f"client-{index}", socket_path, options.agent_mb, options.hold_seconds, options.max_wait_ms, events, started),
                )
                for index in range(1, options.clients + 1)
            ]

            stop_sampling = threading.Event()
            samples: List[dict] = []
            tail = open(daemon_log.name, encoding="utf8")

            def read_daemon_log() -> None:
                """Prints the daemon's decisions as it makes them, in its order, and records them."""
                while True:
                    line = tail.readline()
                    if not line:
                        return
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    event = record.get("event")
                    at = time.time() - started
                    if event == "slotd.granted":
                        summary.granted_order.append(str(record["client"]))
                        summary.peak_concurrent = max(summary.peak_concurrent, int(record["leased"]))
                        say(f"  [{at:5.1f}s] daemon     granted    {record['client']} (waited {record['waitedSeconds']:.1f}s, leased {record['leased']})")
                    elif event == "slotd.refused":
                        reason = str(record.get("reason"))
                        summary.refused[reason] = summary.refused.get(reason, 0) + 1
                        say(f"  [{at:5.1f}s] daemon     refused    {record.get('client')}: {reason}")
                    elif event == "slotd.braked":
                        summary.brake_tripped = True
                        say(f"  [{at:5.1f}s] daemon     BRAKE      holding the queue: available {record['memAvailable'] // MB} MB < {record['threshold'] // MB} MB")
                    elif event == "slotd.unbraked":
                        say(f"  [{at:5.1f}s] daemon     brake off  available {record['memAvailable'] // MB} MB")

            def follow() -> None:
                # Its own cadence: a decision should print within 100 ms of
                # being made, not at the next half-second status sample.
                while not stop_sampling.is_set():
                    read_daemon_log()
                    stop_sampling.wait(0.1)

            def sample() -> None:
                while not stop_sampling.is_set():
                    status = _status(socket_path)
                    if status:
                        # Display only: peak concurrency and brake trips are
                        # taken from the daemon's log, which misses nothing.
                        samples.append(status)
                        say(f"  [{time.time() - started:5.1f}s] daemon: leased={status['leased']}/{status['capacity']} "
                            f"queued={status['queued']} braked={'yes' if status['braked'] else 'no'} "
                            f"available={status['memAvailable'] // MB} MB")
                    stop_sampling.wait(0.5)

            sampler = threading.Thread(target=sample, daemon=True)
            follower = threading.Thread(target=follow, daemon=True)
            sampler.start()
            follower.start()

            for worker in workers:
                worker.start()
                time.sleep(0.05)   # arrival order is the FIFO order we assert on

            timers: List[threading.Timer] = []
            if options.brake == "inject":
                injected_mb = threshold_mb - options.agent_mb

                def inject() -> None:
                    with open(mem_file, "w") as handle:
                        handle.write(str(injected_mb * MB))
                    say(f"  [{time.time() - started:5.1f}s] harness    inject     available now reported as {injected_mb} MB (< {threshold_mb} MB)")

                def withdraw() -> None:
                    try:
                        os.unlink(mem_file)
                    except FileNotFoundError:
                        pass
                    say(f"  [{time.time() - started:5.1f}s] harness    withdraw   real readings resume")

                inject_at = max(0.0, options.hold_seconds - 1.0)
                timers = [threading.Timer(inject_at, inject), threading.Timer(inject_at + options.brake_inject_seconds, withdraw)]
                for timer in timers:
                    timer.daemon = True
                    timer.start()

            finished = 0
            while finished < options.clients:
                name, kind, at, detail = events.get(timeout=options.max_wait_ms / 1000 + 30)
                say(f"  [{at:5.1f}s] {name:<10} {kind:<10} {detail}")
                if kind in ("released", "refused", "hung_up"):
                    finished += 1

            stop_sampling.set()
            sampler.join(timeout=2)
            follower.join(timeout=2)
            for timer in timers:
                timer.cancel()
            for worker in workers:
                worker.join(timeout=5)

            final = _status(socket_path) or {}
            time.sleep(0.2)          # let the daemon's last log lines land
            read_daemon_log()
            tail.close()
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
            daemon_log.close()


def parse_args(argv: List[str]) -> Options:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--clients", type=int, default=8)
    parser.add_argument("--capacity", type=int, default=4)
    parser.add_argument("--agent-mb", type=int, default=200)
    parser.add_argument("--hold-seconds", type=float, default=8.0)
    parser.add_argument("--budget-mb", type=int, default=0, help="hard ceiling on capacity x agent-mb (default: a quarter of RAM)")
    parser.add_argument("--brake", choices=("inject", "natural", "off"), default="inject")
    parser.add_argument("--brake-threshold-mb", type=int, default=-1, help="natural mode: hold the queue below this MemAvailable")
    parser.add_argument("--brake-inject-seconds", type=float, default=3.0, help="inject mode: how long the low reading is held")
    parser.add_argument("--max-wait-ms", type=int, default=120_000)
    args = parser.parse_args(argv)
    return Options(clients=args.clients, capacity=args.capacity, agent_mb=args.agent_mb, hold_seconds=args.hold_seconds,
                   budget_mb=args.budget_mb, brake=args.brake, brake_threshold_mb=args.brake_threshold_mb,
                   brake_inject_seconds=args.brake_inject_seconds, max_wait_ms=args.max_wait_ms)


if __name__ == "__main__":
    summary = run_stress(parse_args(sys.argv[1:]))
    sys.exit(1 if summary.over_capacity else 0)
