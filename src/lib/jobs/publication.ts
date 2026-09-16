import {
  publicationRequestId,
  readConversation,
  recordPublication,
  selectPublishState,
  type PublicationKind,
  type PublishState,
} from '@/lib/conversations';
import { readChangeFreshness } from '@/lib/github/staleness';
import { isRevertNotAtTipError, type RepoClient } from '@/lib/github/types';
import type { JobBus } from '@/lib/jobs/bus';
import { BRINGING_UP_TO_DATE, PUBLISH_REFUSALS, UNDO_REFUSALS } from '@/lib/jobs/messages';
import { waitForPreview } from '@/lib/jobs/preview';
import { pushBranch } from '@/lib/jobs/push';
import type { Mirror, WorkingTree } from '@/lib/mirror/types';
import { describe, log, stackOf } from '@/lib/log';
import { isNetlifyPlanLimit, type NetlifyClient } from '@/lib/netlify';
import { deployEffect } from '@/lib/netlify/webhook';
import { notifyPublication, type Mailer } from '@/lib/notify/email';
import type { Env, ErrorCode, RequestRecord, Stage } from '@/types';

/**
 * Publishing and undoing, as requests the client can watch.
 *
 * Both used to be a single round trip: merge, write the record, answer 202,
 * and leave the client to guess when the hosting provider had finished. They
 * are requests like any other now — announced on the bus, moving through
 * stages, ending in `done` — so the same trail that shows a change being made
 * shows it going live. The stages are honest about what actually happens: no
 * agent runs and nothing is gated, so neither of those steps appears; the
 * checks that do run (`gating`), the act itself (`pushing`), and the
 * provider's production build (`building`) are what the client sees.
 *
 * A change whose site has moved on since its preview is brought up to date
 * under `gating` rather than refused (FR-030): the site's tip is merged into
 * the change by the host, the preview is rebuilt from the result, and only
 * then does the publish go ahead. That is what a client pressing one button
 * expects, and the merge is what publishing would have produced anyway. Only
 * a genuine conflict — the same lines edited both ways — is refused, because
 * settling that needs a person.
 *
 * The irreversible act is still awaited by the route: the record is written
 * and the 202 answered only once the merge or the revert has happened. Only
 * the wait for the build runs past the response, because that wait is minutes
 * long and its outcome changes nothing about what was published.
 */

export interface PublicationDeps {
  client: RepoClient;
  netlify: NetlifyClient;
  bus: JobBus;
  lock: { inspect(): Promise<unknown | null> };
  mirror: Mirror;
  mailer: Mailer;
  env: Env;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long the production build is waited for. Tests need seconds, not minutes. */
  deployTimeoutMs?: number;
  /** How long a rebuilt preview is waited for after bringing a change up to date. */
  previewTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Overridable so a unit test can watch a push without a remote. */
  push?: (tree: WorkingTree, branch: string, remoteUrl: string) => Promise<void>;
}

export interface PublicationInput {
  conversationNumber: number;
  kind: PublicationKind;
  /** Who pressed the button, for the audit entry (FR-031). */
  actor: string;
}

export type PublicationEnding =
  { outcome: 'succeeded'; liveUrl?: string } | { outcome: 'failed'; errorCode: ErrorCode };

export type PublicationBegun =
  | { ok: false; reason: 'not_found' }
  /** The conversation is not in a state where the act means anything. Nothing was announced. */
  | {
      ok: false;
      reason: 'refused';
      errorCode: 'nothing_to_publish' | 'nothing_to_undo';
      message: string;
    }
  /** The act was attempted and could not go ahead. The client saw it fail on the trail. */
  | { ok: false; reason: 'failed'; errorCode: ErrorCode; cause?: unknown }
  | {
      ok: true;
      requestId: string;
      record: RequestRecord;
      commentId: number;
      /** Resolves once the hosting provider has built the change, or given up. */
      completed: Promise<PublicationEnding>;
    };

