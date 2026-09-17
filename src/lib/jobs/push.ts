import { hardenedGit } from '@/lib/git/harden';
import type { WorkingTree } from '@/lib/mirror/types';

/**
 * Pushing is a host capability, deliberately not a property of the working tree.
 *
 * The tree the agent worked in has no remote (R2, FR-015), which is what makes
 * pushing impossible from inside the container rather than merely forbidden.
 * That guarantee only holds if the remote is never added to the tree — so the
 * credential is supplied to a single push invocation and never written to the
 * tree's configuration, where it would survive the request that needed it.
 */
export async function pushBranch(
  tree: WorkingTree,
  branch: string,
  remoteUrl: string,
): Promise<void> {
  const git = hardenedGit(tree.dir);

  try {
    await git.raw(['push', remoteUrl, `HEAD:refs/heads/${branch}`]);
  } catch (cause) {
    // The URL carries an access token. A raw git error message quotes the
    // remote it failed against, so it can never be forwarded unredacted.
    throw new Error(`could not push ${branch}: ${redactRemote(cause, remoteUrl)}`);
  }
}

/**
 * Pushes HEAD to a ref outside `refs/heads`, replacing whatever it held.
 *
 * Forced because the ref is a slot, not a history: kept work is replaced by
 * newer kept work, and nothing ever builds on it (src/lib/jobs/wip.ts).
 */
export async function pushRef(tree: WorkingTree, ref: string, remoteUrl: string): Promise<void> {
  const git = hardenedGit(tree.dir);

  try {
    await git.raw(['push', '--force', remoteUrl, `HEAD:${ref}`]);
  } catch (cause) {
    throw new Error(`could not push ${ref}: ${redactRemote(cause, remoteUrl)}`);
  }
}

/** Removes a ref from the remote. The ref must exist: git refuses to delete one that does not. */
export async function deleteRemoteRef(
  tree: WorkingTree,
  ref: string,
  remoteUrl: string,
): Promise<void> {
  const git = hardenedGit(tree.dir);

  try {
    await git.raw(['push', remoteUrl, `:${ref}`]);
  } catch (cause) {
    throw new Error(`could not delete ${ref}: ${redactRemote(cause, remoteUrl)}`);
  }
}

function redactRemote(cause: unknown, remoteUrl: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message
    .split(remoteUrl)
    .join('<remote>')
    .replace(/x-access-token:[^@\s]+/g, '<redacted>');
}
