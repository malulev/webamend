/**
 * The shared vocabulary of the installation.
 *
 * Every module below `src/lib` speaks these types at its boundary. They are
 * declared once, here, because the modules are developed independently and a
 * disagreement about a shape is the one bug the tests cannot catch in isolation.
 *
 * Nothing here is persisted. Per constitution VII, GitHub and Netlify are the
 * system of record; these types describe what is read from them, held while a
 * request runs, or written back to them.
 */

// ---------------------------------------------------------------------------
// Installation and configuration
// ---------------------------------------------------------------------------

/** Deployment configuration: secrets and the one site this install serves. */
export interface Env {
  githubAppId: string;
  githubAppPrivateKey: string;
  githubInstallationId: number;
  /** `owner/name` split at load time so no caller re-parses it. */
  githubRepoOwner: string;
  githubRepoName: string;
  netlifyToken: string;
  netlifySiteId: string;
  netlifyWebhookSecret: string;
  openrouterApiKey: string;
  sessionSecret: string;
  /** Lower-cased and de-duplicated. Never sourced from the repository. */
  allowedEmails: string[];
  /** Base32 seed shared by every allowed address: the second factor at sign-in. */
  totpSecret: string;
  smtpUrl: string;
  smtpFrom: string;
  publicBaseUrl: string;
  /** Unix socket of the host admission daemon; absent, requests run without a host queue. */
  slotBrokerSocket?: string;
}

/**
 * How much a client chooses to spend on one change, cheapest first
 * (src/lib/models.ts). A closed vocabulary: the interface offers these five
 * and nothing else, and a request naming no tier runs `Settings.model`.
 */
export type ModelTier = 'free' | 'low' | 'medium' | 'high' | 'extra';

/** Non-secret operational settings from `.webagent/config.yml`. */
export interface Settings {
  alertContact: string;
  costCeilingUsd: number;
  /** What runs when a request names no tier. */
  model: string;
  /** Per-tier overrides of the built-in tier models. Absent tiers keep the default. */
  models?: Partial<Record<ModelTier, string>>;
  /** 1–30. Doubles as the lock staleness threshold. */
  maxRequestMinutes: number;
  /** Where a client's attached files land in the site, relative to the repository root. */
  uploadDir?: string;
}

/** A file a client attached to a request, held on the host only until the request runs. */
export interface Attachment {
  /** The name the client gave it, before sanitising. */
  name: string;
  /** Host path of the temporary copy. Removed once the request ends. */
  tempPath: string;
  size: number;
  type: string;
}

/** Site-declared limits from `.webagent/policy.yml`. All fields defaulted. */
export interface Policy {
  allow: string[];
  deny: string[];
  maxFilesChanged: number;
  maxDiffLines: number;
  forbidNewDependencies: boolean;
  /** Refuse a change that pulls code or content from another origin into a page. */
  forbidExternalCode: boolean;
}

/** What the repository declares, read together because they change together. */
export interface RepoConfig {
  settings: Settings;
  policy: Policy;
  /** `AGENTS.md` at the repository root. Advisory only; empty when absent. */
  guidance: string;
}

// ---------------------------------------------------------------------------
// The policy gate
// ---------------------------------------------------------------------------

export type ChangeKind = 'added' | 'modified' | 'deleted';

/** One path the agent touched, as derived from the working tree's status. */
export interface ChangedFile {
  path: string;
  kind: ChangeKind;
  /** Added plus removed lines for this file. */
  diffLines: number;
  /** The path is a symbolic link in the working tree, whatever it points at. */
  symlink?: boolean;
  /** The lines this change adds, for text files; absent for binaries and deletions. */
  addedText?: string;
}

export type PolicyViolation =
  | 'protected_path'
  | 'denied_path'
  | 'not_allowed_path'
  | 'too_many_files'
  | 'too_many_lines'
  | 'new_dependency'
  | 'symlink'
  | 'external_code';

export type GateResult =
  | { ok: true }
  | {
      ok: false;
      violation: PolicyViolation;
      /** The offending path, so the client-facing message can name the area. */
      path?: string;
      actual?: number;
      limit?: number;
    };

// ---------------------------------------------------------------------------
// Requests and their stages
// ---------------------------------------------------------------------------

export type Stage =
  | 'starting'
  /** Waiting for a free agent slot on a shared host. Absent when one was free at once. */
  | 'queued'
  | 'running'
  | 'gating'
  | 'pushing'
  | 'building'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'abandoned';

export type Outcome = 'succeeded' | 'blocked' | 'failed' | 'abandoned';

