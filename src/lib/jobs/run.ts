import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RepoClient } from '@/lib/github/types';
import { describe, log, stackOf } from '@/lib/log';
import { alertOperator } from '@/lib/notify/operator';
import { classifyModelFailure } from '@/lib/jobs/provider-failure';
import { stageDurations } from '@/lib/record/durations';
import {
  discardAttachments,
  placeAttachments,
  verifyPlaced,
  type PlacedAttachment,
} from '@/lib/jobs/attachments';
import type { JobBus } from '@/lib/jobs/bus';
import { CLIENT_MESSAGES, INTERRUPTED_MESSAGE, WORK_KEPT_MESSAGE } from '@/lib/jobs/messages';
import { resolveModel } from '@/lib/models';
import { toClientProse } from '@/lib/jobs/client-prose';
import { assemblePrompt } from '@/lib/jobs/prompt';
import { waitForPreview } from '@/lib/jobs/preview';
import { pushBranch } from '@/lib/jobs/push';
import { createStageMachine } from '@/lib/jobs/state';
import { clearWip, isResumable, restoreWip, saveWip, type WipDeps } from '@/lib/jobs/wip';
import type { AcquireResult, LockHandle } from '@/lib/lock/lock';
import { commitPermittedPaths, deriveChangeSet } from '@/lib/mirror/changeset';
import type { Mirror, WorkingTree } from '@/lib/mirror/types';
import type { NetlifyClient } from '@/lib/netlify';
import type { Mailer } from '@/lib/notify/email';
import { gate } from '@/lib/policy/gate';
import { renderRecord } from '@/lib/record/record';
import { writeControlDir } from '@/lib/runner/control';
import { makeAgentWritable } from '@/lib/runner/permissions';
import type { AgentSlots, SlotOutcome } from '@/lib/runner/slots';
import type { JobRunner } from '@/lib/runner/types';
import type {
  AgentPrompt,
  Attachment,
  ChangedFile,
  Env,
  ErrorCode,
  Message,
  ModelTier,
  Outcome,
  RepoConfig,
  RequestRecord,
  StageEvent,
} from '@/types';

/**
 * One request, from a sentence a client typed to a preview they can look at.
 *
 * The order of the steps here is the security design, not an implementation
 * detail. The agent edits a working tree that has no remote and holds no
 * credential; the host derives what changed, gates it, and only then stages,
 * commits and pushes. Nothing between the container and the client's site is
 * enforced by asking the model nicely (constitution Principle III).
 *
 * Every exit releases the lock and writes a durable record. That is not
 * politeness about cleanup: the lock is the only thing preventing two agents on
 * one branch, and the record is the only history this product has.
 */

export interface RunDeps {
  client: RepoClient;
  lock: { acquire(requestId: string, maxRequestMinutes: number): Promise<AcquireResult> };
  mirror: Mirror;
  runner: JobRunner;
  /**
   * Host-wide agent slots (src/lib/runner/slots.ts). Absent, the request
   * runs at once: a single-site development setup needs no queue.
   */
  slots?: AgentSlots;
  netlify: NetlifyClient;
  bus: JobBus;
  env: Env;
  config: RepoConfig;
  /**
   * Reaches the developer, not the client: the cost ceiling alert is the one
   * thing this orchestrator sends on its own behalf (FR-014). Absent, a run
   * still stops at the ceiling — it just goes unannounced.
   */
  mailer?: Mailer;
  /** Called once the request is finished, with the comment that recorded it. */
  onFinished?: (record: RequestRecord, commentId: number) => Promise<void>;
  now?: () => Date;
  workRoot?: string;
  /** Overrides how long a preview is waited for. Tests need seconds, not minutes. */
  previewTimeoutMs?: number;
}

export interface RunInput {
  conversationNumber: number;
  branch: string;
  baseBranch: string;
  message: string;
  history: Message[];
  targetHint?: string;
  buildFailureDetail?: string;
  /** Paths the gate already refused in this conversation, derived from its records. */
  refusedPaths?: string[];
  /** How much the client chose to spend. Absent, the repository's own `model` runs. */
  modelTier?: ModelTier;
  /**
   * Files the client attached. Copied into the working tree before the agent
   * runs, so they pass the same gate and land in the same commit as the change
   * itself; the temporary copies are removed whatever the ending.
   */
  attachments?: Attachment[];
  requestId?: string;
}

export type RunOutcome =
  | { started: false; errorCode: 'request_in_flight'; heldSince: string }
  | { started: true; requestId: string; outcome: Outcome; record: RequestRecord };

