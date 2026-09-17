import { describe, expect, it, vi } from 'vitest';

import { claimConversationBranch } from '@/lib/conversations';
import { createFakeRepoClient } from '@/lib/github/fake';
import { createJobBus } from '@/lib/jobs/bus';
import { beginPublication, type PublicationDeps } from '@/lib/jobs/publication';
import type { Mirror, UpToDateOutcome, WorkingTree } from '@/lib/mirror/types';
import { createFakeNetlifyClient } from '@/lib/netlify/fake';
import type { Deploy } from '@/lib/netlify/types';
import { createFakeMailer } from '@/lib/notify/email';
import { renderRecord } from '@/lib/record';
import type { Env, JobEvent, RequestAnnouncement, RequestRecord } from '@/types';

/**
 * Publishing and undoing as requests the client can watch: announced on the
 * bus, moving through honest stages, and ending in `done` only once the
 * hosting provider has built the site — or given up.
 */

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
  totpSecret: 'JBSWY3DPEHPK3PXP',
  smtpUrl: 'smtp://localhost:1025',
  smtpFrom: 'webagent@client.example',
  publicBaseUrl: 'http://localhost:3000',
};

/**
 * A mirror that does what a test tells it: no git, because the git half is
 * proven in tests/unit/mirror/mirror.test.ts and the integration suite. What
 * matters here is what publishing does with each answer.
 */
function fakeMirror(
  outcome: UpToDateOutcome = { kind: 'current' },
): Mirror & { calls: string[]; synced: number } {
  const calls: string[] = [];
  const mirror = {
    calls,
    synced: 0,
    async sync() {
      mirror.synced += 1;
    },
    async checkout() {
      throw new Error('publishing never checks a tree out');
    },
    async bringUpToDate(branch: string, baseBranch: string) {
      calls.push(`${branch}<-${baseBranch}`);
      return outcome;
    },
    async fetchRef() {
      throw new Error('publishing never restores kept work');
    },
  };
  return mirror;
}

function fakeTree(): WorkingTree & { disposed: number } {
  const tree = {
    dir: '/nowhere',
    branch: 'webagent/c-1',
    baseSha: 'x',
    disposed: 0,
    async dispose() {
      tree.disposed += 1;
    },
  };
  return tree;
}

function world(options: { held?: boolean; upToDate?: UpToDateOutcome } = {}) {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 2, 10, 0, 0) + tick++);
  const client = createFakeRepoClient({ defaultBranch: 'main', now });
  const netlify = createFakeNetlifyClient({ deploys: [] });
  const bus = createJobBus();
  const mailer = createFakeMailer();
  const mirror = fakeMirror(options.upToDate);
  const pushes: string[] = [];
  const events: JobEvent[] = [];
  const announced: RequestAnnouncement[] = [];

  const deps: PublicationDeps = {
    client,
    netlify,
    bus,
    lock: { inspect: async () => (options.held ? { heldSince: 'now' } : null) },
    mirror,
    mailer,
    env: ENV,
    now,
    sleep: async () => {},
    deployTimeoutMs: 50,
    pollIntervalMs: 10,
    push: async (_tree, branch) => {
      pushes.push(branch);
    },
  };

  return { client, netlify, bus, mailer, mirror, pushes, deps, events, announced, watch };

  function watch(conversationNumber: number) {
    bus.subscribeConversation(conversationNumber, (announcement) => {
      announced.push(announcement);
      bus.subscribe(announcement.requestId, (event) => events.push(event));
    });
  }
}

async function openConversation(client: ReturnType<typeof createFakeRepoClient>) {
  const base = await client.getRef('refs/heads/main');
  const { branch } = await claimConversationBranch(client, base!.sha);
  return client.createPullRequest({ title: 'Shorten it', head: branch, base: 'main', body: '' });
}

async function previewed(client: ReturnType<typeof createFakeRepoClient>): Promise<number> {
  const pullRequest = await openConversation(client);
  const record: RequestRecord = {
    requestId: 'r_fixture',
    startedAt: '2026-09-02T09:00:00Z',
    finishedAt: '2026-09-02T09:04:00Z',
    outcome: 'succeeded',
    stages: [{ stage: 'succeeded', at: '2026-09-02T09:04:00Z' }],
    previewUrl: 'https://deploy-preview-1--client.netlify.app',
  };
  await client.createComment(pullRequest.number, renderRecord('Your preview is ready.', record));
  return pullRequest.number;
}

