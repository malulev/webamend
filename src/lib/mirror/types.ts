import type { ChangedFile } from '@/types';

/**
 * The bare mirror is a cache, never a source of truth (R8). Deleting it costs
 * time, not correctness, so every operation here tolerates its absence.
 */

export interface WorkingTree {
  /** Host path of the working tree, mounted into the container at `/work`. */
  dir: string;
  branch: string;
  /** The commit the tree started from, before the agent touched anything. */
  baseSha: string;
  /** Removes the tree. Called on every path, including a blocked change. */
  dispose(): Promise<void>;
}

/**
 * What bringing a change up to date with the site produced.
 *
 * `current`: nothing to do, the branch already contains the site's tip.
 * `merged`: a merge commit now sits on the branch in `tree`, unpushed; the
 * caller pushes it and disposes of the tree. `conflict`: the site and the
 * change edit the same lines, which no host-side merge can settle; nothing
 * was left behind.
 */
export type UpToDateOutcome =
  | { kind: 'current' }
  | { kind: 'conflict' }
  | { kind: 'merged'; tree: WorkingTree; sha: string };

export interface Mirror {
  /** Creates or updates the bare mirror, rebuilding it when corrupt. */
  sync(): Promise<void>;
  /**
   * A fresh working tree at `branch`, created from `baseBranch` when the
   * branch does not yet exist.
   */
  checkout(branch: string, baseBranch: string): Promise<WorkingTree>;
  /**
   * Merges `baseBranch`'s tip into `branch` in a fresh working tree, with the
   * host as author (FR-030: "update it before publishing"). The container is
   * never involved: this is the host's own git, on a tree the agent never
   * touched.
   */
  bringUpToDate(branch: string, baseBranch: string): Promise<UpToDateOutcome>;
  /**
   * Brings `ref` from the mirror into `tree` and answers the commit it names,
   * or `null` when the mirror holds no such ref. For refs a clone does not
   * carry (anything outside `refs/heads`); the tree gains no remote by it.
   */
  fetchRef(tree: WorkingTree, ref: string): Promise<string | null>;
}

export interface ChangeSet {
  files: ChangedFile[];
  totalDiffLines: number;
}

/** Derives the change set from a working tree's status: adds, edits, deletes. */
export type DeriveChangeSet = (tree: WorkingTree) => Promise<ChangeSet>;