/**
 * What a caller learns the moment the lock has answered, before the work runs.
 *
 * The HTTP contract owes a client `202` or `409` immediately, and the only
 * thing that can decide between them is the lock. Holding the connection open
 * for the whole request would instead tie its fate to a browser tab, so
 * acquisition is awaited and everything after it is not.
 */
export type BeginOutcome =
  | { started: false; errorCode: 'request_in_flight'; heldSince: string }
  | { started: true; requestId: string; completed: Promise<RunOutcome> };

/** Bounds the wait for a preview independently of the agent's own timeout. */
const PREVIEW_TIMEOUT_MS = 10 * 60_000;

/**
 * How many attempted paths `request.blocked` carries.
 *
 * `maxFilesChanged` is a policy setting a site can raise, so the set the gate
 * judged is not bounded by anything this module controls. A refusal is worth
 * one legible line, not an unbounded one — and `attemptedCount` still reports
 * the true total when the list is cut short.
 */
const BLOCKED_PATHS_LOGGED = 50;

export async function beginRequest(deps: RunDeps, input: RunInput): Promise<BeginOutcome> {
  const requestId = input.requestId ?? `r_${randomUUID()}`;
  const acquired = await deps.lock.acquire(requestId, deps.config.settings.maxRequestMinutes);

  if (!acquired.ok && acquired.reason === 'held') {
    // Nothing will run, so nothing will clean up after the attachments either.
    await discardAttachments(input.attachments);
    return { started: false, errorCode: 'request_in_flight', heldSince: acquired.heldSince };
  }

  // A stale lock is broken rather than waited on, and the request it belonged to
  // is given the ending its own process never wrote.
  if (!acquired.ok) await recordAbandoned(deps, input, acquired);

  // Announced before the first stage, so a browser already watching this
  // conversation follows the request from its very first event.
  deps.bus.announce({ conversationNumber: input.conversationNumber, requestId, kind: 'change' });

  return { started: true, requestId, completed: execute(deps, input, requestId, acquired.handle) };
}

/** Runs a request to completion. Convenient for tests and for anything not answering HTTP. */
export async function runRequest(deps: RunDeps, input: RunInput): Promise<RunOutcome> {
  const begun = await beginRequest(deps, input);
  return begun.started ? begun.completed : begun;
}

// ---------------------------------------------------------------------------

