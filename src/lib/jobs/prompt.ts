import type { AgentPrompt, Message, MessageAuthor, Policy } from '@/types';

/**
 * What the agent is told, and nothing more.
 *
 * Each job runs in a fresh container with no session continuity (R1), so the
 * conversation has to be carried into the prompt explicitly. Nothing else
 * reaches the container: no credential, no repository address, no knowledge
 * that a preview or a pull request exists.
 */

/** Beyond this, older turns are dropped: a prompt that grows without bound eventually costs more than the change is worth. */
const MAX_HISTORY_TURNS = 20;

/** Build output is long and mostly noise; the tail is where the error is. */
const MAX_BUILD_DETAIL_CHARS = 2_000;

export interface PromptInput {
  request: string;
  history: Message[];
  /** `AGENTS.md` from the repository root. Advisory only — it never widens the gate. */
  guidance: string;
  targetHint?: string;
  /**
   * The previous request's build failure, when there was one (FR-023).
   *
   * This is the one place raw build output is permitted anywhere in the system.
   * It goes to the agent, which is not a client surface; Principle I governs
   * what a person reads, and the agent cannot fix a build it is not shown.
   */
  buildFailureDetail?: string;
  /**
   * Paths the policy gate has already refused in this conversation.
   *
   * Like the build failure, these are paths and therefore go to the agent and
   * nowhere near a client surface. Without them a refused attempt is repeated
   * on every later request, because the agent can see that a turn was refused
   * but not what it was refused for.
   */
  refusedPaths?: string[];
  /**
   * Where the client's attached files now sit in the working tree, relative to
   * its root. Paths again, and again bound for the agent alone: the agent
   * cannot use an image it is not told the location of.
   */
  attachedPaths?: string[];
  /**
   * Paths already edited in the working tree by an earlier request in this
   * conversation that was interrupted before it finished (src/lib/jobs/wip.ts).
   * Paths, so for the agent alone.
   */
  resumedPaths?: string[];
  /**
   * Every rule the gate will judge the change by. Advisory (the gate is the
   * control), but an agent that knows the boundary stops at it instead of
   * spending eight minutes on a favicon the gate will refuse.
   *
   * The allow list alone used to be sent, which left the expensive failures
   * unexplained: three conversations on one site were refused for
   * `forbidExternalCode` after more than a million tokens, because nothing
   * told the agent that re-adding an `<iframe>` line was a refusal.
   */
  policy?: Policy;
}

export function assemblePrompt(input: PromptInput): AgentPrompt {
  const history = input.history.slice(-MAX_HISTORY_TURNS).map(renderTurn);

  const prompt: AgentPrompt = {
    request: composeRequest(input),
    history,
    guidance: input.guidance.trim(),
  };

  if (input.targetHint) prompt.targetHint = input.targetHint;
  return prompt;
}

/**
 * A turn the agent can read the outcome of.
 *
 * The client-facing prose for a refusal is deliberately vague ("your developer
 * has protected this part of the site"), so on its own it reads like an
 * ordinary reply and the next agent treats the request behind it as still
 * outstanding. Saying plainly that the attempt was refused is what stops it
 * being tried again. The turn keeps its published shape — author and text and
 * nothing else — so the marking rides inside the text.
 */
function renderTurn(message: Message): { author: MessageAuthor; text: string } {
  const turn = { author: message.author, text: message.text };
  if (message.author !== 'agent') return turn;
  if (message.outcome === 'blocked')
    return { ...turn, text: `[refused, not applied] ${turn.text}` };
  if (message.outcome === 'failed') return { ...turn, text: `[failed, not applied] ${turn.text}` };
  return turn;
}

/**
 * The build failure and the refused paths ride inside the request rather than
 * in fields of their own, because the container's prompt shape is a published
 * contract (contracts/repo-files.md) and widening it for these cases would
 * oblige every future agent image to understand them.
 */
function composeRequest(input: PromptInput): string {
  const sections = [
    input.request.trim(),
    policySection(input.policy),
    attachmentSection(input.attachedPaths),
    resumeSection(input.resumedPaths),
    refusalSection(input.refusedPaths),
    buildFailureSection(input.buildFailureDetail),
  ];
  return sections.filter((section) => section !== null).join('\n\n');
}

/**
 * Every limit the gate applies, as the agent needs to read them.
 *
 * The gate is all-or-nothing: one refused file discards the whole run, the
 * compliant files with it. So the opening tells the agent to measure the
 * request against these rules *before* editing and to stop rather than work —
 * a refusal costs the client a full run either way, and the only thing worth
 * saving is the spend.
 *
 * Only rules that actually bite are printed. A policy that allows everything
 * says nothing about paths; one that permits external code says nothing about
 * iframes. A prompt that lists inapplicable rules trains the agent to skim.
 */
function policySection(policy: Policy | undefined): string | null {
  if (!policy) return null;

  const rules = [
    allowRule(policy.allow),
    denyRule(policy.deny),
    externalCodeRule(policy.forbidExternalCode),
    dependencyRule(policy.forbidNewDependencies),
    sizeRule(policy),
    UNREACHABLE_RULE,
  ].filter((rule) => rule !== null);

  return [FAIL_FAST_PREAMBLE, ...rules].join('\n\n');
}

