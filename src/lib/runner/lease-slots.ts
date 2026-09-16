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
    socket.on('close', () =>
      settle({ kind: 'unavailable', error: 'the daemon closed the connection before deciding' }),
    );
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
      const lease = await negotiate(
        options.socketPath,
        acquireOptions.requestId,
        maxWaitMs,
        acquireOptions.onWait,
      );
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