/** The client-facing error vocabulary from contracts/http-api.md. */
export type ErrorCode =
  | 'blocked_by_policy'
  | 'request_in_flight'
  | 'too_busy'
  | 'agent_timeout'
  | 'build_failed'
  | 'site_unreachable'
  | 'cost_ceiling'
  | 'out_of_date'
  | 'nothing_to_change'
  | 'nothing_to_publish'
  | 'nothing_to_undo'
  | 'site_moved_on'
  | 'site_conflict'
  // The provider said no, and said why. See jobs/provider-failure.ts.
  | 'model_quota'
  | 'model_credit'
  | 'model_unavailable'
  | 'hosting_limit'
  | 'internal_error';

export interface StageEvent {
  stage: Stage;
  /** ISO 8601, always UTC. */
  at: string;
}

/**
 * What a request is for. A change request runs the agent; publishing and
 * undoing do not, and the interface labels their stages differently
 * (src/components/ProgressTrail.tsx). The kind is also encoded in the request
 * id's prefix (src/lib/conversations.ts), which is how a durable record still
 * says which it was after a restart.
 */
export type RequestKind = 'change' | 'publish' | 'undo';

/** Announced on the bus the moment a request begins, before its first stage. */
export interface RequestAnnouncement {
  conversationNumber: number;
  requestId: string;
  kind: RequestKind;
}

/** An event on the progress stream. Live output is best effort; stages are not. */
export type JobEvent =
  | { type: 'stage'; requestId: string; stage: Stage; at: string }
  | { type: 'output'; requestId: string; text: string }
  | {
      type: 'done';
      requestId: string;
      outcome: Outcome;
      previewUrl?: string;
      /** The client's own website, once a publish or an undo has reached it. */
      liveUrl?: string;
      errorCode?: ErrorCode;
    };

/** Notification kinds, listed in the record so sending stays idempotent. */
export type NotificationEvent =
  'preview_ready' | 'request_blocked' | 'request_failed' | 'published' | 'undone';

// ---------------------------------------------------------------------------
// The durable record — contracts/durable-record.md
// ---------------------------------------------------------------------------

/** The machine-readable block inside a pull request comment. */
export interface RequestRecord {
  requestId: string;
  startedAt: string;
  finishedAt: string;
  outcome: Outcome;
  stages: StageEvent[];
  commitSha?: string;
  filesChanged?: number;
  diffLines?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  previewUrl?: string;
  notified?: NotificationEvent[];
  /** Present when `outcome` is `blocked`. */
  violation?: PolicyViolation;
  blockedPath?: string;
  /** Present when `outcome` is `failed`. */
  errorCode?: ErrorCode;
  errorDetail?: string;
  /**
   * Present, and `true`, when an interrupted run's edits were kept for the
   * next request in this conversation (src/lib/jobs/wip.ts). Never `false`:
   * nothing kept is the ordinary case and says nothing.
   */
  wipSaved?: boolean;
}

/** A comment rendered for the conversation: prose, plus a block when present. */
export interface RecordedComment {
  /** The pull request comment id, so a record can be updated in place. */
  commentId: number;
  author: string;
  createdAt: string;
  /** Client-facing prose. Stands alone without the block (Principle I). */
  prose: string;
  /** Absent for a human comment, or one whose block would not parse. */
  record?: RequestRecord;
}

// ---------------------------------------------------------------------------
// Conversations — a conversation *is* a pull request
// ---------------------------------------------------------------------------

export type ConversationStatus = 'open' | 'published' | 'closed';

export interface Conversation {
  number: number;
  title: string;
  status: ConversationStatus;
  branch: string;
  headSha: string;
  updatedAt: string;
  previewUrl?: string;
}

export type MessageAuthor = 'client' | 'agent';

/** One turn in the conversation, reconstructed from a pull request comment. */
export interface Message {
  id: number;
  author: MessageAuthor;
  at: string;
  text: string;
  outcome?: Outcome;
  errorCode?: ErrorCode;
  previewUrl?: string;
  /** What the request ran and cost, from its record. Shown only in advanced mode. */
  model?: string;
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// The agent container — contracts/repo-files.md
// ---------------------------------------------------------------------------

/** Written to `/control/prompt.json`. The container's only instruction channel. */
export interface AgentPrompt {
  request: string;
  history: Array<{ author: MessageAuthor; text: string }>;
  guidance: string;
  targetHint?: string;
}

/** Read from `/control/result.json` after the container exits. */
export interface AgentResult {
  summary: string;
  filesChanged: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** The last error the model provider returned, when the run ended on one. */
  providerError?: { statusCode: number; message: string };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A signed cookie. There is no server-side session record. */
export interface Session {
  email: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}
