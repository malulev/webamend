import type { PlacedAttachment } from '@/lib/jobs/attachments';
import { verifyPlaced } from '@/lib/jobs/attachments';
import { deleteRemoteRef, pushRef } from '@/lib/jobs/push';
import { hardenedGit } from '@/lib/git/harden';
import { describe, log } from '@/lib/log';
import { commitPermittedPaths, deriveChangeSet } from '@/lib/mirror/changeset';
import type { Mirror, WorkingTree } from '@/lib/mirror/types';
import { gate } from '@/lib/policy/gate';
import type { ErrorCode, Policy } from '@/types';

/**
 * Work kept from a run that was interrupted through no fault of the request.
 *
 * A provider that runs dry or a clock that runs out used to cost the client
 * everything the agent had done, because the working tree is deleted on every
 * ending. The edits are now committed to a ref of their own, one per
 * conversation, and handed to the conversation's next request.
 *
 * The ordering in run.ts is the security design, and this keeps to it:
 *
 * - Kept work passes the gate before it is kept. What the gate would refuse
 *   is discarded exactly as before (FR-018).
 * - The ref lives outside `refs/heads`, so nothing builds a preview from it
 *   and it never appears on the conversation's pull request.
 * - It is restored as uncommitted edits, not as a commit. The next run's gate
 *   therefore judges the whole change again, kept half included, and only a
 *   run that finishes publishes. "Never commit what a dead agent left behind"
 *   still holds: what it left waits for a live one.
 *
 * It sits on the remote rather than in the state directory because the state
 * directory is a cache (R8) and the remote is the only history this product
 * has.
 *
 * Keeping and clearing never fail a request: they are a courtesy on top of an
 * ending that has already been decided. Restoring is the exception. A restore
 * that throws has left the tree in a state nobody can describe, and a request
 * must not run on one.
 */

const WIP_REF_PREFIX = 'refs/webagent/wip/c-';

export function wipRefFor(conversationNumber: number): string {
  return `${WIP_REF_PREFIX}${conversationNumber}`;
}

/**
 * The endings worth resuming from: the run stopped, the request did not fail.
 *
 * A crash (`internal_error`) is absent because a tree nobody can vouch for is
 * no foundation; `cost_ceiling` because the ceiling is a decision to stop
 * spending on this change, and keeping the work would turn it into a discount.
 */
const RESUMABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'model_credit',
  'model_quota',
  'model_unavailable',
  'agent_timeout',
]);

export function isResumable(code: ErrorCode | undefined): boolean {
  return code !== undefined && RESUMABLE_CODES.has(code);
}

export interface WipDeps {
  client: { authenticatedRemoteUrl(): Promise<string> };
  mirror: Pick<Mirror, 'fetchRef'>;
  policy: Policy;
  author: { name: string; email: string };
}

export interface WipContext {
  tree: WorkingTree;
  conversationNumber: number;
  requestId: string;
}

/** Keeps the tree's edits for the next request. Answers whether anything was kept. */
export async function saveWip(
  deps: WipDeps,
  context: WipContext & { errorCode: ErrorCode; placed: PlacedAttachment[] },
): Promise<boolean> {
  const { tree, conversationNumber, requestId, errorCode } = context;
  try {
    const changeSet = await deriveChangeSet(tree);
    if (changeSet.files.length === 0) return false;

    const attachedPaths = await verifyPlaced(tree.dir, context.placed);
    const verdict = gate(changeSet.files, deps.policy, { attachedPaths });
    if (!verdict.ok) {
      log.warn('wip.dropped', {
        requestId,
        conversationNumber,
        reason: 'refused',
        violation: verdict.violation,
      });
      return false;
    }

    const message = `keep work interrupted by ${errorCode}`;
    await commitPermittedPaths(tree, changeSet.files, message, deps.author);
    await pushRef(tree, wipRefFor(conversationNumber), await deps.client.authenticatedRemoteUrl());
    log.info('wip.saved', {
      requestId,
      conversationNumber,
      errorCode,
      filesSaved: changeSet.files.length,
      diffLines: changeSet.totalDiffLines,
    });
    return true;
  } catch (cause) {
    log.error('wip.save_failed', { requestId, conversationNumber, error: describe(cause) });
    return false;
  }
}

/**
 * Lays kept work over a fresh tree as uncommitted edits, and answers the paths
 * it touched. Empty when there was none, or when it no longer applies.
 *
 * Must run on the tree as cloned, before attachments are placed: undoing a
 * restore that did not apply resets the tree, and that would take anything
 * else in it along.
 */
export async function restoreWip(deps: WipDeps, context: WipContext): Promise<string[]> {
  const { tree, conversationNumber, requestId } = context;
  const sha = await deps.mirror.fetchRef(tree, wipRefFor(conversationNumber));
  if (sha === null) return [];

  const paths = await applyUncommitted(tree, sha);
  if (paths.length === 0) {
    // The branch moved under the kept work, or already contains it. Either
    // way it is spent: left in place it would be tried again on every request.
    log.warn('wip.dropped', { requestId, conversationNumber, reason: 'stale' });
    await clearWip(deps, context);
    return [];
  }

  log.info('wip.restored', { requestId, conversationNumber, filesRestored: paths.length });
  return paths;
}

/** Removes the kept work from the remote. Only for a ref known to exist. */
export async function clearWip(deps: WipDeps, context: WipContext): Promise<void> {
  const { tree, conversationNumber, requestId } = context;
  try {
    const remoteUrl = await deps.client.authenticatedRemoteUrl();
    await deleteRemoteRef(tree, wipRefFor(conversationNumber), remoteUrl);
  } catch (cause) {
    // Survivable: work that is already on the branch restores to nothing next
    // time, which `restoreWip` reads as stale and clears again.
    log.error('wip.clear_failed', { requestId, conversationNumber, error: describe(cause) });
  }
}

/**
 * `cherry-pick --no-commit` rather than a checkout of the kept files, because
 * the branch may have moved since: a three-way apply keeps newer work the kept
 * commit never saw, and reports a conflict where a checkout would silently
 * overwrite. The index is reset afterwards because the change set is read from
 * unstaged status alone (changeset.ts) — staged edits would be invisible to
 * the gate.
 */
async function applyUncommitted(tree: WorkingTree, sha: string): Promise<string[]> {
  const git = hardenedGit(tree.dir);
  const applied = await git.raw(['cherry-pick', '--no-commit', sha]).then(
    () => true,
    () => false,
  );
  const conflicted = applied ? (await git.status()).conflicted.length > 0 : true;
  if (conflicted) {
    await git.raw(['reset', '--hard', 'HEAD']);
    await git.raw(['clean', '-fd']);
    return [];
  }

  await git.raw(['reset']);
  const status = await git.status(['--untracked-files=all']);
  return status.files.map((file) => file.path);
}