function productionDeploy(commitSha: string, state: Deploy['state']): Deploy {
  return {
    id: `d-${commitSha}`,
    state,
    context: 'production',
    commitRef: commitSha,
    deployUrl: 'https://client.example',
    createdAt: '2026-09-02T10:05:00Z',
  };
}

function stagesOf(events: JobEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'stage' ? [event.stage] : []));
}

describe('publishing', () => {
  it('announces itself, walks the honest stages, and ends once the site is built', async () => {
    const w = world();
    const number = await previewed(w.client);
    w.watch(number);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane@client.example',
    });
    if (!begun.ok) throw new Error(`should have begun: ${begun.reason}`);

    expect(w.announced).toEqual([
      { conversationNumber: number, requestId: begun.requestId, kind: 'publish' },
    ]);
    expect(stagesOf(w.events)).toEqual(['starting', 'gating', 'pushing', 'building']);
    expect(begun.record.requestId).toBe(begun.requestId);

    const merged = w.client.state.pullRequests.find((pr) => pr.number === number)!;
    expect(merged.merged).toBe(true);
    w.netlify.addDeploy(productionDeploy(merged.mergeCommitSha!, 'ready'));

    await expect(begun.completed).resolves.toEqual({
      outcome: 'succeeded',
      liveUrl: 'https://client-site.example',
    });
    expect(stagesOf(w.events).at(-1)).toBe('succeeded');
    expect(w.events.at(-1)).toMatchObject({
      type: 'done',
      outcome: 'succeeded',
      liveUrl: 'https://client-site.example',
    });
    expect(w.bus.activeRequest(number)).toBeNull();
  });

  it('reports a production build that failed, without touching the record', async () => {
    const w = world();
    const number = await previewed(w.client);
    w.watch(number);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });
    if (!begun.ok) throw new Error('should have begun');
    const merged = w.client.state.pullRequests.find((pr) => pr.number === number)!;
    w.netlify.addDeploy(productionDeploy(merged.mergeCommitSha!, 'error'));

    await expect(begun.completed).resolves.toEqual({
      outcome: 'failed',
      errorCode: 'build_failed',
    });
    expect(w.events.at(-1)).toMatchObject({
      type: 'done',
      outcome: 'failed',
      errorCode: 'build_failed',
    });
  });

  it('gives up on a build that never appears, as unreachable rather than as a success', async () => {
    const w = world();
    const number = await previewed(w.client);
    w.watch(number);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });
    if (!begun.ok) throw new Error('should have begun');

    await expect(begun.completed).resolves.toEqual({
      outcome: 'failed',
      errorCode: 'site_unreachable',
    });
  });

  it('refuses without announcing anything when there is nothing to publish', async () => {
    const w = world();
    const pullRequest = await openConversation(w.client);
    w.watch(pullRequest.number);

    const begun = await beginPublication(w.deps, {
      conversationNumber: pullRequest.number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'refused', errorCode: 'nothing_to_publish' });
    expect(w.announced).toHaveLength(0);
  });

  it('fails on the trail, in the open, when a change is still being applied', async () => {
    const w = world({ held: true });
    const number = await previewed(w.client);
    w.watch(number);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'failed', errorCode: 'request_in_flight' });
    expect(stagesOf(w.events)).toEqual(['starting', 'gating', 'failed']);
    expect(w.events.at(-1)).toMatchObject({
      type: 'done',
      outcome: 'failed',
      errorCode: 'request_in_flight',
    });
    expect(w.client.state.pullRequests.find((pr) => pr.number === number)!.merged).toBe(false);
  });

  it('answers a conversation that does not exist plainly', async () => {
    const w = world();
    expect(
      await beginPublication(w.deps, { conversationNumber: 99, kind: 'publish', actor: 'jane' }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('undoing', () => {
  it('reverts, records, and waits for the rebuilt site', async () => {
    const w = world();
    const number = await previewed(w.client);
    const published = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });
    if (!published.ok) throw new Error('should have published');
    const merged = w.client.state.pullRequests.find((pr) => pr.number === number)!;
    w.netlify.addDeploy(productionDeploy(merged.mergeCommitSha!, 'ready'));
    await published.completed;

    w.watch(number);
    const undone = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'undo',
      actor: 'jane',
    });
    if (!undone.ok) throw new Error(`should have undone: ${undone.reason}`);

    expect(w.announced[0]).toMatchObject({ kind: 'undo' });
    expect(stagesOf(w.events)).toEqual(['starting', 'gating', 'pushing', 'building']);
    const tip = w.client.state.refs['refs/heads/main']!;
    expect(tip.sha).not.toBe(merged.mergeCommitSha);
    w.netlify.addDeploy(productionDeploy(tip.sha, 'ready'));

    await expect(undone.completed).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(w.mailer.sent.map((m) => m.subject).join(' ')).toMatch(/undone|back/i);
  });

  it('refuses to undo something that was never published', async () => {
    const w = world();
    const number = await previewed(w.client);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'undo',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'refused', errorCode: 'nothing_to_undo' });
  });
});

