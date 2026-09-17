import type { ErrorCode, PolicyViolation } from '@/types';

/**
 * Every word a client reads when something goes wrong.
 *
 * Constitution Principle I: the client never sees code. No file path, no diff,
 * no build log, no branch name and no git vocabulary may appear here. That is
 * not a style preference — it is the property `tests/unit/messages.test.ts`
 * asserts over this table, so a leak fails the build rather than reaching a
 * client.
 *
 * The vocabulary is closed. A failure that does not map to one of these codes
 * is `internal_error`, because inventing a message at the call site is how
 * stack traces reach client surfaces.
 */
export const CLIENT_MESSAGES: Record<ErrorCode, string> = {
  blocked_by_policy: 'Your developer has protected this part of the site.',
  request_in_flight: 'A change is already being applied — one moment.',
  too_busy:
    'Things are busy right now, so your change did not run. Please try again in a few minutes. Nothing was published.',
  agent_timeout: 'That took too long. Try a smaller or more specific change.',
  build_failed: 'The change broke the site build. I can try to fix it.',
  site_unreachable: "Can't reach your website's hosting right now.",
  cost_ceiling: 'That request was larger than this site’s limit allows.',
  out_of_date: 'Your website changed while this was being saved. Try again in a moment.',
  nothing_to_change: 'Nothing needed changing for that.',
  nothing_to_publish: 'There is nothing ready to publish here.',
  nothing_to_undo: 'There is nothing here to undo.',
  site_moved_on:
    'Your website has changed since this went live, so undoing it now would take those newer changes with it.',
  site_conflict:
    'Your website changed in the same place as this one. Start a new conversation and ask for it again.',
  model_quota:
    "The AI service has used up today's allowance for this site. Try again tomorrow. Nothing was published.",
  model_credit:
    'The AI service for this site has run out of credit. Your developer needs to top it up. Nothing was published.',
  model_unavailable:
    "The AI service isn't answering right now. Try again in a little while. Nothing was published.",
  hosting_limit:
    "Your website's hosting has reached its plan limit, so nothing can be built right now. Ask your developer.",
  internal_error: 'Something went wrong on my side. Nothing was published.',
};

/**
 * Why an attached file was not taken. These answer a `400` before any request
 * starts, and are shown in the composer as well so a client learns the limit
 * before pressing Send rather than after.
 */
export const ATTACHMENT_REFUSALS = {
  too_large: 'That file is too large. Each file must be 10 MB or smaller.',
  too_many: 'You can attach up to 5 files at a time.',
  total_too_large: 'Those files add up to more than 25 MB. Try fewer or smaller files.',
  unsupported: 'That kind of file cannot be attached. Images and PDF files work.',
  empty: 'That file is empty.',
  unsafe_svg: 'That image contains scripting, so it cannot be attached. A plain image works.',
} as const;

export type AttachmentRefusal = keyof typeof ATTACHMENT_REFUSALS;

/**
 * What the composer says while a publish is bringing a change up to date with
 * a website that moved on since the preview was made. Nothing here names how.
 */
export const BRINGING_UP_TO_DATE =
  'Your website changed since this preview was made. Bringing your change up to date first.';

/**
 * The one ending with no error code of its own.
 *
 * An abandoned request failed at nothing — its process stopped existing, so
 * there is no stage that went wrong and no code to name. It still owes the
 * client a sentence, and that sentence belongs in this table with the others
 * so the Principle I audit covers it too.
 */
export const INTERRUPTED_MESSAGE =
  'That request was interrupted before it finished. Nothing was published.';

/**
 * Added to a failure's own sentence when the run was interrupted through no
 * fault of the request and its edits were kept for the next one. It follows
 * the code's sentence rather than replacing it: what went wrong is still the
 * first thing a client needs, and this is the part that changes what they do.
 */
export const WORK_KEPT_MESSAGE =
  'The work done so far was kept, so sending your request again will carry on from there.';

/**
 * Why publishing or undoing was refused, in more detail than the code alone.
 *
 * These live here rather than beside the routes that answer them for one
 * reason: `tests/unit/messages.test.ts` audits this module against Principle I,
 * and a client-facing sentence written anywhere else is a sentence nothing
 * checks. They refine `nothing_to_publish` and `nothing_to_undo` — the code is
 * what the interface branches on, the sentence is what the client reads.
 */
export const PUBLISH_REFUSALS = {
  not_previewed:
    'There is nothing ready to publish here yet. Wait for the preview, then approve it.',
  published: 'This change is already published.',
  undone: 'This change was published and then undone. Start a new one to change your site again.',
  unavailable: 'This conversation is finished, so there is nothing to publish.',
} as const;

export type PublishRefusal = keyof typeof PUBLISH_REFUSALS;

export const UNDO_REFUSALS = {
  not_previewed: 'Nothing from this conversation has been published, so there is nothing to undo.',
  ready: 'This change has not been published yet, so there is nothing to undo.',
  undone: 'This change has already been undone.',
  unavailable: 'Nothing from this conversation is live, so there is nothing to undo.',
} as const;

export type UndoRefusal = keyof typeof UNDO_REFUSALS;

/**
 * Why the buttons are resting while a publish or an undo is being built.
 * `request_in_flight` says a *change* is being applied, which would be the
 * wrong sentence here: nothing is being changed, the site is being built.
 */
