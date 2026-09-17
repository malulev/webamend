import { z } from 'zod';
import { CLIENT_MESSAGES } from '@/lib/jobs/messages';
import type {
  ErrorCode,
  NotificationEvent,
  Outcome,
  PolicyViolation,
  RecordedComment,
  RequestRecord,
  Stage,
} from '@/types';

/**
 * Renders and parses the durable request record described in
 * contracts/durable-record.md: one pull request comment per finished
 * request, client-facing prose for people plus a `webagent:v1` block for the
 * dashboard. This is the entire history mechanism — the product keeps none
 * of its own state, so this module is the only place the shape is produced
 * or consumed.
 */

const MARKER_OPEN = '<!-- webagent:v1';
const MARKER_CLOSE = '-->';
const SEPARATOR = '\n\n';

// ---------------------------------------------------------------------------
// Schema
//
// Mirrors RequestRecord field-for-field. A block that does not match this
// shape — wrong types, an outcome missing the detail it must carry, an
// unknown enum value smuggled in by a hand-edited comment — is no more
// trustworthy than a missing block, so validation failure and absence are
// handled identically by the caller: both degrade to prose (contract:
// "parsing is total").
// ---------------------------------------------------------------------------

const STAGE_VALUES: Stage[] = [
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

const OUTCOME_VALUES: Outcome[] = ['succeeded', 'blocked', 'failed', 'abandoned'];

const VIOLATION_VALUES: PolicyViolation[] = [
  'protected_path',
  'denied_path',
  'not_allowed_path',
  'too_many_files',
  'too_many_lines',
  'new_dependency',
  'symlink',
  'external_code',
];

// Derived, not listed: a list here fell four codes behind the vocabulary
// unnoticed, and every failed record written with one of those read back as
// prose with no record at all. The message table is the one place a code
// must be added to reach a client, so it is the one place this reads from.
const ERROR_CODE_VALUES = Object.keys(CLIENT_MESSAGES) as [ErrorCode, ...ErrorCode[]];

const NOTIFICATION_EVENT_VALUES: NotificationEvent[] = [
  'preview_ready',
  'request_blocked',
  'request_failed',
  'published',
  'undone',
];

const stageEventSchema = z.object({
  stage: z.enum(STAGE_VALUES),
  at: z.string(),
});

const requestRecordSchema = z
  .object({
    requestId: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    outcome: z.enum(OUTCOME_VALUES),
    stages: z.array(stageEventSchema),
    commitSha: z.string().optional(),
    filesChanged: z.number().optional(),
    diffLines: z.number().optional(),
    model: z.string().optional(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    costUsd: z.number().optional(),
    previewUrl: z.string().optional(),
    notified: z.array(z.enum(NOTIFICATION_EVENT_VALUES)).optional(),
    violation: z.enum(VIOLATION_VALUES).optional(),
    blockedPath: z.string().optional(),
    errorCode: z.enum(ERROR_CODE_VALUES).optional(),
    errorDetail: z.string().optional(),
    wipSaved: z.boolean().optional(),
  })
  // contracts/durable-record.md: "blocked carries violation and
  // blockedPath; failed carries errorCode and a short errorDetail". A record
  // claiming one of these outcomes without its required detail is malformed,
  // not merely incomplete.
  .refine((record) => record.outcome !== 'blocked' || record.violation !== undefined, {
    message: 'a blocked outcome must carry violation',
  })
  .refine((record) => record.outcome !== 'blocked' || record.blockedPath !== undefined, {
    message: 'a blocked outcome must carry blockedPath',
  })
  .refine((record) => record.outcome !== 'failed' || record.errorCode !== undefined, {
    message: 'a failed outcome must carry errorCode',
  })
  .refine((record) => record.outcome !== 'failed' || record.errorDetail !== undefined, {
    message: 'a failed outcome must carry errorDetail',
  });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Renders one pull request comment: prose first, so a reader who never sees
 * the block loses nothing (Principle I), then a blank line, then the
 * machine-readable block. Callers must not smuggle paths, diffs, or build
 * logs into `prose` — this function does not sanitise it, it trusts the
 * caller already produced client-facing text.
 */
export function renderRecord(prose: string, record: RequestRecord): string {
  const block = `${MARKER_OPEN}\n${JSON.stringify(record, null, 2)}\n${MARKER_CLOSE}`;
  return `${prose}${SEPARATOR}${block}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Splits a comment body into its prose and its record, or decides there is
 * no usable record at all.
 *
 * The contract asks for exactly one block per comment, opened by
 * `<!-- webagent:v1` and closed by `-->`. Real comments are not always that
 * clean — a client could paste an old comment's text back in, embedding a
 * stray marker — so this takes the *last* occurrence of each token in the
 * body as the real block. That reading matches how renderRecord actually
 * writes a comment: the block is always the last thing in the string, so
 * its closing `-->` is always the last `-->` anywhere in the body, and its
 * opening marker is always the last `<!-- webagent:v1` anywhere in the body
 * — regardless of what the prose that precedes it happens to contain.
 */
function splitBody(body: string): { prose: string; record?: RequestRecord } {
  const openIndex = body.lastIndexOf(MARKER_OPEN);
  const closeIndex = body.lastIndexOf(MARKER_CLOSE);
  if (openIndex === -1 || closeIndex === -1 || closeIndex < openIndex) {
    return { prose: body };
  }

  const headerNewline = body.indexOf('\n', openIndex);
  if (headerNewline === -1 || headerNewline >= closeIndex) {
    return { prose: body };
  }

  const jsonText = body.slice(headerNewline + 1, closeIndex).trim();
  const record = parseRecordJson(jsonText);
  if (!record) {
    return { prose: body };
  }

  const beforeMarker = body.slice(0, openIndex);
  const prose = beforeMarker.endsWith(SEPARATOR)
    ? beforeMarker.slice(0, -SEPARATOR.length)
    : beforeMarker;
  return { prose, record };
}

/** Never throws: bad JSON and JSON that fails the schema both mean "no record". */
function parseRecordJson(jsonText: string): RequestRecord | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  const result = requestRecordSchema.safeParse(candidate);
  return result.success ? (result.data as RequestRecord) : undefined;
}

/**
 * Parses one pull request comment into prose plus an optional record.
 * Total: a missing marker, an unknown marker version, malformed JSON, or
 * JSON failing validation all degrade to `{ ...prose, record: undefined }`
 * rather than throwing (contract: "parsing is total").
 */
export function parseComment(input: {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}): RecordedComment {
  const { prose, record } = splitBody(input.body);
  return {
    commentId: input.id,
    author: input.author,
    createdAt: input.createdAt,
    prose,
    record,
  };
}

// ---------------------------------------------------------------------------
// Notification idempotency (OD-004)
// ---------------------------------------------------------------------------

/** Whether `event` has already been emailed for this request. */
export function hasNotified(record: RequestRecord, event: NotificationEvent): boolean {
  return record.notified?.includes(event) ?? false;
}

/**
 * Returns a new record with `event` marked as notified. Pure — callers
 * write the result back to the comment themselves. Idempotent: notifying an
 * already-notified event returns an equivalent record rather than growing
 * the list, so a retried send never double-appends.
 */
export function withNotified(record: RequestRecord, event: NotificationEvent): RequestRecord {
  if (hasNotified(record, event)) {
    return record;
  }
  return { ...record, notified: [...(record.notified ?? []), event] };
}