describe('when the record cannot be written after the act', () => {
  it('reports a failure rather than a smooth publish, and does not start watching the build', async () => {
    const w = world();
    const number = await previewed(w.client);
    w.watch(number);
    const failing = {
      ...w.deps,
      client: {
        ...w.client,
        createComment: async () => {
          throw new Error('comments are down');
        },
      },
    };

    const begun = await beginPublication(failing, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'failed', errorCode: 'internal_error' });
    expect(stagesOf(w.events)).toEqual(['starting', 'gating', 'pushing', 'failed']);
    // The merge itself happened — the site's history is the truth, and it is not hidden.
    expect(w.client.state.pullRequests.find((pr) => pr.number === number)!.merged).toBe(true);
  });
});

/**
 * FR-030: a change whose site moved on since its preview is brought up to
 * date and previewed again before it goes live, under the one button the
 * client pressed. Only a conflict is refused.
 */
describe('publishing a change the site has moved past', () => {
  /** Another conversation published, or a developer pushed: main gains a commit the change lacks. */
  async function advanceSite(client: ReturnType<typeof createFakeRepoClient>): Promise<void> {
    const tip = await client.getRef('refs/heads/main');
    const sha = await client.createLockCommit("someone else's work", tip!.sha);
    client.state.refs['refs/heads/main'] = {
      ref: 'refs/heads/main',
      sha,
      committedAt: new Date().toISOString(),
    };
  }

  function previewDeploy(
    conversationNumber: number,
    commitSha: string,
    state: Deploy['state'],
  ): Deploy {
    return {
      id: `p-${commitSha}`,
      state,
      context: 'deploy-preview',
      reviewId: conversationNumber,
      commitRef: commitSha,
      deployUrl: `https://deploy-preview-${conversationNumber}--client.netlify.app`,
      createdAt: '2026-09-02T10:06:00Z',
    };
  }

  it('merges the site into the change, waits for the fresh preview, then publishes', async () => {
    const tree = fakeTree();
    const w = world({ upToDate: { kind: 'merged', tree, sha: 'merge-sha' } });
    const number = await previewed(w.client);
    await advanceSite(w.client);
    w.netlify.addDeploy(previewDeploy(number, 'merge-sha', 'ready'));
    w.watch(number);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    if (!begun.ok) throw new Error(`should have begun: ${begun.reason}`);
    expect(w.mirror.synced).toBe(1);
    expect(w.mirror.calls).toEqual([`webagent/c-${number}<-main`]);
    expect(w.pushes).toEqual([`webagent/c-${number}`]);
    expect(tree.disposed).toBe(1);
    expect(stagesOf(w.events)).toEqual(['starting', 'gating', 'pushing', 'building']);
    expect(
      w.events.some((event) => event.type === 'output' && /up to date/i.test(event.text)),
    ).toBe(true);
    expect(w.client.state.pullRequests.find((pr) => pr.number === number)!.merged).toBe(true);
  });

  it('publishes without merging when the mirror finds the change already current', async () => {
    const w = world({ upToDate: { kind: 'current' } });
    const number = await previewed(w.client);
    await advanceSite(w.client);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun.ok).toBe(true);
    expect(w.pushes).toEqual([]);
  });

  it('refuses a conflict in the open, in words that send the client to a new conversation', async () => {
    const w = world({ upToDate: { kind: 'conflict' } });
    const number = await previewed(w.client);
    await advanceSite(w.client);
    w.watch(number);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'failed', errorCode: 'site_conflict' });
    expect(stagesOf(w.events)).toEqual(['starting', 'gating', 'failed']);
    expect(w.client.state.pullRequests.find((pr) => pr.number === number)!.merged).toBe(false);
  });

  it('does not publish a merge whose preview failed to build', async () => {
    const tree = fakeTree();
    const w = world({ upToDate: { kind: 'merged', tree, sha: 'merge-sha' } });
    const number = await previewed(w.client);
    await advanceSite(w.client);
    w.netlify.addDeploy(previewDeploy(number, 'merge-sha', 'error'));

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'failed', errorCode: 'build_failed' });
    expect(tree.disposed).toBe(1);
    expect(w.client.state.pullRequests.find((pr) => pr.number === number)!.merged).toBe(false);
  });

  it('does not publish a merge whose preview never appeared', async () => {
    const w = world({ upToDate: { kind: 'merged', tree: fakeTree(), sha: 'merge-sha' } });
    const number = await previewed(w.client);
    await advanceSite(w.client);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'failed', errorCode: 'site_unreachable' });
  });

  it('still disposes of the tree when the push itself fails, and reports the failure', async () => {
    const tree = fakeTree();
    const w = world({ upToDate: { kind: 'merged', tree, sha: 'merge-sha' } });
    w.deps.push = async () => {
      throw new Error('remote hung up');
    };
    const number = await previewed(w.client);
    await advanceSite(w.client);

    const begun = await beginPublication(w.deps, {
      conversationNumber: number,
      kind: 'publish',
      actor: 'jane',
    });

    expect(begun).toMatchObject({ ok: false, reason: 'failed', errorCode: 'internal_error' });
    expect(tree.disposed).toBe(1);
  });
});

