import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

import { createFakeRepoClient } from '@/lib/github/fake';
import { createJobBus } from '@/lib/jobs/bus';
import { createLock } from '@/lib/lock/lock';
import { createFakeNetlifyClient } from '@/lib/netlify/fake';
import { createFakeMailer } from '@/lib/notify/email';
import { DEFAULT_POLICY } from '@/lib/policy/parse';
import { createFakeRunner, type FakeRunnerScript } from '@/lib/runner/fake';
import type { AgentSlots } from '@/lib/runner/slots';
import type { RunDeps } from '@/lib/jobs/run';
import type { Mirror, WorkingTree } from '@/lib/mirror/types';
import type { Env, RepoConfig } from '@/types';

/**
 * A whole installation, in a temporary directory.
 *
 * The mirror, the working trees and the origin are real git repositories,
 * because the behaviours US1 depends on — an untracked file counting as a
 * change, a commit staging only the permitted paths, a follow-up landing on the
 * branch that already exists — are the ones a mocked git would get wrong.
 * Everything that would otherwise reach a network is a fake.
 */

export interface Harness {
  deps: RunDeps;
  client: ReturnType<typeof createFakeRepoClient>;
  netlify: ReturnType<typeof createFakeNetlifyClient>;
  bus: ReturnType<typeof createJobBus>;
  runner: ReturnType<typeof createFakeRunner>;
  lock: ReturnType<typeof createLock>;
  /** Records the developer alerts a run raised, so a test can read them back. */
  mailer: ReturnType<typeof createFakeMailer>;
  /** The bare repository the push lands in, standing in for GitHub. */
  originDir: string;
  /** Branches the mirror was asked for, in order. */
  checkouts: string[];
  trees: WorkingTree[];
  cleanup(): Promise<void>;
}

const ENV: Env = {
  githubAppId: '1',
  githubAppPrivateKey: 'key',
  githubInstallationId: 1,
  githubRepoOwner: 'client-org',
  githubRepoName: 'client-site',
  netlifyToken: 'token',
  netlifySiteId: 'site',
  netlifyWebhookSecret: 'secret',
  openrouterApiKey: 'key',
  sessionSecret: 'a'.repeat(32),
  allowedEmails: ['jane@client.example'],
  // A base32 secret long enough for TOTP; a fixture that would be rejected as
  // unusable describes an installation that could not start.
  totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  smtpUrl: 'smtp://localhost:1025',
  smtpFrom: 'webagent@client.example',
  publicBaseUrl: 'http://localhost:3000',
};

export const CONFIG: RepoConfig = {
  settings: {
    alertContact: 'dev@agency.example',
    costCeilingUsd: 2,
    model: 'openrouter/anthropic/claude-sonnet-latest',
    maxRequestMinutes: 10,
  },
  policy: { ...DEFAULT_POLICY, allow: ['src/**', 'public/**'] },
  guidance: 'Use sentence case in headings.',
};