const DEFAULT_DEPLOY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export async function beginPublication(
  deps: PublicationDeps,
  input: PublicationInput,
): Promise<PublicationBegun> {
  const detail = await readConversation(deps.client, input.conversationNumber);
  if (!detail) return { ok: false, reason: 'not_found' };

  const refusal = refuse(input.kind, selectPublishState(detail));
  if (refusal) return refusal;

  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const requestId = publicationRequestId(input.kind, at);
  const emit = (stage: Stage) =>
    deps.bus.publish({ type: 'stage', requestId, stage, at: now().toISOString() });
  const fail = (errorCode: ErrorCode, cause?: unknown): PublicationBegun => {
    emit('failed');
    deps.bus.publish({ type: 'done', requestId, outcome: 'failed', errorCode });
    log.error('publication.failed', {
      requestId,
      kind: input.kind,
      conversationNumber: input.conversationNumber,
      errorCode,
      ...(cause !== undefined ? { error: describe(cause), stack: stackOf(cause) } : {}),
    });
    return { ok: false, reason: 'failed', errorCode, ...(cause !== undefined ? { cause } : {}) };
  };

  deps.bus.announce({ conversationNumber: input.conversationNumber, requestId, kind: input.kind });
  emit('starting');

  emit('gating');
  let safety: Safety;
  try {
    safety = await checkSafety(deps, input, detail.conversation.branch, requestId);
  } catch (cause) {
    return fail('internal_error', cause);
  }
  if (!safety.ok) return fail(safety.errorCode);

  emit('pushing');
  let commitSha: string;
  try {
    commitSha =
      input.kind === 'publish'
        ? (await deps.client.mergePullRequest(input.conversationNumber)).sha
        : (await deps.client.revertCommit(safety.publishedSha, safety.defaultBranch)).sha;
  } catch (cause) {
    // The site advanced between the freshness check and the revert. Not a
    // fault: undoing now would take newer work with it, so it is refused in
    // the client's own words rather than reported as a crash.
    if (isRevertNotAtTipError(cause)) return fail('out_of_date', cause);
    return fail('internal_error', cause);
  }

  const liveUrl = await readLiveUrl(deps.netlify);
  let written: Awaited<ReturnType<typeof recordPublication>>;
  try {
    written = await recordPublication(deps.client, {
      conversationNumber: input.conversationNumber,
      kind: input.kind,
      actor: input.actor,
      at,
      commitSha,
      ...(liveUrl ? { liveUrl } : {}),
    });
  } catch (cause) {
    // The act has happened and the site's history says so; only the audit
    // entry is missing. Reported as a failure so nobody is told it went
    // smoothly, and logged with the commit so the entry can be written by hand.
    log.error('publication.failed', {
      requestId,
      kind: input.kind,
      conversationNumber: input.conversationNumber,
      commitSha,
      note: 'the act happened; only the audit entry is missing',
      error: describe(cause),
      stack: stackOf(cause),
    });
    return fail('internal_error', cause);
  }

  // The act is done and the audit entry says so. This is the line the
  // collector counts publishes and undos from (the requests dashboard, alert
  // rules B6 and B7); the build that follows reports on a line of its own.
  // Who pressed the button stays in the audit entry — not in an external
  // log service.
  log.info('publication.ended', {
    requestId,
    kind: input.kind,
    conversationNumber: input.conversationNumber,
    commitSha,
  });

  await notifyPublication(
    { mailer: deps.mailer, client: deps.client, env: deps.env },
    {
      event: input.kind === 'publish' ? 'published' : 'undone',
      conversation: { number: input.conversationNumber, title: detail.conversation.title },
      commentId: written.commentId,
      record: written.record,
      recipients: deps.env.allowedEmails,
    },
  );

  emit('building');
  const completed = watchBuild(deps, { requestId, commitSha, ...(liveUrl ? { liveUrl } : {}) });

  return { ok: true, requestId, record: written.record, commentId: written.commentId, completed };
}

// ---------------------------------------------------------------------------

function refuse(kind: PublicationKind, state: PublishState): PublicationBegun | null {
  if (kind === 'publish') {
    if (state === 'ready') return null;
    return {
      ok: false,
      reason: 'refused',
      errorCode: 'nothing_to_publish',
      message: PUBLISH_REFUSALS[state],
    };
  }
  if (state === 'published') return null;
  return {
    ok: false,
    reason: 'refused',
    errorCode: 'nothing_to_undo',
    message: UNDO_REFUSALS[state],
  };
}

type Safety =
  { ok: true; defaultBranch: string; publishedSha: string } | { ok: false; errorCode: ErrorCode };

/**
 * What must be true before the act, checked under `gating` so a client sees
 * the check happen and sees it fail in plain words when it does.
 *
 * Publishing: no change may be mid-flight on this very branch, and the change
 * must contain the site's current tip — brought up to date here when it does
 * not (FR-030). Undoing: reversal reinstates what the site had immediately
 * before this change, which is only the client's own change to take back
 * while nothing has landed since.
 */
async function checkSafety(
  deps: PublicationDeps,
  input: PublicationInput,
  branch: string,
  requestId: string,
): Promise<Safety> {
  const defaultBranch = await deps.client.getDefaultBranch();

  if (input.kind === 'publish') {
    // Inspected rather than taken: this finishes in a moment, and holding the
    // lock would make a publish look like a change request to the next caller.
    if (await deps.lock.inspect()) return { ok: false, errorCode: 'request_in_flight' };
    const freshness = await readChangeFreshness(deps.client, { branch, defaultBranch });
    if (freshness.outOfDate) {
      const updated = await bringUpToDate(deps, input, { branch, defaultBranch, requestId });
      if (!updated.ok) return updated;
    }
    return { ok: true, defaultBranch, publishedSha: '' };
  }

  const pullRequest = await deps.client.getPullRequest(input.conversationNumber);
  const publishedSha = pullRequest?.mergeCommitSha;
  if (!publishedSha) return { ok: false, errorCode: 'internal_error' };

  const siteTip = await deps.client.getRef(`refs/heads/${defaultBranch}`);
  if (!siteTip) return { ok: false, errorCode: 'site_unreachable' };
  if (siteTip.sha !== publishedSha) return { ok: false, errorCode: 'out_of_date' };

  return { ok: true, defaultBranch, publishedSha };
}

