/**
 * Every event name this installation may emit.
 *
 * A closed union rather than free strings, for the same reason `ErrorCode` is
 * one: the name is the primary key every query, dashboard and alert rule
 * matches on, so a typo must be a compile error rather than a rule that
 * silently matches nothing forever.
 *
 * `noun.verb_past`, lowercase, dotted. The noun is the subsystem a reader
 * would go and look at.
 */
export type LogEvent =
  // The request lifecycle — the events metrics are derived from.
  | 'request.started'
  | 'request.ended'
  | 'request.lock_leak'
  // The gate refused the change: which rule, which path stopped it, and every
  // path the change touched. Operator-facing — the client is told none of it.
  | 'request.blocked'
  | 'publication.started'
  | 'publication.ended'
  // Capacity.
  | 'slot.waited'
  | 'slots.count_failed'
  // The admission daemon could not be reached or stopped answering; the
  // request ran under the fallback. Protection degraded, availability kept.
  | 'slots.broker_unavailable'
  // Boot and continuous readiness.
  | 'startup.ok'
  | 'startup.refused'
  | 'readiness.probed'
  // Faults that are handled but worth counting.
  | 'agent.run_failed'
  // A request or a publication ended on a fault nobody expected: message and
  // stack, so `docker logs` says where. The counted line is `request.ended`.
  | 'request.failed'
  | 'publication.failed'
  // The model or hosting provider refused and said why (status, message).
  | 'provider.failed'
  // The agent's own last words, on a line the collector drops before shipping
  // (ops/monitoring/alloy/config.alloy). Read it with `docker logs`; it never
  // reaches the external log service.
  | 'agent.run_failed_detail'
  | 'runner.cleanup_failed'
  // An interrupted run's edits, kept for the conversation's next request
  // (src/lib/jobs/wip.ts). `dropped` names why kept work was not used or not
  // kept: the gate refused it, the branch moved under it, or it was spent.
  | 'wip.saved'
  | 'wip.restored'
  | 'wip.dropped'
  | 'wip.save_failed'
  | 'wip.clear_failed'
  | 'lock.broken_stale'
  | 'lock.release_failed'
  | 'config.load_failed'
  | 'bus.listener_threw'
  | 'http.unexpected'
  | 'netlify.webhook'
  | 'notify.failed'
  | 'auth.refused';
