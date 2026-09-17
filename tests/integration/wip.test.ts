import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';

import { claimConversationBranch } from '@/lib/conversations';
import { CLIENT_MESSAGES, WORK_KEPT_MESSAGE } from '@/lib/jobs/messages';
import { runRequest } from '@/lib/jobs/run';
import { wipRefFor } from '@/lib/jobs/wip';
import { parseComment } from '@/lib/record/record';
import type { FakeRunnerScript } from '@/lib/runner/fake';
import { branchExists, createHarness, readPushedFile, type Harness } from './harness';

/**
 * An interruption that is nobody's fault — the provider ran dry, the clock ran
 * out — used to cost the client everything the agent had done. The work is now
 * kept on a ref of its own and handed to the next request in the conversation.
 *
 * What is being defended is the boundary, not the convenience: kept work is
 * gated before it is kept, never lands on the conversation's branch by itself,
 * and is judged again, whole, before anything is published.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const OUT_OF_CREDIT = { statusCode: 402, message: 'Insufficient credits' };

function writes(path: string, contents: string) {
  return async (workDir: string) => {
    const full = join(workDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  };
}

function interruptedAfter(edit: FakeRunnerScript['edit']): FakeRunnerScript {
  return {
    exitCode: 1,
    edit,
    result: {
      summary: '',
      filesChanged: [],
      tokensIn: 900,
      tokensOut: 300,
      costUsd: 0.7,
      providerError: OUT_OF_CREDIT,
    },
  };
}

function finishesWith(edit: FakeRunnerScript['edit']): FakeRunnerScript {
  return {
    exitCode: 0,
    edit,
    result: {
      summary: 'I finished the change.',
      filesChanged: [],
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.2,
    },
  };
}

/** The fake runner holds its script by reference, so the next run is scripted by rewriting it. */
function rescript(script: FakeRunnerScript, next: FakeRunnerScript): void {
  for (const key of Object.keys(script)) delete script[key as keyof FakeRunnerScript];
  Object.assign(script, next);
}

async function openConversation(client: Harness['client']) {
  const base = await client.getRef('refs/heads/main');
  const { branch } = await claimConversationBranch(client, base!.sha);
  return client.createPullRequest({
    title: 'Change something',
    head: branch,
    base: 'main',
    body: 'Opened from a change request.',
  });
}

async function sendRequest(harnessed: Harness, number: number, branch: string, message: string) {
  return runRequest(harnessed.deps, {
    conversationNumber: number,
    branch,
    baseBranch: 'main',
    message,
    history: [],
  });
}

async function keptFile(originDir: string, number: number, path: string): Promise<string | null> {
  try {
    return await simpleGit(originDir).show([`${wipRefFor(number)}:${path}`]);
  } catch {
    return null;
  }
}

async function keptWorkExists(originDir: string, number: number): Promise<boolean> {
  const matches = await simpleGit(originDir).raw(['for-each-ref', wipRefFor(number)]);
  return matches.trim().length > 0;
}

async function lastComment(harnessed: Harness, number: number) {
  return parseComment((await harnessed.client.listComments(number)).at(-1)!);
}