async function execute(
  deps: RunDeps,
  input: RunInput,
  requestId: string,
  handle: LockHandle,
): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  // The machine will not let a request reach a terminal stage without this
  // firing, which is how "every ending releases the lock and writes a record"
  // becomes a structural guarantee rather than a convention this file follows.
  let reachedTerminal = false;
  const machine = createStageMachine(requestId, {
    bus: deps.bus,
    now,
    onTerminal: () => {
      reachedTerminal = true;
    },
  });

  let tree: WorkingTree | null = null;
  let controlDir: string | null = null;
  // Held for the agent's whole run and given back in `finally`, whatever the
  // ending: a slot released anywhere else leaks host capacity on the failure
  // paths, and leaked capacity is a host that quietly stops admitting anyone.
  let slot: SlotOutcome | null = null;
  // Chosen once, here, so the container and the record cannot disagree about
  // which model a request ran on.
  const model = resolveModel(deps.config.settings, input.modelTier);

  try {
    // The tree is prepared at `starting`; the request only becomes `running`
    // once the host has room for its agent. Preparing first keeps the wait
    // short once a slot frees, and the lock is already held either way.
    const prepared = await prepare(deps, input, requestId);
    tree = prepared.tree;
    controlDir = prepared.controlDir;

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
    if (agent.failure) {
      if (isProviderLimit(agent.failure.errorCode)) {
        await alertProviderLimit(deps, input, agent.failure.errorCode, agent.failure.errorDetail);
      }
      const wipSaved = await keepInterruptedWork(deps, input, requestId, prepared, agent.failure);
      // The spend is carried into every ending, not just the successful one:
      // a request that failed cost exactly what it cost, and a record omitting
      // that under-reports the installation precisely where a developer is
      // most likely to be looking (constitution V).
      return finish(deps, input, machine, {
        requestId,
        startedAt,
        model,
        ...agent.cost,
        ...agent.failure,
        ...(wipSaved ? { wipSaved } : {}),
      });
    }

    machine.advance('gating');
    const verdict = await judge(deps, tree, agent.cost, prepared.placed);
    if (verdict.failure) {
      if (verdict.failure.outcome === 'blocked') {
        // The record keeps the first offending path, because that is the one
        // the gate stopped at. Deciding whether the allow list is too narrow
        // or the agent wandered needs the whole set, and that question is the
        // developer's, so it belongs in a log line rather than in a surface
        // the client can see.
        log.warn('request.blocked', {
          requestId,
          violation: verdict.failure.violation,
          blockedPath: verdict.failure.blockedPath,
          attemptedCount: verdict.files.length,
          attemptedPaths: verdict.files.slice(0, BLOCKED_PATHS_LOGGED).map((file) => file.path),
        });
      }
      if (verdict.failure.errorCode === 'cost_ceiling') {
        await alertCostCeiling(deps, input, agent.cost.costUsd);
      }
      await spendKeptWork(deps, input, requestId, prepared);
      machine.advance(verdict.failure.outcome === 'blocked' ? 'blocked' : 'failed');
      return finish(
        deps,
        input,
        machine,
        { requestId, startedAt, model, ...agent.cost, ...verdict.failure },
        true,
      );
    }

    machine.advance('pushing');
    const commit = await publishBranch(deps, input, tree, verdict.files, agent.summary);
    // After the push, never before: until the branch holds the work, the kept
    // copy is the only one there is.
    await spendKeptWork(deps, input, requestId, prepared);

    machine.advance('building');
    const preview = await waitForPreview(
      { netlify: deps.netlify, bus: deps.bus, requestId },
      {
        conversationNumber: input.conversationNumber,
        commitSha: commit.sha,
        timeoutMs: deps.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS,
      },
    );

    if (preview.kind === 'hosting_limit') {
      await alertProviderLimit(deps, input, 'hosting_limit', preview.detail);
    }
    return finish(
      deps,
      input,
      machine,
      settle(preview, { requestId, startedAt, agent, verdict, commit, model }),
    );
  } catch (cause) {
    // The one line that says where an unexpected fault came from. The counted
    // `request.ended` names only the code; this carries the message and stack.
    log.error('request.failed', {
      requestId,
      conversationNumber: input.conversationNumber,
      error: describe(cause),
      stack: stackOf(cause),
    });
    if (!machine.isTerminal()) machine.advance('failed');
    return finish(deps, input, machine, {
      requestId,
      startedAt,
      outcome: 'failed',
      errorCode: 'internal_error',
      errorDetail: describe(cause),
      prose: null,
    });
  } finally {
    await discard(tree, controlDir);
    await discardAttachments(input.attachments);
    if (slot?.ok) await slot.release();
    await handle.release();

    if (!reachedTerminal) {
      // Unreachable by design: every return path above passes through `finish`,
      // which advances to a terminal stage. Saying so out loud costs nothing and
      // turns a silent lock leak into a line in the log if it ever stops being
      // true.
      log.error('request.lock_leak', { requestId });
    }
  }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * Announces `queued` only to a request that actually waited: `onWait` fires
 * the first time the host is full, never for a request that walked straight
 * in. With no slots configured there is nothing to wait for.
 */
async function waitForSlot(
  deps: RunDeps,
  machine: { advance(stage: 'queued'): void },
  requestId: string,
): Promise<SlotOutcome> {
  if (!deps.slots) return { ok: true, waitedMs: 0, release: async () => {} };
  const outcome = await deps.slots.acquire({ onWait: () => machine.advance('queued'), requestId });
  // Only when it actually waited. A line per request that walked straight in
  // would be one line per request saying nothing.
  if (outcome.waitedMs > 0) {
    log.info('slot.waited', {
      requestId,
      waitedMs: outcome.waitedMs,
      granted: outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason ?? 'timeout' }),
    });
  }
  return outcome;
}

interface Prepared {
  tree: WorkingTree;
  controlDir: string;
  prompt: AgentPrompt;
  /** Attachments as placed, so the gate can tell them apart from the agent's work. */
  placed: PlacedAttachment[];
  /** Paths restored from an interrupted request's kept work. Empty when there was none. */
  resumedPaths: string[];
}

