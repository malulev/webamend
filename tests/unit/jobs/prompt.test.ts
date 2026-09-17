import { describe, expect, it } from 'vitest';
import { assemblePrompt } from '@/lib/jobs/prompt';
import type { Message } from '@/types';

function message(author: Message['author'], text: string, id = 1): Message {
  return { id, author, at: '2026-09-02T10:00:00Z', text };
}

describe('assembling the prompt for one job', () => {
  it('carries the request, the history, and the repository guidance', () => {
    const prompt = assemblePrompt({
      request: '  Make the headline shorter.  ',
      history: [message('client', 'Change the hero', 1), message('agent', 'Done', 2)],
      guidance: '  Use sentence case in headings.  ',
    });

    expect(prompt.request).toBe('Make the headline shorter.');
    expect(prompt.guidance).toBe('Use sentence case in headings.');
    expect(prompt.history).toEqual([
      { author: 'client', text: 'Change the hero' },
      { author: 'agent', text: 'Done' },
    ]);
  });

  it('carries no history field beyond author and text, so nothing internal leaks into the container', () => {
    const prompt = assemblePrompt({
      request: 'x',
      history: [{ ...message('agent', 'built'), previewUrl: 'https://preview.example', outcome: 'succeeded' }],
      guidance: '',
    });

    expect(Object.keys(prompt.history[0]!).sort()).toEqual(['author', 'text']);
  });

  it('keeps only the most recent turns, since a prompt that grows without bound outgrows the change', () => {
    const history = Array.from({ length: 50 }, (_, i) => message('client', `turn ${i}`, i));
    const prompt = assemblePrompt({ request: 'x', history, guidance: '' });

    expect(prompt.history).toHaveLength(20);
    expect(prompt.history.at(-1)?.text).toBe('turn 49');
    expect(prompt.history[0]?.text).toBe('turn 30');
  });

  it('omits the page hint entirely when there is none', () => {
    const prompt = assemblePrompt({ request: 'x', history: [], guidance: '' });
    expect('targetHint' in prompt).toBe(false);
  });

  it('passes the page hint through when the client named a page', () => {
    const prompt = assemblePrompt({ request: 'x', history: [], guidance: '', targetHint: '/pricing' });
    expect(prompt.targetHint).toBe('/pricing');
  });

  it('gives the agent the previous build failure so it can fix what it broke (FR-023)', () => {
    const prompt = assemblePrompt({
      request: 'Fix it',
      history: [],
      guidance: '',
      buildFailureDetail: "Module not found: Can't resolve './Hero'",
    });

    expect(prompt.request).toContain('Fix it');
    expect(prompt.request).toContain("Can't resolve './Hero'");
  });

  it('keeps the tail of a long build log, because a build reports its error last', () => {
    const detail = `${'banner\n'.repeat(2000)}THE ACTUAL ERROR`;
    const prompt = assemblePrompt({ request: 'Fix it', history: [], guidance: '', buildFailureDetail: detail });

    expect(prompt.request).toContain('THE ACTUAL ERROR');
    expect(prompt.request.length).toBeLessThan(2_500);
  });

  it('mentions no build failure when the previous request did not fail', () => {
    const prompt = assemblePrompt({ request: 'Make it blue', history: [], guidance: '' });
    expect(prompt.request).toBe('Make it blue');
  });

  it('does not mutate the history it was given', () => {
    const history = [message('client', 'one')];
    const snapshot = structuredClone(history);
    assemblePrompt({ request: 'x', history, guidance: '' });
    expect(history).toEqual(snapshot);
  });
});

/**
 * A conversation that was blocked once used to stay blocked forever: the
 * refused turn sat in history looking outstanding, so the next container
 * re-attempted it and was refused again. These fix the two facts that ends it.
 */