/** Moves the conversation's branch under the kept work, the way a second editor would. */
async function commitToBranch(originDir: string, branch: string, path: string, contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'webagent-other-'));
  try {
    await simpleGit().clone(originDir, dir);
    const git = simpleGit(dir);
    await git.addConfig('user.name', 'Someone Else');
    await git.addConfig('user.email', 'else@example.com');
    await git.addConfig('commit.gpgsign', 'false');
    await git.checkoutLocalBranch(branch);
    await writes(path, contents)(dir);
    await git.add([path]);
    await git.commit('an edit from elsewhere');
    await git.raw(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('a provider that runs dry mid-edit', () => {
  it('keeps the work on a ref of its own, and nowhere a preview would build from', async () => {
    harness = await createHarness({
      script: interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n')),
    });
    const pullRequest = await openConversation(harness.client);

    const outcome = await sendRequest(
      harness,
      pullRequest.number,
      pullRequest.headRef,
      'Shorten it',
    );

    expect(outcome.started && outcome.outcome).toBe('failed');
    expect(await keptFile(harness.originDir, pullRequest.number, 'src/index.html')).toContain(
      'Built for speed',
    );
    expect(await branchExists(harness.originDir, pullRequest.headRef)).toBe(false);
    expect(await readPushedFile(harness.originDir, 'main', 'src/index.html')).toContain('Hello');
  });

  it('tells the client the work was kept, and records that it was', async () => {
    harness = await createHarness({
      script: interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n')),
    });
    const pullRequest = await openConversation(harness.client);

    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    const parsed = await lastComment(harness, pullRequest.number);
    expect(parsed.record?.errorCode).toBe('model_credit');
    expect(parsed.record?.wipSaved).toBe(true);
    expect(parsed.prose).toBe(`${CLIENT_MESSAGES.model_credit} ${WORK_KEPT_MESSAGE}`);
  });

  it('says nothing about kept work when the agent had changed nothing', async () => {
    harness = await createHarness({ script: interruptedAfter(undefined) });
    const pullRequest = await openConversation(harness.client);

    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    const parsed = await lastComment(harness, pullRequest.number);
    expect(parsed.record?.wipSaved).toBeUndefined();
    expect(parsed.prose).toBe(CLIENT_MESSAGES.model_credit);
    expect(await keptWorkExists(harness.originDir, pullRequest.number)).toBe(false);
  });
});

describe('the request after an interruption', () => {
  it('starts from the kept work, is told so, and publishes both halves', async () => {
    const script = interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n'));
    harness = await createHarness({ script, previewTimeoutMs: 50 });
    const pullRequest = await openConversation(harness.client);
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    rescript(script, finishesWith(writes('src/about.html', '<h1>About</h1>\n')));
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Carry on');

    const followUp = harness.runner.calls.at(-1)!;
    expect(followUp.prompt.request).toContain('interrupted');
    expect(followUp.prompt.request).toContain('src/index.html');

    const { originDir } = harness;
    expect(await readPushedFile(originDir, pullRequest.headRef, 'src/index.html')).toContain(
      'Built for speed',
    );
    expect(await readPushedFile(originDir, pullRequest.headRef, 'src/about.html')).toContain(
      'About',
    );
  });

  it('spends the kept work once: nothing is left to restore a third time', async () => {
    const script = interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n'));
    harness = await createHarness({ script, previewTimeoutMs: 50 });
    const pullRequest = await openConversation(harness.client);
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    rescript(script, finishesWith(writes('src/about.html', '<h1>About</h1>\n')));
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Carry on');

    expect(await keptWorkExists(harness.originDir, pullRequest.number)).toBe(false);
  });

  it('judges the kept work again, whole, and refuses it if the rest is refused', async () => {
    const script = interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n'));
    harness = await createHarness({ script });
    const pullRequest = await openConversation(harness.client);
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    rescript(script, finishesWith(writes('package.json', '{"name":"planted"}\n')));
    const outcome = await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Carry on');

    expect(outcome.started && outcome.outcome).toBe('blocked');
    expect(await branchExists(harness.originDir, pullRequest.headRef)).toBe(false);
    // Kept work that led to a refusal would lead to it again on every later
    // request, so it is spent here too.
    expect(await keptWorkExists(harness.originDir, pullRequest.number)).toBe(false);
  });

  it('keeps both attempts when it is interrupted as well', async () => {
    const script = interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n'));
    harness = await createHarness({ script });
    const pullRequest = await openConversation(harness.client);
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    rescript(script, interruptedAfter(writes('src/about.html', '<h1>About</h1>\n')));
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Carry on');

    const { originDir } = harness;
    expect(await keptFile(originDir, pullRequest.number, 'src/index.html')).toContain('speed');
    expect(await keptFile(originDir, pullRequest.number, 'src/about.html')).toContain('About');
  });

  it('drops kept work the site has since moved out from under', async () => {
    const script = interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n'));
    harness = await createHarness({ script, previewTimeoutMs: 50 });
    const pullRequest = await openConversation(harness.client);
    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');
    await commitToBranch(
      harness.originDir,
      pullRequest.headRef,
      'src/index.html',
      '<h1>Something else entirely</h1>\n',
    );

    rescript(script, finishesWith(writes('src/about.html', '<h1>About</h1>\n')));
    const outcome = await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Carry on');

    expect(outcome.started).toBe(true);
    expect(harness.runner.calls.at(-1)!.prompt.request).not.toContain('interrupted');
    expect(await keptWorkExists(harness.originDir, pullRequest.number)).toBe(false);
    expect(
      await readPushedFile(harness.originDir, pullRequest.headRef, 'src/index.html'),
    ).toContain('Something else entirely');
  });
});

describe('work that is not kept', () => {
  it('is not kept when it reaches past the policy', async () => {
    harness = await createHarness({
      script: interruptedAfter(writes('package.json', '{"name":"planted"}\n')),
    });
    const pullRequest = await openConversation(harness.client);

    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    expect(await keptWorkExists(harness.originDir, pullRequest.number)).toBe(false);
    const parsed = await lastComment(harness, pullRequest.number);
    expect(parsed.prose).toBe(CLIENT_MESSAGES.model_credit);
  });

  it('is not kept when the agent simply crashed', async () => {
    harness = await createHarness({
      script: { exitCode: 1, edit: writes('src/index.html', '<h1>Half an ed') },
    });
    const pullRequest = await openConversation(harness.client);

    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    expect(await keptWorkExists(harness.originDir, pullRequest.number)).toBe(false);
  });

  it('is not kept when the run cost more than the site allows', async () => {
    harness = await createHarness({
      script: {
        ...finishesWith(writes('src/index.html', '<h1>Built for speed</h1>\n')),
        result: { summary: 'Done.', filesChanged: [], tokensIn: 1, tokensOut: 1, costUsd: 9.5 },
      },
    });
    const pullRequest = await openConversation(harness.client);

    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    expect(await keptWorkExists(harness.originDir, pullRequest.number)).toBe(false);
  });

  it('still ends the request in its own words when keeping the work fails', async () => {
    harness = await createHarness({
      script: interruptedAfter(writes('src/index.html', '<h1>Built for speed</h1>\n')),
    });
    const pullRequest = await openConversation(harness.client);
    harness.deps.client.authenticatedRemoteUrl = async () => join(tmpdir(), 'no-such-remote.git');

    const outcome = await sendRequest(
      harness,
      pullRequest.number,
      pullRequest.headRef,
      'Shorten it',
    );

    expect(outcome.started && outcome.outcome).toBe('failed');
    const parsed = await lastComment(harness, pullRequest.number);
    expect(parsed.record?.errorCode).toBe('model_credit');
    expect(parsed.record?.wipSaved).toBeUndefined();
    expect(parsed.prose).toBe(CLIENT_MESSAGES.model_credit);
  });
});

describe('an agent that runs out of time mid-edit', () => {
  it('keeps the work too', async () => {
    harness = await createHarness({
      script: { outcome: 'timeout', edit: writes('src/index.html', '<h1>Built for speed</h1>\n') },
    });
    const pullRequest = await openConversation(harness.client);

    await sendRequest(harness, pullRequest.number, pullRequest.headRef, 'Shorten it');

    expect(await keptFile(harness.originDir, pullRequest.number, 'src/index.html')).toContain(
      'Built for speed',
    );
  });
});