export const PUBLICATION_IN_PROGRESS = 'Your website is being built — one moment.';

/**
 * The longer answer, behind the question mark beside a setback.
 *
 * `CLIENT_MESSAGES` has one job: say what happened, in a breath, in under 120
 * characters. That leaves no room for the question a person actually has next
 * — *why did that happen, and what do I do now* — and the old answer was that
 * they asked their developer.
 *
 * So these are a second register, not a longer version of the first. Each one
 * says what the limit is *for*, and what the client can do about it, ending
 * either with an action they can take or with the honest statement that this
 * one is their developer's to fix.
 *
 * Principle I still governs every word: no path, no git vocabulary, no build
 * log, no figure from the implementation. `tests/unit/messages.test.ts` audits
 * this table with the same patterns it applies to the short ones, at a length
 * that allows two sentences instead of one.
 */
export const ERROR_HELP: Record<ErrorCode, string> = {
  blocked_by_policy:
    'Your developer chose which parts of this site can be changed from here, and this change reached past them. Ask them to open up the part you need.',
  request_in_flight:
    'One change at a time runs on a site, so two of them can never overwrite each other. Yours will start as soon as the one ahead of it finishes.',
  too_busy:
    'More changes were asked for at once than this site is set up to handle. Nothing was lost — send the same thing again in a few minutes.',
  agent_timeout:
    'Every change has a time limit, so one that gets stuck cannot run forever. Asking for one thing at a time is usually enough to get through it.',
  build_failed:
    'Your website is rebuilt from scratch after every change, and this one stopped it from rebuilding. Nothing reached the live site, so it is safe to try again.',
  site_unreachable:
    'The service that puts your website online is not answering right now. That is outside your site and usually clears by itself within a few minutes.',
  cost_ceiling:
    'Each change has a spending limit that your developer set for this site. Asking for something smaller, or splitting it in two, will stay inside it.',
  out_of_date:
    'Your website changed while this was being saved, so saving it now would undo that. Ask for the same thing again and it will start from how the site looks now.',
  nothing_to_change:
    'I looked at your site and it already reads the way you asked for, so there was nothing to alter. If you meant somewhere else, say which part.',
  nothing_to_publish:
    'Only a change with a preview you have approved can go live. Wait for the preview to appear, look at it, then approve it.',
  nothing_to_undo:
    'Undo only applies to a change that went live from this conversation. Nothing from this one has, so there is nothing to take back.',
  site_moved_on:
    'Other changes went live after this one did. Undoing this now would take those down with it, so it is not offered.',
  site_conflict:
    'Another change has since altered the same part of your site. Ask for what you want again and it will start from what is there now.',
  model_quota:
    'The writing service this site uses has a daily allowance, and today’s is spent. It starts again tomorrow, and nothing you sent was lost.',
  model_credit:
    'The account behind the writing service has run out of credit. Only your developer can add more, so this one is worth telling them about.',
  model_unavailable:
    'The writing service is not responding at the moment. Nothing is wrong with your website, and it usually comes back within a few minutes.',
  hosting_limit:
    'The plan your website is hosted on limits how often it can be rebuilt, and that limit is reached. Your developer can raise it.',
  internal_error:
    'Something failed inside the editor rather than in what you asked for, so your website was not touched. Try once more, and tell your developer if it keeps happening.',
};

/** Every sentence a client can be shown when something does not go ahead. */
export const CLIENT_PROSE: readonly string[] = [
  ...Object.values(CLIENT_MESSAGES),
  INTERRUPTED_MESSAGE,
  WORK_KEPT_MESSAGE,
  PUBLICATION_IN_PROGRESS,
  BRINGING_UP_TO_DATE,
  ...Object.values(PUBLISH_REFUSALS),
  ...Object.values(UNDO_REFUSALS),
  ...Object.values(ATTACHMENT_REFUSALS),
];

/** The HTTP status each code answers with, per contracts/http-api.md. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  blocked_by_policy: 422,
  request_in_flight: 409,
  too_busy: 503,
  agent_timeout: 504,
  build_failed: 422,
  site_unreachable: 502,
  cost_ceiling: 422,
  out_of_date: 409,
  nothing_to_change: 200,
  nothing_to_publish: 409,
  nothing_to_undo: 409,
  site_moved_on: 409,
  site_conflict: 409,
  model_quota: 503,
  model_credit: 402,
  model_unavailable: 503,
  hosting_limit: 402,
  internal_error: 500,
};

export function clientMessage(code: ErrorCode): string {
  return CLIENT_MESSAGES[code];
}

/**
 * A gate violation always reads as one message, whatever the rule that fired.
 *
 * The client is told an area is protected; which rule caught it is the
 * developer's concern and lives in the durable record, not in the chat.
 */
export function messageForViolation(_violation: PolicyViolation): string {
  return CLIENT_MESSAGES.blocked_by_policy;
}

/**
 * The body every route returns on a failure. Shape is uniform so the interface
 * never guesses.
 *
 * `message` may be narrowed past the code's default — "this change is already
 * published" says more than "there is nothing ready to publish here" — but only
 * from a sentence in this module, so the Principle I audit still covers it. A
 * route composing its own sentence would be a client-facing string nothing
 * checks.
 */
export function errorBody(
  code: ErrorCode,
  message: string = clientMessage(code),
): { error: ErrorCode; message: string } {
  return { error: code, message };
}