/** Every JSON line the logger writes while `run` executes, parsed. */
async function loggedDuring<T>(
  run: () => Promise<T>,
): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    for (const raw of String(chunk).split('\n')) if (raw) lines.push(JSON.parse(raw));
    return true;
  });
  try {
    return { result: await run(), lines };
  } finally {
    spy.mockRestore();
  }
}

describe("the collector's view of a publication", () => {
  it('logs publication.ended with the kind once the act is recorded, publish and undo alike', async () => {
    const w = world();
    const number = await previewed(w.client);

    const published = await loggedDuring(() =>
      beginPublication(w.deps, { conversationNumber: number, kind: 'publish', actor: 'jane' }),
    );
    if (!published.result.ok) throw new Error('should have published');
    const merged = w.client.state.pullRequests.find((pr) => pr.number === number)!;
    w.netlify.addDeploy(productionDeploy(merged.mergeCommitSha!, 'ready'));
    await published.result.completed;

    const undone = await loggedDuring(() =>
      beginPublication(w.deps, { conversationNumber: number, kind: 'undo', actor: 'jane' }),
    );
    if (!undone.result.ok) throw new Error(`should have undone: ${undone.result.reason}`);

    const ended = [...published.lines, ...undone.lines].filter(
      (line) => line.event === 'publication.ended',
    );
    expect(ended).toEqual([
      expect.objectContaining({
        level: 'info',
        kind: 'publish',
        conversationNumber: number,
        requestId: published.result.requestId,
        commitSha: merged.mergeCommitSha,
      }),
      expect.objectContaining({
        level: 'info',
        kind: 'undo',
        conversationNumber: number,
        requestId: undone.result.requestId,
        commitSha: w.client.state.refs['refs/heads/main']!.sha,
      }),
    ]);
    // Who pressed the button is for the audit entry in the repository, not
    // for an external log service.
    expect(ended.some((line) => 'actor' in line)).toBe(false);
  });

  it('does not log publication.ended when the publish was refused or failed', async () => {
    const w = world({ held: true });
    const number = await previewed(w.client);
    const refused = await loggedDuring(() =>
      beginPublication(w.deps, { conversationNumber: number, kind: 'publish', actor: 'jane' }),
    );
    expect(refused.result.ok).toBe(false);
    expect(refused.lines.filter((line) => line.event === 'publication.ended')).toEqual([]);
  });
});
