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


# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------
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


def pwd_name() -> str:
    import pwd
    return pwd.getpwuid(os.getuid()).pw_name


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


class OverridablePlatformReadsAFile(unittest.TestCase):
    def test_reports_the_file_while_it_holds_a_number_and_the_real_reading_otherwise(self):
        import tempfile
        inner = slotd.FakePlatform(mem_available=999)
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "mem")
            wrapped = slotd.OverridablePlatform(inner, path)
            self.assertEqual(wrapped.mem_available(), 999)          # absent
            with open(path, "w") as handle:
                handle.write("123\n")
            self.assertEqual(wrapped.mem_available(), 123)          # present
            with open(path, "w") as handle:
                handle.write("garbage")
            self.assertEqual(wrapped.mem_available(), 999)          # unparseable
            open(path, "w").close()
            self.assertEqual(wrapped.mem_available(), 999)          # empty
            os.unlink(path)
            self.assertEqual(wrapped.mem_available(), 999)          # gone again
        self.assertEqual(wrapped.mem_total(), inner.mem_total())
        self.assertEqual(wrapped.cpu_count(), inner.cpu_count())

    def test_config_reads_the_override_path(self):
        self.assertIsNone(slotd.Config.from_env({}).mem_available_file)
        self.assertIsNone(slotd.Config.from_env({"SLOTD_MEM_AVAILABLE_FILE": ""}).mem_available_file)
        self.assertEqual(slotd.Config.from_env({"SLOTD_MEM_AVAILABLE_FILE": "/tmp/m"}).mem_available_file, "/tmp/m")


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


# ---------------------------------------------------------------------------
# Broker
# ---------------------------------------------------------------------------
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
        # Granted at once is a wait of zero, and a median of zero is a fact
        # worth reporting, not an absence of data.
        self.assertEqual(status["waitSecondsP50"], 0.0)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# Stress harness
# ---------------------------------------------------------------------------
import stress


class StressHarness(unittest.TestCase):
    """A tiny run: enough to prove the harness measures what it says it measures."""

    def test_a_small_run_never_exceeds_capacity_and_serves_everyone_in_order(self):
        summary = stress.run_stress(stress.Options(
            clients=4, capacity=2, agent_mb=8, hold_seconds=0.5, budget_mb=64, brake="off", quiet=True,
        ))
        self.assertEqual(summary.peak_concurrent, 2)
        self.assertEqual(summary.granted_order, ["client-1", "client-2", "client-3", "client-4"])
        self.assertEqual(summary.refused, {})
        self.assertFalse(summary.brake_tripped)
        self.assertFalse(summary.over_capacity)

    def test_an_injected_memory_dip_holds_the_queue_and_everyone_is_still_served_in_order(self):
        summary = stress.run_stress(stress.Options(
            clients=3, capacity=2, agent_mb=8, hold_seconds=1.0, budget_mb=64,
            brake="inject", brake_inject_seconds=1.0, quiet=True,
        ))
        self.assertTrue(summary.brake_tripped)
        self.assertEqual(summary.granted_order, ["client-1", "client-2", "client-3"])
        self.assertEqual(summary.refused, {})
        self.assertFalse(summary.over_capacity)

    def test_refuses_to_start_a_run_that_would_exceed_the_budget(self):
        with self.assertRaises(stress.BudgetExceeded):
            stress.run_stress(stress.Options(clients=2, capacity=2, agent_mb=100, hold_seconds=0.1, budget_mb=150,
                                             brake="off", quiet=True))
