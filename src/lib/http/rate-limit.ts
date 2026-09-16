/**
 * A small in-process sliding-window rate limiter.
 *
 * This product is a single process per installation (constitution VI), so a
 * plain in-memory window is enough: there is no second replica to coordinate
 * with. It exists for the one unauthenticated endpoint that does real work —
 * requesting a sign-in link sends an email, so without a limit an attacker who
 * knows a permitted address can drive unbounded mail at a client's staff and
 * burn the installation's SMTP quota (F3).
 *
 * It keeps no durable state and forgets everything on restart, which is the
 * right trade for an abuse control rather than an access control: the worst a
 * restart costs is a fresh window, and access is still governed by the session
 * checks that never live here.
 */

export interface RateLimiter {
  /** Records an attempt for `key` and returns whether it is within the limit. */
  allow(key: string): boolean;
}

export interface RateLimitOptions {
  /** Attempts permitted within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock so tests never wait on real time. */
  now?: () => number;
}

/** Above this many tracked keys, stale ones are swept so the map cannot grow without bound. */
const SWEEP_THRESHOLD = 10_000;

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();

  function recent(key: string, cutoff: number): number[] {
    return (hits.get(key) ?? []).filter((at) => at > cutoff);
  }

  function sweep(cutoff: number): void {
    if (hits.size < SWEEP_THRESHOLD) return;
    for (const [key, times] of hits) {
      const live = times.filter((at) => at > cutoff);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }

  return {
    allow(key: string): boolean {
      const at = now();
      const cutoff = at - options.windowMs;
      const times = recent(key, cutoff);

      if (times.length >= options.limit) {
        hits.set(key, times);
        return false;
      }

      times.push(at);
      hits.set(key, times);
      sweep(cutoff);
      return true;
    },
  };
}

/**
 * The caller's address, as far as a request behind the reverse proxy can say.
 *
 * Webamend runs behind a root-owned proxy (Caddy) that terminates TLS and
 * forwards over loopback, so the socket's own address is always `127.0.0.1`.
 * The client address is the first hop of `X-Forwarded-For`, or `X-Real-IP`.
 * A caller can forge these, so the per-address limit below carries the weight;
 * this is only the coarser net.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}