const FAIL_FAST_PREAMBLE =
  'These limits are checked after you finish, and a change that breaks any of them ' +
  'is refused whole — nothing at all is kept, not even the files that were fine. ' +
  'Measure the request against them before you start. If it cannot be done within ' +
  'them, stop without editing anything and say plainly what you could not do; if ' +
  'only part of it fits, do that part and say what you left out.';

/** Named in categories, not as the forty-odd globs of `UNCONDITIONAL_DENIES`: the shape is what the agent needs. */
const UNREACHABLE_RULE =
  'These are out of reach whatever the patterns above allow, and no request can ' +
  'widen them: dependency manifests and lockfiles, CI workflows, hosting ' +
  'configuration and serverless functions, .env files, shell scripts, build-time ' +
  'config files, .webagent/ and AGENTS.md.';

function allowRule(allow: string[]): string | null {
  const globs = [...new Set(allow)].filter((glob) => glob.trim() !== '');
  if (globs.length === 0 || globs.includes('**')) return null;

  return [
    'Only files matching these patterns may be created, edited or removed:',
    ...globs.map((glob) => `- ${glob}`),
  ].join('\n');
}

function denyRule(deny: string[]): string | null {
  const globs = [...new Set(deny)].filter((glob) => glob.trim() !== '');
  if (globs.length === 0) return null;

  return ['These may not be touched at all:', ...globs.map((glob) => `- ${glob}`)].join('\n');
}

/**
 * Worth spelling the shapes out. The rule reads only *added* text, so a swap
 * that keeps an embed's markup identical apart from its id still re-adds the
 * line and is refused — the one thing an agent asked to "replace the second
 * video" would never guess.
 */
function externalCodeRule(forbidExternalCode: boolean): string | null {
  if (!forbidExternalCode) return null;

  return (
    'Do not add markup that makes a page load or run something from another ' +
    'origin: <iframe>, <object>, <embed>, an off-site <script src=...>, <base>, ' +
    '<meta http-equiv="refresh">, or a javascript: URL. This applies to an embed ' +
    'already on the page too — editing its line counts as adding it, so a request ' +
    "to swap one embed for another cannot be done this way. The site's own " +
    'inline scripts and same-origin script files are fine.'
  );
}

function dependencyRule(forbidNewDependencies: boolean): string | null {
  if (!forbidNewDependencies) return null;

  return (
    'Do not add dependencies. Manifests and lockfiles are unreachable, and a ' +
    'library copied straight into the tree (vendor/, node_modules/) is refused too.'
  );
}

function sizeRule(policy: Policy): string {
  return (
    `Change at most ${policy.maxFilesChanged} files and ${policy.maxDiffLines} lines ` +
    'in total, added and removed together.'
  );
}

function attachmentSection(attachedPaths: string[] | undefined): string | null {
  const paths = (attachedPaths ?? []).filter((path) => path.trim() !== '');
  if (paths.length === 0) return null;

  return [
    'The client attached these files with this request. They are already in the ' +
      'working tree at the paths below; use them where the request implies (for ' +
      'example, an image to show on a page) and reference them by these paths. Do ' +
      'not move or rename them.',
    ...paths.map((path) => `- ${path}`),
  ].join('\n');
}

/**
 * The kept edits are unreviewed and possibly half-written, and the request
 * now in hand may not be the one they were made for. So the agent is told to
 * judge them, not to trust them: they count toward the same limits, and
 * whatever is still in the tree when it finishes is what gets published.
 */
function resumeSection(resumedPaths: string[] | undefined): string | null {
  const paths = [...new Set(resumedPaths ?? [])].filter((path) => path.trim() !== '');
  if (paths.length === 0) return null;

  return [
    'An earlier attempt in this conversation was interrupted before it finished. ' +
      'Its edits are already in the working tree at the paths below, unfinished ' +
      'and unreviewed. Read them first. Keep and complete what serves this request ' +
      'rather than starting over, and undo whatever does not: they count toward ' +
      'the limits above like any other edit.',
    ...paths.map((path) => `- ${path}`),
  ].join('\n');
}

function refusalSection(refusedPaths: string[] | undefined): string | null {
  const paths = [...new Set(refusedPaths ?? [])].filter((path) => path.trim() !== '');
  if (paths.length === 0) return null;

  return [
    'An earlier attempt in this conversation was refused for these paths. They are ' +
      'not yours to change: do not create or edit them again. Make the change ' +
      'somewhere permitted, or make no change at all.',
    ...paths.map((path) => `- ${path}`),
  ].join('\n');
}

function buildFailureSection(detail: string | undefined): string | null {
  if (!detail) return null;
  return [
    'The previous attempt broke the site build. This is the end of that build output:',
    '',
    truncateToTail(detail, MAX_BUILD_DETAIL_CHARS),
  ].join('\n');
}

/** Keeps the tail, since a build reports its error last and its banner first. */
function truncateToTail(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `…\n${trimmed.slice(trimmed.length - limit)}`;
}