async function prepare(deps: RunDeps, input: RunInput, requestId: string): Promise<Prepared> {
  await deps.mirror.sync();
  const tree = await deps.mirror.checkout(input.branch, input.baseBranch);
  // First, on the tree as cloned: a restore that does not apply is undone by
  // resetting the tree, which would take attachments with it.
  const resumedPaths = await restoreWip(wipDeps(deps), {
    tree,
    conversationNumber: input.conversationNumber,
    requestId,
  });

  // The control directory sits outside the working tree by construction, so a
  // control file can never become part of a change to the client's site,
  // whatever the agent does with the tree it was given (FR-015). It must live
  // under a directory the host daemon can resolve (the shared state dir in
  // production); `mkdtemp` needs that parent to exist first.
  const root = deps.workRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const controlDir = await mkdtemp(join(root, `webagent-control-${requestId}-`));

  // Attachments go into the tree before the agent sees it, as ordinary files
  // at ordinary paths. From here on nothing distinguishes them from a file the
  // agent created: the gate judges them, the commit carries them, and the
  // prompt names where they landed so the agent can use them.
  const placed = await placeAttachments(
    tree.dir,
    deps.config.settings.uploadDir,
    input.attachments,
  );
  const attachedPaths = placed.map((entry) => entry.path);

  const prompt = assemblePrompt({
    request: input.message,
    history: input.history,
    guidance: deps.config.guidance,
    policy: deps.config.policy,
    ...(input.targetHint ? { targetHint: input.targetHint } : {}),
    ...(input.buildFailureDetail ? { buildFailureDetail: input.buildFailureDetail } : {}),
    ...(input.refusedPaths?.length ? { refusedPaths: input.refusedPaths } : {}),
    ...(attachedPaths.length ? { attachedPaths } : {}),
    ...(resumedPaths.length ? { resumedPaths } : {}),
  });
  // Passing the working tree here is not redundant: it is what lets the control
  // writer refuse a control directory nested inside the tree, rather than
  // trusting this caller to have chosen one outside it (FR-015).
  await writeControlDir(controlDir, tree.dir, prompt);

  // Last, so it covers the attachments and the prompt file as well as the
  // checkout. The container runs as its own uid and would otherwise find
  // every one of these read-only — see permissions.ts for why widening them
  // is contained rather than dangerous.
  await makeAgentWritable(tree.dir);
  await makeAgentWritable(controlDir);

  return { tree, controlDir, prompt, placed, resumedPaths };
}

function wipDeps(deps: RunDeps): WipDeps {
  return {
    client: deps.client,
    mirror: deps.mirror,
    policy: deps.config.policy,
    author: { name: 'Site Editor', email: deps.env.smtpFrom },
  };
}

/**
 * Keeps an interrupted run's edits for the conversation's next request, when
 * the interruption was the kind worth resuming from (src/lib/jobs/wip.ts).
 */
async function keepInterruptedWork(
  deps: RunDeps,
  input: RunInput,
  requestId: string,
  prepared: Prepared,
  failure: Failure,
): Promise<boolean> {
  if (!failure.errorCode || !isResumable(failure.errorCode)) return false;
  return saveWip(wipDeps(deps), {
    tree: prepared.tree,
    conversationNumber: input.conversationNumber,
    requestId,
    errorCode: failure.errorCode,
    placed: prepared.placed,
  });
}

/**
 * Kept work is spent once the gate has judged a tree that contained it:
 * published, it is on the branch; refused, it would be refused again on every
 * later request. Endings that never reached the gate leave it where it is.
 */
async function spendKeptWork(
  deps: RunDeps,
  input: RunInput,
  requestId: string,
  prepared: Prepared,
): Promise<void> {
  if (prepared.resumedPaths.length === 0) return;
  await clearWip(wipDeps(deps), {
    tree: prepared.tree,
    conversationNumber: input.conversationNumber,
    requestId,
  });
}

interface Failure {
  outcome: Outcome;
  errorCode?: ErrorCode;
  errorDetail?: string;
  violation?: RequestRecord['violation'];
  blockedPath?: string;
  /** The run was interrupted and its edits were kept for the next request. */
  wipSaved?: boolean;
  prose: string | null;
}

interface AgentPass {
  failure?: Failure;
  summary: string;
  cost: { tokensIn: number; tokensOut: number; costUsd: number };
}