/**
 * The site's tip, merged into the change and previewed again before anything
 * goes live. Three endings short of success: a conflict, which needs a person;
 * a rebuilt preview that failed to build, which the client is told about the
 * same way a failed change is; and a preview that never appeared.
 */
async function bringUpToDate(
  deps: PublicationDeps,
  input: PublicationInput,
  target: { branch: string; defaultBranch: string; requestId: string },
): Promise<{ ok: true } | { ok: false; errorCode: ErrorCode }> {
  deps.bus.publish({ type: 'output', requestId: target.requestId, text: BRINGING_UP_TO_DATE });

  await deps.mirror.sync();
  const outcome = await deps.mirror.bringUpToDate(target.branch, target.defaultBranch);
  if (outcome.kind === 'conflict') return { ok: false, errorCode: 'site_conflict' };
  // The repository said the change was behind and the mirror says it is not:
  // the mirror was stale by a moment, and the merge is being asked of a tree
  // that already has it. Publishing what the client saw is still correct.
  if (outcome.kind === 'current') return { ok: true };

  try {
    const push = deps.push ?? pushBranch;
    await push(outcome.tree, target.branch, await deps.client.authenticatedRemoteUrl());
  } finally {
    await outcome.tree.dispose();
  }

  const preview = await waitForPreview(
    {
      netlify: deps.netlify,
      bus: deps.bus,
      requestId: target.requestId,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    },
    {
      conversationNumber: input.conversationNumber,
      commitSha: outcome.sha,
      timeoutMs: deps.previewTimeoutMs ?? deps.deployTimeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS,
      ...(deps.pollIntervalMs ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    },
  );
  if (preview.kind === 'build_failed') return { ok: false, errorCode: 'build_failed' };
  if (preview.kind === 'hosting_limit') return { ok: false, errorCode: 'hosting_limit' };
  if (preview.kind === 'timed_out') return { ok: false, errorCode: 'site_unreachable' };
  return { ok: true };
}

/** The client's own website, when the hosting provider will say. Absence costs a link, not a publish. */
async function readLiveUrl(netlify: NetlifyClient): Promise<string | undefined> {
  try {
    return (await netlify.getSite())?.publicUrl;
  } catch {
    return undefined;
  }
}

/**
 * Waits for the hosting provider to build the site from the commit that was
 * just written, the same way a preview is waited for. The outcome is
 * ephemeral by design: the record already says what was published and by
 * whom, and a build that failed after the fact is reported on the trail and
 * in the server log rather than rewritten into history.
 */
async function watchBuild(
  deps: PublicationDeps,
  input: { requestId: string; commitSha: string; liveUrl?: string },
): Promise<PublicationEnding> {
  const now = () => (deps.now ?? (() => new Date()))().getTime();
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = now() + (deps.deployTimeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS);

  const ending = await pollUntilBuilt(deps, input.commitSha, input.liveUrl, {
    now,
    sleep,
    interval,
    deadline,
  });

  const finalStage: Stage = ending.outcome === 'succeeded' ? 'succeeded' : 'failed';
  deps.bus.publish({
    type: 'stage',
    requestId: input.requestId,
    stage: finalStage,
    at: new Date(now()).toISOString(),
  });
  deps.bus.publish({
    type: 'done',
    requestId: input.requestId,
    outcome: ending.outcome,
    ...(ending.outcome === 'succeeded' && ending.liveUrl ? { liveUrl: ending.liveUrl } : {}),
    ...(ending.outcome === 'failed' ? { errorCode: ending.errorCode } : {}),
  });

  if (ending.outcome === 'failed') {
    log.error('publication.failed', {
      requestId: input.requestId,
      kind: 'production_build',
      errorCode: ending.errorCode,
      commitSha: input.commitSha,
    });
  }
  return ending;
}

async function pollUntilBuilt(
  deps: PublicationDeps,
  commitSha: string,
  liveUrl: string | undefined,
  clock: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    interval: number;
    deadline: number;
  },
): Promise<PublicationEnding> {
  while (clock.now() < clock.deadline) {
    let deploy = null;
    try {
      deploy = await deps.netlify.findDeployByCommit(commitSha);
    } catch (cause) {
      // The plan being out is an ending; a provider that fails to answer once
      // is asked again, and only the deadline ends that wait.
      if (isNetlifyPlanLimit(cause)) return { outcome: 'failed', errorCode: 'hosting_limit' };
      log.warn('publication.failed', {
        commitSha,
        kind: 'deploy_list_retry',
        error: describe(cause),
      });
    }
    const effect = deploy ? deployEffect(deploy) : { kind: 'ignore' as const };
    if (effect.kind === 'preview_ready')
      return { outcome: 'succeeded', ...(liveUrl ? { liveUrl } : {}) };
    if (effect.kind === 'build_failed') return { outcome: 'failed', errorCode: 'build_failed' };
    if (effect.kind === 'hosting_limit') return { outcome: 'failed', errorCode: 'hosting_limit' };

    await clock.sleep(Math.min(clock.interval, Math.max(0, clock.deadline - clock.now())));
  }
  return { outcome: 'failed', errorCode: 'site_unreachable' };
}
