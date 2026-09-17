import { describe, expect, it } from 'vitest';
import type {
  ErrorCode,
  NotificationEvent,
  Outcome,
  PolicyViolation,
  RequestRecord,
  Stage,
} from '@/types';
import { parseComment, renderRecord } from '@/lib/record';

/**
 * T029: render and parse must be inverses over the whole shape of
 * RequestRecord, not just the one example in the contract. We do not pull in
 * a property-testing dependency for this — a small seeded LCG gives the same
 * "many varied inputs" coverage while keeping any failure reproducible by
 * its seed and index, which matters more here than sheer breadth.
 */

// -- seeded PRNG -------------------------------------------------------------

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG. Deterministic, fast, good enough to shake out
    // shape bugs — this is not cryptography.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rng: () => number, options: readonly T[]): T {
  const index = Math.floor(rng() * options.length);
  return options[Math.min(index, options.length - 1)] as T;
}

function chance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

function intBetween(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function floatBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function isoTimestamp(rng: () => number): string {
  const start = Date.UTC(2026, 0, 1);
  const spanMs = 1000 * 60 * 60 * 24 * 365;
  return new Date(start + Math.floor(rng() * spanMs)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const UNICODE_SAMPLES = ['שלום', '日本語', 'éèê', '🚀✨', '"quoted"', "it's", '\t', '', 'a\nb\nc'];

/** Prose deliberately varied: multi-line, unicode, occasional stray "-->". */
function genProse(rng: () => number): string {
  const wordCount = intBetween(rng, 1, 12);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i += 1) {
    if (chance(rng, 0.3)) {
      words.push(pick(rng, UNICODE_SAMPLES));
    } else {
      words.push(
        pick(rng, [
          'Changed',
          'the',
          'homepage',
          'hero',
          'button',
          'color',
          'and',
          'spacing.',
          'Done!',
        ]),
      );
    }
  }
  let prose = words.join(' ');
  if (chance(rng, 0.15)) {
    prose += ' Note: an HTML comment ends with --> like so.';
  }
  if (chance(rng, 0.1)) {
    prose = `Line one.\n\nLine two with a blank line above.${prose}`;
  }
  return prose;
}

const STAGES: Stage[] = [
  'starting',
  'queued',
  'running',
  'gating',
  'pushing',
  'building',
  'succeeded',
  'blocked',
  'failed',
  'abandoned',
];
const OUTCOMES: Outcome[] = ['succeeded', 'blocked', 'failed', 'abandoned'];
const VIOLATIONS: PolicyViolation[] = [
  'protected_path',
  'denied_path',
  'not_allowed_path',
  'too_many_files',
  'too_many_lines',
  'new_dependency',
];
const ERROR_CODES: ErrorCode[] = [
  'blocked_by_policy',
  'request_in_flight',
  'agent_timeout',
  'build_failed',
  'site_unreachable',
  'cost_ceiling',
  'out_of_date',
  'nothing_to_change',
  'internal_error',
];
const NOTIFICATION_EVENTS: NotificationEvent[] = [
  'preview_ready',
  'request_blocked',
  'request_failed',
  'published',
  'undone',
];

function genStages(rng: () => number): RequestRecord['stages'] {
  const length = intBetween(rng, 0, 6);
  const stages = [];
  for (let i = 0; i < length; i += 1) {
    stages.push({ stage: pick(rng, STAGES), at: isoTimestamp(rng) });
  }
  return stages;
}

function genNotified(rng: () => number): NotificationEvent[] | undefined {
  if (chance(rng, 0.4)) return undefined;
  const length = intBetween(rng, 0, NOTIFICATION_EVENTS.length);
  const events = new Set<NotificationEvent>();
  for (let i = 0; i < length; i += 1) events.add(pick(rng, NOTIFICATION_EVENTS));
  return [...events];
}

function genRequestRecord(rng: () => number): RequestRecord {
  const outcome = pick(rng, OUTCOMES);

  const record: RequestRecord = {
    requestId: `r_${intBetween(rng, 0, 1e9).toString(36)}`,
    startedAt: isoTimestamp(rng),
    finishedAt: isoTimestamp(rng),
    outcome,
    stages: genStages(rng),
  };

  if (chance(rng, 0.7)) record.commitSha = intBetween(rng, 0, 0xfffffff).toString(16);
  if (chance(rng, 0.7)) record.filesChanged = intBetween(rng, 0, 20);
  if (chance(rng, 0.7)) record.diffLines = intBetween(rng, 0, 2000);
  if (chance(rng, 0.7))
    record.model = pick(rng, [
      'anthropic/claude-sonnet-latest',
      'openai/gpt-5',
      'anthropic/claude-haiku',
    ]);
  if (chance(rng, 0.7)) record.tokensIn = intBetween(rng, 0, 200000);
  if (chance(rng, 0.7)) record.tokensOut = intBetween(rng, 0, 20000);
  // Floats are the interesting case: JSON round-trips IEEE-754 doubles
  // exactly via their shortest decimal representation, so no epsilon
  // comparison should be needed here — equality must be exact.
  if (chance(rng, 0.7)) record.costUsd = floatBetween(rng, 0, 5);
  if (chance(rng, 0.5))
    record.previewUrl = `https://deploy-preview-${intBetween(rng, 1, 999)}--client.netlify.app`;

  const notified = genNotified(rng);
  if (notified !== undefined) record.notified = notified;

  // violation/blockedPath and errorCode/errorDetail are only ever present
  // for their matching outcome (contracts/durable-record.md); the schema
  // enforces this, so the generator must not produce records the schema
  // would reject.
  if (outcome === 'blocked') {
    record.violation = pick(rng, VIOLATIONS);
    record.blockedPath = pick(rng, [
      '.env.production',
      'netlify.toml',
      'src/app/page.tsx',
      UNICODE_SAMPLES[0] as string,
    ]);
  }
  if (outcome === 'failed') {
    record.errorCode = pick(rng, ERROR_CODES);
    record.errorDetail = pick(rng, ['build exited 1', 'timed out after 30 minutes', genProse(rng)]);    if (pick(rng, [true, false])) record.wipSaved = true;
  }

  return record;
}

const SEED = 20260902;
const SAMPLE_COUNT = 200;

describe('renderRecord and parseComment are inverses (property test, T029)', () => {
  const rng = createRng(SEED);

  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const prose = genProse(rng);
    const record = genRequestRecord(rng);

    it(`round-trips generated sample #${i} (seed ${SEED})`, () => {
      const rendered = renderRecord(prose, record);
      const parsed = parseComment({
        id: i,
        author: 'webagent-bot',
        body: rendered,
        createdAt: record.finishedAt,
      });

      expect(parsed.prose).toBe(prose);
      expect(parsed.record).toEqual(record);
    });
  }

  it('round-trips a request that never got a turn', () => {
    const record: RequestRecord = {
      requestId: 'r_busy',
      startedAt: '2026-09-04T10:00:00.000Z',
      finishedAt: '2026-09-04T10:15:00.000Z',
      outcome: 'failed',
      stages: [
        { stage: 'queued', at: '2026-09-04T10:00:01.000Z' },
        { stage: 'failed', at: '2026-09-04T10:15:00.000Z' },
      ],
      errorCode: 'too_busy',
      errorDetail: 'no agent slot became free within 15 minutes',
    };
    const rendered = renderRecord('prose', record);
    const parsed = parseComment({
      id: 0,
      author: 'webagent-bot',
      body: rendered,
      createdAt: record.finishedAt,
    });
    expect(parsed.record).toEqual(record);
  });
});