async function runAgent(
  deps: RunDeps,
  requestId: string,
  prepared: Prepared,
  model: string,
  memoryBytes?: number,
): Promise<AgentPass> {
  const timeoutMs = deps.config.settings.maxRequestMinutes * 60_000;
  // The agent's own output is otherwise ephemeral — streamed to the browser and
  // then gone. A failed run needs its last words kept, so the reason it failed
  // reaches the durable record and the server log rather than a bare exit code.
  const outputTail: string[] = [];
  const run = await deps.runner.run({
    requestId,
    workDir: prepared.tree.dir,
    controlDir: prepared.controlDir,
    prompt: prepared.prompt,
    model,
    timeoutMs,
    memoryBytes,
    onOutput: (text) => {
      outputTail.push(text);
      if (outputTail.length > AGENT_OUTPUT_TAIL_LINES) outputTail.shift();
      deps.bus.publish({ type: 'output', requestId, text });
    },
  });

  // The runner already read `/control/result.json` and hands it back; reading
  // the file again here would be a second, divergent source of the same fact.
  const result = run.result;
  const cost = {
    tokensIn: result?.tokensIn ?? 0,
    tokensOut: result?.tokensOut ?? 0,
    costUsd: result?.costUsd ?? 0,
  };
  const summary = result?.summary?.trim() || 'I made the change you asked for.';

  const failed = (errorCode: ErrorCode, base: string): AgentPass => {
    const errorDetail = appendAgentOutput(base, outputTail);
    // Two lines, deliberately. The first is the counted failure and ships
    // off the box: it carries the size of the detail, never the detail. The
    // second carries the agent's own last words — its stdout over a client's
    // private tree — so that an operator with `docker logs` can read why a
    // request failed without opening the durable record. That line is
    // dropped by the collector before anything leaves this host
    // (ops/monitoring/alloy/config.alloy matches its event name), which is
    // why the detail must not be folded into the first line: one line either
    // ships or does not.
    log.error('agent.run_failed', {
      requestId,
      errorCode,
      exitCode: run.exitCode,
      errorDetailLength: errorDetail.length,
    });
    log.error('agent.run_failed_detail', { requestId, errorCode, errorDetail });
    return { failure: { outcome: 'failed', errorCode, errorDetail, prose: null }, summary, cost };
  };

  if (run.outcome === 'timeout') {
    return failed('agent_timeout', DEFAULT_ERROR_DETAIL.agent_timeout);
  }
  if (run.outcome === 'error') {
    return failed('internal_error', run.errorDetail ?? 'the agent runner reported an error');
  }

  // The container's exit status is the agent's own verdict on its run
  // (contracts/repo-files.md: "exits 0 ... Exits non-zero on failure"). A
  // non-zero exit has to end the request here, before the working tree is
  // examined: an agent that died mid-edit leaves changes behind, and reading
  // those as the client's requested change would push work nobody stands
  // behind. Reading their absence as "nothing needed changing" is worse still
  // — it reports a crash as a considered decision.
  if (run.exitCode !== null && run.exitCode !== 0) {
    const providerError = result?.providerError;
    const base = `the agent container exited with status ${run.exitCode}`;
    if (!providerError) return failed('internal_error', base);
    // The provider's own words, on the box and shipped: an API refusal names
    // a status and a reason, not a client's file. What the agent printed
    // around it stays on the detail line.
    log.error('provider.failed', {
      requestId,
      provider: 'openrouter',
      model,
      statusCode: providerError.statusCode,
      message: providerError.message,
    });
    return failed(
      classifyModelFailure(providerError) ?? 'internal_error',
      `${base}; the model provider answered ${providerError.statusCode}: ${providerError.message}`,
    );
  }

  return { summary, cost };
}

/** How many trailing lines of agent output to keep for a failed run's detail. */
const AGENT_OUTPUT_TAIL_LINES = 40;

/**
 * Appends the agent's last output lines to a failure detail, so the record and
 * the log say *why* it failed and not only that it did. Each line is capped and
 * the tail is bounded — this is a diagnostic for the developer (it lives in the
 * record's machine block and the server log, never in the client's prose, per
 * Principle I), not something a client ever reads.
 */
function appendAgentOutput(base: string, outputTail: string[]): string {
  const tail = outputTail
    .slice(-20)
    .map((line) => (line.length > 500 ? `${line.slice(0, 500)}…` : line))
    .join('\n')
    .trim();
  return tail ? `${base}\n--- agent output (last lines) ---\n${tail}` : base;
}

interface Verdict {
  failure?: Failure;
  files: ChangedFile[];
  diffLines: number;
}

/**
 * The gate, plus the two conditions that are not policy violations but still end
 * the request here: a change that cost more than the site permits, and no change
 * at all.
 */