describe('an attempt the policy refused', () => {
  function agentTurn(overrides: Partial<Message>): Message {
    return { ...message('agent', 'Your developer has protected this part of the site.', 7), ...overrides };
  }

  it('renders a blocked turn so the agent can tell it was never applied', () => {
    const prompt = assemblePrompt({
      request: 'x',
      history: [agentTurn({ outcome: 'blocked', errorCode: 'blocked_by_policy' })],
      guidance: '',
    });

    const turn = prompt.history[0]!;
    expect(turn.text).toContain('Your developer has protected this part of the site.');
    expect(turn.text).not.toBe('Your developer has protected this part of the site.');
    expect(turn.text.toLowerCase()).toContain('refused');
    expect(Object.keys(turn).sort()).toEqual(['author', 'text']);
  });

  it('renders a failed turn as not applied either', () => {
    const prompt = assemblePrompt({
      request: 'x',
      history: [agentTurn({ text: 'The change broke the site build.', outcome: 'failed', errorCode: 'build_failed' })],
      guidance: '',
    });

    expect(prompt.history[0]!.text).toContain('The change broke the site build.');
    expect(prompt.history[0]!.text.toLowerCase()).toContain('not applied');
  });

  it('leaves a successful turn and a client turn exactly as they were written', () => {
    const prompt = assemblePrompt({
      request: 'x',
      history: [
        message('client', 'Add a README', 1),
        agentTurn({ text: 'Your preview is ready.', outcome: 'succeeded' }),
      ],
      guidance: '',
    });

    expect(prompt.history).toEqual([
      { author: 'client', text: 'Add a README' },
      { author: 'agent', text: 'Your preview is ready.' },
    ]);
  });

  it('names the refused paths in the request, so the agent stops re-attempting them', () => {
    const prompt = assemblePrompt({
      request: 'Change the headline to Built for speed.',
      history: [],
      guidance: '',
      refusedPaths: ['README.md'],
    });

    expect(prompt.request).toContain('Change the headline to Built for speed.');
    expect(prompt.request).toContain('README.md');
  });

  it('names each refused path once, however many attempts were refused', () => {
    const prompt = assemblePrompt({
      request: 'x',
      history: [],
      guidance: '',
      refusedPaths: ['README.md', 'README.md', 'config/payments.json', 'README.md'],
    });

    expect(prompt.request.match(/README\.md/g)).toHaveLength(1);
    expect(prompt.request).toContain('config/payments.json');
  });

  it('says nothing about refused paths when nothing has been refused', () => {
    expect(assemblePrompt({ request: 'Make it blue', history: [], guidance: '' }).request).toBe('Make it blue');
    expect(
      assemblePrompt({ request: 'Make it blue', history: [], guidance: '', refusedPaths: [] }).request,
    ).toBe('Make it blue');
  });

  it('tells the agent about both a refused path and a broken build at once', () => {
    const prompt = assemblePrompt({
      request: 'Fix it',
      history: [],
      guidance: '',
      buildFailureDetail: "Module not found: Can't resolve './Hero'",
      refusedPaths: ['README.md'],
    });

    expect(prompt.request).toContain('README.md');
    expect(prompt.request).toContain("Can't resolve './Hero'");
  });

  it('still drops the oldest turns, and marks the refused ones that survive', () => {
    const history: Message[] = Array.from({ length: 50 }, (_, i) => message('client', `turn ${i}`, i));
    history[49] = agentTurn({ id: 49, outcome: 'blocked', errorCode: 'blocked_by_policy' });

    const prompt = assemblePrompt({ request: 'x', history, guidance: '' });

    expect(prompt.history).toHaveLength(20);
    expect(prompt.history[0]?.text).toBe('turn 30');
    expect(prompt.history.at(-1)!.text.toLowerCase()).toContain('refused');
  });
});

/**
 * Attached files are placed in the tree before the agent runs, and the agent
 * is told where. The paths ride inside the request text, like the refused
 * paths and the build failure, so the container contract stays unchanged.
 */
describe('attached files', () => {
  it('names each attached path in the request, so the agent can use the files', () => {
    const prompt = assemblePrompt({
      request: 'Put the new team photo on the about page.',
      history: [],
      guidance: '',
      attachedPaths: ['public/uploads/team-photo.jpg'],
    });

    expect(prompt.request).toContain('Put the new team photo on the about page.');
    expect(prompt.request).toContain('- public/uploads/team-photo.jpg');
    expect(prompt.request).toMatch(/attached/i);
  });

  it('adds nothing when there are no attachments', () => {
    const prompt = assemblePrompt({ request: 'x', history: [], guidance: '', attachedPaths: [] });
    expect(prompt.request).toBe('x');
  });

  it('keeps the attachments out of the published prompt fields', () => {
    const prompt = assemblePrompt({
      request: 'x',
      history: [],
      guidance: '',
      attachedPaths: ['public/uploads/a.png'],
    });
    expect(Object.keys(prompt).sort()).toEqual(['guidance', 'history', 'request']);
  });
});

/**
 * Work kept from an interrupted request is already in the tree when the next
 * agent starts. Unannounced it reads as the site's own state, and an agent
 * that cannot tell its predecessor's half-finished edit from the client's
 * site will build on a mistake or leave one in.
 */
describe('work kept from an interrupted request', () => {
  it('names the paths already edited and says they are unfinished', () => {
    const prompt = assemblePrompt({
      request: 'Carry on',
      history: [],
      guidance: '',
      resumedPaths: ['src/index.html'],
    });

    expect(prompt.request).toContain('Carry on');
    expect(prompt.request).toContain('- src/index.html');
    expect(prompt.request).toMatch(/interrupted/i);
  });

  it('adds nothing when no work was kept', () => {
    const prompt = assemblePrompt({ request: 'x', history: [], guidance: '', resumedPaths: [] });
    expect(prompt.request).toBe('x');
  });
});