export interface HarnessOptions {
  script?: FakeRunnerScript;
  config?: RepoConfig;
  seedFiles?: Record<string, string>;
  /**
   * How long a test is willing to wait for a preview. The default is minutes,
   * which is right for a real hosting provider and useless in a test that
   * wants to see what happens when no deploy ever arrives.
   */
  previewTimeoutMs?: number;
  /** Host-wide agent slots. Absent, every request runs at once, as before. */
  slots?: AgentSlots;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'webagent-int-'));
  const originDir = join(root, 'origin.git');
  await buildOrigin(root, originDir, options.seedFiles ?? { 'src/index.html': '<h1>Hello</h1>\n' });

  const client = createFakeRepoClient({ defaultBranch: 'main' });
  // The push step asks the client where to push. Pointing it at the local bare
  // repository is what makes the push in these tests real rather than stubbed.
  const pushable = { ...client, authenticatedRemoteUrl: async () => originDir };

  const netlify = createFakeNetlifyClient({ deploys: [] });
  const bus = createJobBus();
  const runner = createFakeRunner(options.script ?? {});
  const lock = createLock(client);
  const mailer = createFakeMailer();

  const checkouts: string[] = [];
  const trees: WorkingTree[] = [];

  const deps: RunDeps = {
    client: pushable,
    lock,
    mirror: buildMirror(root, originDir, checkouts, trees),
    runner,
    ...(options.slots ? { slots: options.slots } : {}),
    netlify,
    bus,
    mailer,
    env: ENV,
    config: options.config ?? CONFIG,
    workRoot: root,
    ...(options.previewTimeoutMs ? { previewTimeoutMs: options.previewTimeoutMs } : {}),
  };

  return {
    deps,
    client,
    netlify,
    bus,
    runner,
    lock,
    mailer,
    originDir,
    checkouts,
    trees,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** What the origin holds on a branch, so a test can assert what was pushed. */
export async function readPushedFile(
  originDir: string,
  branch: string,
  path: string,
): Promise<string | null> {
  try {
    return await simpleGit(originDir).show([`${branch}:${path}`]);
  } catch {
    return null;
  }
}

export async function branchExists(originDir: string, branch: string): Promise<boolean> {
  const branches = await simpleGit(originDir).branch([]);
  return branches.all.includes(branch);
}

// ---------------------------------------------------------------------------

async function buildOrigin(
  root: string,
  originDir: string,
  files: Record<string, string>,
): Promise<void> {
  const seedDir = join(root, 'seed');
  await mkdir(seedDir, { recursive: true });

  const git = simpleGit(seedDir);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'Fixture');
  await git.addConfig('user.email', 'fixture@example.com');
  await git.addConfig('commit.gpgsign', 'false');

  for (const [path, contents] of Object.entries(files)) {
    const full = join(seedDir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }

  await git.add('.');
  await git.commit('seed the fixture site');

  // A bare clone, because a push into a non-bare repository's checked-out
  // branch is refused by git — as it would be by any real remote.
  await simpleGit().clone(seedDir, originDir, ['--bare']);
}

function buildMirror(
  root: string,
  originDir: string,
  checkouts: string[],
  trees: WorkingTree[],
): Mirror {
  const cacheDir = join(root, 'mirror.git');
  let synced = false;

  return {
    async sync() {
      if (!synced) {
        await simpleGit().clone(originDir, cacheDir, ['--mirror']);
        synced = true;
        return;
      }
      await simpleGit(cacheDir).fetch(['--prune']);
    },

    async checkout(branch, baseBranch) {
      checkouts.push(branch);
      const dir = join(root, `tree-${trees.length}`);
      await simpleGit().clone(cacheDir, dir);

      const tree = simpleGit(dir);
      await tree.addConfig('user.name', 'Site Editor');
      await tree.addConfig('user.email', 'webagent@client.example');
      await tree.addConfig('commit.gpgsign', 'false');

      const known = await tree.branch(['-a']);
      const exists = known.all.some((name) => name === branch || name.endsWith(`/${branch}`));
      await (exists ? tree.checkout(branch) : tree.checkoutLocalBranch(branch));
      void baseBranch;

      // The agent's tree has no remote (R2, FR-015): pushing must be impossible
      // rather than merely forbidden.
      await tree.removeRemote('origin').catch(() => undefined);

      const workingTree: WorkingTree = {
        dir,
        branch,
        baseSha: await tree.revparse(['HEAD']),
        dispose: () => rm(dir, { recursive: true, force: true }),
      };
      trees.push(workingTree);
      return workingTree;
    },

    // Real git, like everything else here: a conflict has to be a conflict
    // git itself reports, not one a fake decided on.
    async bringUpToDate(branch, baseBranch) {
      const dir = join(root, `update-${trees.length}`);
      await simpleGit().clone(cacheDir, dir);
      const tree = simpleGit(dir);
      await tree.addConfig('user.name', 'Site Editor');
      await tree.addConfig('user.email', 'webagent@client.example');
      await tree.addConfig('commit.gpgsign', 'false');
      await tree.checkout(['-b', branch, `origin/${branch}`]);
      const before = await tree.revparse(['HEAD']);
      const merged = await tree
        .raw([
          'merge',
          '--no-edit',
          `origin/${baseBranch}`,
          '-m',
          'bring this change up to date with the site',
        ])
        .then(
          () => true,
          () => false,
        );
      if (!merged || (await tree.status()).conflicted.length > 0) {
        await rm(dir, { recursive: true, force: true });
        return { kind: 'conflict' };
      }
      const after = await tree.revparse(['HEAD']);
      if (after === before) {
        await rm(dir, { recursive: true, force: true });
        return { kind: 'current' };
      }
      await tree.removeRemote('origin');
      const workingTree: WorkingTree = {
        dir,
        branch,
        baseSha: before,
        dispose: () => rm(dir, { recursive: true, force: true }),
      };
      trees.push(workingTree);
      return { kind: 'merged', tree: workingTree, sha: after };
    },

    async fetchRef(tree, ref) {
      const held = await simpleGit(cacheDir).raw(['for-each-ref', ref]);
      if (held.trim().length === 0) return null;
      const git = simpleGit(tree.dir);
      await git.raw(['fetch', '--no-tags', cacheDir, ref]);
      return (await git.revparse(['FETCH_HEAD'])).trim();
    },
  };
}