async function judge(
  deps: RunDeps,
  tree: WorkingTree,
  cost: { costUsd: number },
  placed: PlacedAttachment[] = [],
): Promise<Verdict> {
  const changeSet = await deriveChangeSet(tree);

  if (cost.costUsd > deps.config.settings.costCeilingUsd) {
    return {
      failure: { outcome: 'failed', errorCode: 'cost_ceiling', prose: null },
      files: changeSet.files,
      diffLines: changeSet.totalDiffLines,
    };
  }

  if (changeSet.files.length === 0) {
    return {
      failure: { outcome: 'failed', errorCode: 'nothing_to_change', prose: null },
      files: [],
      diffLines: 0,
    };
  }

  // Attachments the client sent, still untouched, need not match the allow
  // list: the list bounds the agent, and these are the client's own files.
  const attachedPaths = await verifyPlaced(tree.dir, placed);
  const result = gate(changeSet.files, deps.config.policy, { attachedPaths });
  if (!result.ok) {
    return {
      failure: {
        outcome: 'blocked',
        errorCode: 'blocked_by_policy',
        violation: result.violation,
        blockedPath: result.path,
        prose: null,
      },
      files: changeSet.files,
      diffLines: changeSet.totalDiffLines,
    };
  }

  return { files: changeSet.files, diffLines: changeSet.totalDiffLines };
}

async function publishBranch(
  deps: RunDeps,
  input: RunInput,
  tree: WorkingTree,
  files: ChangedFile[],
  summary: string,
): Promise<{ sha: string }> {
  // The author and the message belong to the host. The container never commits,
  // so nothing it wrote can masquerade as authorship in the site's history.
  const commit = await commitPermittedPaths(tree, files, commitMessage(summary), {
    name: 'Site Editor',
    email: deps.env.smtpFrom,
  });

  await pushBranch(tree, input.branch, await deps.client.authenticatedRemoteUrl());
  return commit;
}

