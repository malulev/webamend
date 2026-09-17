import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_REFUSALS,
  ERROR_HELP,
  BRINGING_UP_TO_DATE,
  CLIENT_MESSAGES,
  CLIENT_PROSE,
  clientMessage,
  errorBody,
  ERROR_STATUS,
  INTERRUPTED_MESSAGE,
  messageForViolation,
  PUBLISH_REFUSALS,
  UNDO_REFUSALS,
  PUBLICATION_IN_PROGRESS,
  WORK_KEPT_MESSAGE,
} from '@/lib/jobs/messages';
import { DEFAULT_ERROR_DETAIL } from '@/lib/jobs/run';
import type { ErrorCode, PolicyViolation } from '@/types';

/**
 * Principle I is a property of the message table, so it is asserted over the
 * whole table rather than message by message. A new code added without a
 * client-safe message fails here.
 */
describe('the client-facing vocabulary', () => {
  const messages = Object.entries(CLIENT_MESSAGES) as Array<[ErrorCode, string]>;

  it('covers every code with a message and a status', () => {
    for (const [code] of messages) {
      expect(clientMessage(code), code).toBeTruthy();
      expect(ERROR_STATUS[code], code).toBeGreaterThan(0);
    }
    expect(Object.keys(ERROR_STATUS).sort()).toEqual(Object.keys(CLIENT_MESSAGES).sort());
  });

  it('names no file path, extension, or directory', () => {
    for (const [code, message] of messages) {
      expect(message, code).not.toMatch(/\.(ts|tsx|js|jsx|json|yml|yaml|md|css)\b/);
      expect(message, code).not.toMatch(/(^|\s)[\w.-]*\//);
      expect(message, code).not.toMatch(/\.webagent|node_modules|src\b/);
    }
  });

  it('uses no git or build vocabulary', () => {
    const forbidden =
      /\b(commit|branch|merge|rebase|diff|repository|repo|pull request|PR|SHA|stack trace|exception|npm|webpack|stderr|exit code|slot|queue depth|container|docker)\b/i;
    for (const [code, message] of messages) {
      expect(message, code).not.toMatch(forbidden);
    }
  });

  it('reads as a sentence a non-technical person can act on', () => {
    for (const [code, message] of messages) {
      expect(message, code).toMatch(/[.!?]$/);
      expect(message.length, code).toBeLessThan(120);
      expect(message[0], code).toEqual(message[0]?.toUpperCase());
    }
  });

  it('returns a uniform body so no route invents its own error shape', () => {
    expect(errorBody('request_in_flight')).toEqual({
      error: 'request_in_flight',
      message: CLIENT_MESSAGES.request_in_flight,
    });
  });

  it('answers a second in-flight request with 409, which is what the disabled input cannot enforce', () => {
    expect(ERROR_STATUS.request_in_flight).toBe(409);
    expect(ERROR_STATUS.out_of_date).toBe(409);
  });
});

/**
 * T097: the same audit, widened from the error table to every sentence this
 * product can put in front of a client.
 *
 * `CLIENT_MESSAGES` is not the whole vocabulary — an abandoned request has no
 * error code and still gets a sentence — and an audit that only covered the
 * table would pass while the one string outside it leaked. So the properties
 * are asserted over `CLIENT_PROSE`, which is the list a new sentence has to
 * join to be shown at all.
 */
describe('every sentence a client can be shown', () => {
  const sentences = CLIENT_PROSE;

  it('covers every sentence a client can be shown, not only the coded ones', () => {
    // The audit below is only worth as much as this list's completeness, so the
    // list is asserted against its sources rather than against a number that
    // would need editing every time the vocabulary grows.
    expect(sentences).toContain(INTERRUPTED_MESSAGE);
    expect(sentences).toContain(WORK_KEPT_MESSAGE);
    expect(sentences).toContain(PUBLICATION_IN_PROGRESS);
    expect(sentences).toContain(BRINGING_UP_TO_DATE);
    for (const message of Object.values(CLIENT_MESSAGES)) expect(sentences).toContain(message);
    for (const message of Object.values(PUBLISH_REFUSALS)) expect(sentences).toContain(message);
    for (const message of Object.values(UNDO_REFUSALS)) expect(sentences).toContain(message);
    for (const message of Object.values(ATTACHMENT_REFUSALS)) expect(sentences).toContain(message);

    expect(sentences.length).toBe(
      Object.keys(CLIENT_MESSAGES).length +
        4 +
        Object.keys(PUBLISH_REFUSALS).length +
        Object.keys(UNDO_REFUSALS).length +
        Object.keys(ATTACHMENT_REFUSALS).length,
    );
  });

  it('contains no path, however the path is spelled', () => {
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(/[/\\]/);
      expect(sentence, sentence).not.toMatch(
        /\b[\w-]+\.(?:ts|tsx|js|json|ya?ml|md|css|html|lock)\b/i,
      );
      expect(sentence, sentence).not.toMatch(/\.webagent|node_modules|package\.json/i);
    }
  });

  it('contains no diff', () => {
    for (const sentence of sentences) {
      // A diff announces itself two ways: its line prefixes and its hunk header.
      expect(sentence, sentence).not.toMatch(/^\s*[+-]{1,3}\s/m);
      expect(sentence, sentence).not.toMatch(/@@/);
      expect(sentence, sentence).not.toMatch(/```|~~~/);
    }
  });

  it('contains no build log', () => {
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(
        /\b(?:ERR!|ENOENT|Traceback|at Object\.|stack trace|stderr|stdout|exit code)\b/i,
      );
      expect(sentence, sentence).not.toMatch(/\b(?:npm|yarn|pnpm|webpack|vite|eslint|tsc)\b/i);
      expect(sentence, sentence).not.toMatch(/^\s*\d+\s*\|/m);
    }
  });

  it('names nothing a version control system would recognise', () => {
    const forbidden =
      /\b(commit|branch|merge|rebase|diff|repository|repo|pull request|PR|SHA|HEAD|origin|ref|checkout)\b/i;
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(forbidden);
      // A bare commit reference, abbreviated or not.
      expect(sentence, sentence).not.toMatch(/\b[0-9a-f]{7,40}\b/i);
      expect(sentence, sentence).not.toMatch(/\bhttps?:/i);
    }
  });

  it('reads as one plain sentence a non-technical person can act on', () => {
    for (const sentence of sentences) {
      expect(sentence, sentence).toMatch(/[.!?]$/);
      expect(sentence[0], sentence).toEqual(sentence[0]?.toUpperCase());
      expect(sentence.length, sentence).toBeLessThan(160);
    }
  });
});

/**
 * The help text is a second register, not a second vocabulary: it answers
 * "why, and what now" where the short message answers "what happened". Every
 * Principle I rule still applies — it just gets two sentences to do it in.
 */
describe('the help behind the question mark', () => {
  const help = Object.entries(ERROR_HELP) as Array<[ErrorCode, string]>;

  it('covers every code the short vocabulary covers, and no more', () => {
    expect(Object.keys(ERROR_HELP).sort()).toEqual(Object.keys(CLIENT_MESSAGES).sort());
  });

  it('never repeats the short message it sits behind', () => {
    for (const [code, sentence] of help) {
      expect(sentence, code).not.toBe(CLIENT_MESSAGES[code]);
    }
  });

  it('names no file path, extension, or directory', () => {
    for (const [code, sentence] of help) {
      expect(sentence, code).not.toMatch(/\.(ts|tsx|js|jsx|json|yml|yaml|md|css|html)\b/);
      expect(sentence, code).not.toMatch(/(^|\s)[\w.-]*\//);
      expect(sentence, code).not.toMatch(/\.webagent|node_modules|src\b/);
    }
  });

  it('uses no git, build or infrastructure vocabulary', () => {
    const forbidden =
      /\b(commit|branch|merge|rebase|diff|repository|repo|pull request|PR|SHA|stack trace|exception|npm|webpack|stderr|exit code|slot|queue depth|container|docker|API|token|model)\b/i;
    for (const [code, sentence] of help) {
      expect(sentence, code).not.toMatch(forbidden);
    }
  });

  it('gives a person something to do, in at most two sentences', () => {
    for (const [code, sentence] of help) {
      expect(sentence, code).toMatch(/[.!?]$/);
      expect(sentence[0], code).toEqual(sentence[0]?.toUpperCase());
      // Long enough to explain, short enough to read inside a tooltip.
      expect(sentence.length, code).toBeGreaterThan(CLIENT_MESSAGES[code].length);
      expect(sentence.length, code).toBeLessThan(220);
      expect(sentence.split(/(?<=[.!?])\s+/).length, code).toBeLessThanOrEqual(2);
    }
  });
});

/**
 * The gate reports six different violations and the client is told one thing.
 * Which rule fired is the developer's business and lives in the record; a
 * client learning that their request tripped `too_many_lines` has learned
 * about the implementation, not about their site.
 */
describe('a policy violation, whichever rule caught it', () => {
  const violations: PolicyViolation[] = [
    'protected_path',
    'denied_path',
    'not_allowed_path',
    'too_many_files',
    'too_many_lines',
    'new_dependency',
  ];

  it('reads as the one blocked message', () => {
    for (const violation of violations) {
      expect(messageForViolation(violation), violation).toBe(CLIENT_MESSAGES.blocked_by_policy);
    }
  });

  it('never names the rule that fired', () => {
    for (const violation of violations) {
      expect(messageForViolation(violation).toLowerCase(), violation).not.toContain(
        violation.replace(/_/g, ' '),
      );
    }
  });
});

/**
 * T089: the taxonomy is only closed if every code carries all three of the
 * things a finished request needs — the sentence a client reads, the status a
 * route answers with, and the diagnostic line the durable record requires on a
 * failure. A code missing the third writes a record this product cannot parse
 * back, which is how a block a client should never see reaches them.
 */
describe('the failure taxonomy', () => {
  it('gives every code a client sentence, a status, and a diagnostic detail', () => {
    const codes = Object.keys(CLIENT_MESSAGES) as ErrorCode[];
    for (const code of codes) {
      expect(clientMessage(code), code).toBeTruthy();
      expect(ERROR_STATUS[code], code).toBeGreaterThan(0);
      expect(DEFAULT_ERROR_DETAIL[code], code).toBeTruthy();
    }
    expect(Object.keys(DEFAULT_ERROR_DETAIL).sort()).toEqual(codes.sort());
  });

  it('keeps the diagnostic detail distinct from the sentence, so neither drifts into the other', () => {
    for (const [code, message] of Object.entries(CLIENT_MESSAGES) as Array<[ErrorCode, string]>) {
      expect(DEFAULT_ERROR_DETAIL[code], code).not.toBe(message);
    }
  });
});
