/**
 * Admission to the host's agent capacity.
 *
 * `run.ts` asks for a slot before it starts an agent and announces `queued`
 * only to a request that actually had to wait. What grants the slot is behind
 * this interface so the orchestrator never learns how the host is shared.
 *
 * There is no host-wide implementation yet. This module once counted agent
 * containers on the installation's Docker daemon and called that count
 * host-wide, which was true only while every installation shared one daemon.
 * Under the one-daemon-per-client topology the count was per client — and
 * since each installation serves one site and the site lock already bounds
 * it to one run at a time, that count never bound anything. It was removed on
 * 2026-09-15 rather than kept as false comfort. Cross-installation admission
 * is the lease daemon designed in
 * docs/superpowers/specs/2026-09-14-host-admission-queue-design.md, which
 * implements this same interface.
 */

/**
 * Every agent container carries this label. `ops/status.sh` counts running
 * containers by it for the host's `webamend_agents_running_total` metric, and a
 * developer reading `docker ps` can tell an agent from anything else.
 */
export const AGENT_LABEL = 'webagent.agent';

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