function commitMessage(summary: string): string {
  const firstLine = summary.split('\n')[0]?.trim() ?? 'apply requested change';
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

// ---------------------------------------------------------------------------
// Ending the request
// ---------------------------------------------------------------------------

interface SettleInput {
  requestId: string;
  startedAt: string;
  agent: AgentPass;
  verdict: Verdict;
  commit: { sha: string };
  model: string;
}

function settle(
  preview: Awaited<ReturnType<typeof waitForPreview>>,
  input: SettleInput,
): FinishInput {
  const shared = {
    requestId: input.requestId,
    startedAt: input.startedAt,
    commitSha: input.commit.sha,
    filesChanged: input.verdict.files.length,
    diffLines: input.verdict.diffLines,
    model: input.model,
    ...input.agent.cost,
  };

  if (preview.kind === 'ready') {
    return {
      ...shared,
      outcome: 'succeeded',
      previewUrl: preview.previewUrl,
      // The summary is unbounded model output, and this is a client surface.
      // Principle III is explicit that the prohibition in Principle I is
      // machine-enforced, so it is redacted here rather than asked for in a
      // prompt (see toClientProse).
      prose: `${toClientProse(input.agent.summary)}\n\nYour preview is ready.`,
    };
  }

  if (preview.kind === 'build_failed' || preview.kind === 'hosting_limit') {
    return {
      ...shared,
      outcome: 'failed',
      errorCode: preview.kind,
      errorDetail: preview.detail,
      prose: null,
    };
  }

  return { ...shared, outcome: 'failed', errorCode: 'site_unreachable', prose: null };
}

type FinishInput = Failure & {
  requestId: string;
  startedAt: string;
  commitSha?: string;
  filesChanged?: number;
  diffLines?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  previewUrl?: string;
};

async function finish(
  deps: RunDeps,
  input: RunInput,
  machine: {
    advance(stage: 'succeeded' | 'failed' | 'blocked'): void;
    isTerminal(): boolean;
    stages: StageEvent[];
  },
  result: FinishInput,
  alreadyTerminal = false,
): Promise<RunOutcome> {
  if (!alreadyTerminal && !machine.isTerminal()) {
    machine.advance(
      result.outcome === 'succeeded'
        ? 'succeeded'
        : result.outcome === 'blocked'
          ? 'blocked'
          : 'failed',
    );
  }

  const now = deps.now ?? (() => new Date());
  const record = buildRecord(result, machine.stages, now().toISOString());

  // Emitted before the comment is written, deliberately. If GitHub is the
  // thing that is broken, `createComment` throws and this function propagates
  // — and the moment you most want a measurement is the moment the durable
  // record cannot be written. Ordering it first is what guarantees the event
  // exists then.
  //
  // `errorDetail` is not carried: it holds the agent's last output lines,
  // untrusted model output taken over a client's private tree. The record
  // keeps them, where the client already controls access.
  log.info('request.ended', {
    requestId: record.requestId,
    conversationNumber: input.conversationNumber,
    outcome: record.outcome,
    errorCode: record.errorCode,
    violation: record.violation,
    model: record.model,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    costUsd: record.costUsd,
    filesChanged: record.filesChanged,
    diffLines: record.diffLines,
    wipSaved: record.wipSaved,
    commitSha: record.commitSha,
    hasPreview: Boolean(record.previewUrl),
    ...stageDurations(record),
  });

  const prose = result.prose ?? proseFor(result);
  const comment = await deps.client.createComment(
    input.conversationNumber,
    renderRecord(prose, record),
  );

  deps.bus.publish({
    type: 'done',
    requestId: result.requestId,
    outcome: record.outcome,
    ...(record.previewUrl ? { previewUrl: record.previewUrl } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  });

  await deps.onFinished?.(record, comment.id);
  return { started: true, requestId: result.requestId, outcome: record.outcome, record };
}

/**
 * What a `failed` record says when the failure had nothing more specific to
 * add.
 *
 * The record schema requires a detail on every failure, and it is right to:
 * a failure with no explanation is the one a developer most needs explained.
 * Several endings are fully described by their code alone, though, so rather
 * than let them write a record this product cannot read back, each gets a
 * sentence here. These are diagnostic, never shown to a client — the prose
 * beside the block is what a client reads (Principle I).
 */
export const DEFAULT_ERROR_DETAIL: Record<ErrorCode, string> = {
  agent_timeout: 'the agent was still running when maxRequestMinutes elapsed and was killed',
  cost_ceiling: 'the run would have exceeded costCeilingUsd and was stopped before pushing',
  nothing_to_change: 'the agent exited successfully having modified no file in the working tree',
  nothing_to_publish: 'approval was asked for a conversation with no successful preview to publish',
  nothing_to_undo: 'undo was asked for a conversation that has nothing live to reverse',
  site_moved_on:
    'the default branch has advanced past the published commit, so a revert would take later work with it',
  site_conflict:
    'the default branch and the change touch the same lines, so bringing the change up to date needs a person',
  site_unreachable: 'the hosting provider reported no deploy for this branch within the wait',
  request_in_flight: 'another request held the installation lock',
  too_busy: 'no agent slot became free on this host within the queue wait',
  blocked_by_policy: 'the change touched a path the policy does not permit',
  out_of_date: 'the branch moved under the request between reading and pushing',
  build_failed: 'the hosting provider reported a failed build',
  model_quota: 'the model provider answered 429: the daily allowance is used up',
  model_credit: 'the model provider refused for lack of credit',
  model_unavailable: 'the model provider rejected the key, the model id, or is down',
  hosting_limit: 'the hosting provider stopped the build because of a plan limit',
  internal_error: 'an unexpected fault; see the server log for this request id',
};

function buildRecord(result: FinishInput, stages: StageEvent[], finishedAt: string): RequestRecord {
  // A failure must arrive with a detail or the record it writes is one this
  // product cannot parse back, which turns the agent's turn into an
  // unattributed comment and exposes the block a client should never see.
  const errorDetail =
    result.outcome === 'failed' && result.errorCode
      ? (result.errorDetail ?? DEFAULT_ERROR_DETAIL[result.errorCode])
      : result.errorDetail;

  const record: RequestRecord = {
    requestId: result.requestId,
    startedAt: result.startedAt,
    finishedAt,
    outcome: result.outcome,
    stages,
  };

  const optional: Array<[keyof RequestRecord, unknown]> = [
    ['commitSha', result.commitSha],
    ['filesChanged', result.filesChanged],
    ['diffLines', result.diffLines],
    ['model', result.model],
    ['tokensIn', result.tokensIn],
    ['tokensOut', result.tokensOut],
    ['costUsd', result.costUsd],
    ['previewUrl', result.previewUrl],
    ['violation', result.violation],
    ['blockedPath', result.blockedPath],
    ['errorCode', result.errorCode],
    ['errorDetail', errorDetail],
    ['wipSaved', result.wipSaved],
  ];

  for (const [key, value] of optional) {
    if (value !== undefined) Object.assign(record, { [key]: value });
  }

  return record;
}

/**
 * The prose is what the client reads, and it is written from the closed
 * vocabulary rather than from whatever the failure happened to carry — a
 * detail string is diagnostic material and belongs in the block, never in the
 * sentence (Principle I).
 */
function proseFor(result: FinishInput): string {
  const code: ErrorCode = result.errorCode ?? 'internal_error';
  return result.wipSaved ? `${CLIENT_MESSAGES[code]} ${WORK_KEPT_MESSAGE}` : CLIENT_MESSAGES[code];
}

// ---------------------------------------------------------------------------

async function discard(tree: WorkingTree | null, controlDir: string | null): Promise<void> {
  // A blocked change is discarded by deleting the tree; nothing was committed,
  // so there is no state to unwind.
  await Promise.allSettled([
    tree?.dispose(),
    controlDir ? rm(controlDir, { recursive: true, force: true }) : Promise.resolve(),
  ]);
}

/**
 * Tells the developer their site spent more on one request than they allowed
 * (FR-014).
 *
 * Addressed to `alertContact`, which is a developer rather than a client, so
 * this is the one message in the job path that may carry the figures — the
 * client's own sentence stays inside the closed vocabulary (Principle I).
 *
 * It cannot fail the request. The ceiling has already done the work that
 * matters by stopping the push, and a mail server being down is no reason to
 * report a different ending than the one that happened.
 */
async function alertCostCeiling(deps: RunDeps, input: RunInput, costUsd: number): Promise<void> {
  const { alertContact, costCeilingUsd } = deps.config.settings;
  await alertOperator(
    { mailer: deps.mailer, alertContact },
    {
      subject: 'Cost ceiling reached on a change request',
      lines: [
        `A change request on ${deps.env.githubRepoOwner}/${deps.env.githubRepoName} was stopped ` +
          `before it published anything: it cost $${costUsd}, and this site's ceiling ` +
          `is $${costCeilingUsd}.`,
        `Nothing was pushed. The conversation: ${deps.env.publicBaseUrl}/c/${input.conversationNumber}`,
      ],
    },
  );
}

const PROVIDER_LIMIT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'model_quota',
  'model_credit',
  'hosting_limit',
]);

function isProviderLimit(
  code: ErrorCode | undefined,
): code is 'model_quota' | 'model_credit' | 'hosting_limit' {
  return code !== undefined && PROVIDER_LIMIT_CODES.has(code);
}

const PROVIDER_LIMIT_SUBJECT: Record<'model_quota' | 'model_credit' | 'hosting_limit', string> = {
  model_quota: 'AI service daily allowance used up',
  model_credit: 'AI service out of credit',
  hosting_limit: 'Hosting plan limit reached',
};

/**
 * Tells the developer a provider refused for a reason only they can fix: a
 * quota, an empty account, a hosting plan. Same addressee and same rules as
 * the cost-ceiling alert — figures and the provider's own sentence belong
 * here, because the reader is the person who has to go and top something up.
 * Cannot fail the request.
 */
async function alertProviderLimit(
  deps: RunDeps,
  input: RunInput,
  code: 'model_quota' | 'model_credit' | 'hosting_limit',
  detail: string | undefined,
): Promise<void> {
  const { alertContact } = deps.config.settings;
  await alertOperator(
    { mailer: deps.mailer, alertContact },
    {
      subject: `${PROVIDER_LIMIT_SUBJECT[code]} on ${deps.env.githubRepoOwner}/${deps.env.githubRepoName}`,
      lines: [
        `A change request stopped because of the provider, not the site: ${code}. Nothing was published.`,
        `What the provider said: ${detail ?? DEFAULT_ERROR_DETAIL[code]}`,
        `Every request on this site will end the same way until this is fixed. The conversation: ${deps.env.publicBaseUrl}/c/${input.conversationNumber}`,
      ],
    },
  );
}

/**
 * A request the previous process abandoned leaves a lock and no ending. The
 * process that breaks the lock writes the ending, because it is the only one
 * left that knows the request existed (FR-007c).
 */
async function recordAbandoned(
  deps: RunDeps,
  input: RunInput,
  broken: { brokenRequestId?: string; brokenStartedAt?: string },
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const record: RequestRecord = {
    requestId: broken.brokenRequestId ?? 'r_unknown',
    // The lock commit names when its request began, and that is the only
    // trace of the fact the dead process left anywhere. Falling back to now
    // would report a request that ran for no time at all, which is a worse
    // answer than an approximate one.
    startedAt: broken.brokenStartedAt ?? now,
    finishedAt: now,
    outcome: 'abandoned',
    stages: [],
  };

  try {
    await deps.client.createComment(
      input.conversationNumber,
      renderRecord(INTERRUPTED_MESSAGE, record),
    );
  } catch {
    // Recording the abandonment is a courtesy to the conversation's history;
    // failing to record it must not stop the request that is starting now.
  }
}
