import { z } from 'zod';
import type { Env } from '@/types';

/**
 * Deployment configuration, read once at process startup (constitution VII —
 * this is the one piece of durable state the product is allowed).
 *
 * `parseEnv` is the pure half: given a bag of strings, it either returns a
 * fully-typed `Env` or throws one error that names every fault it found, not
 * just the first. Keeping it pure is what makes the "every required
 * variable" and "aggregated error" tests possible without touching
 * `process.env`.
 */

// `owner/name`, and nothing either side of the slash may itself contain a
// slash or whitespace — that is what makes the split below safe.
const GITHUB_REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/** Loose enough to catch a typo, not a full RFC 5322 validator. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * `ALLOWED_EMAILS` is the one place permitted sign-ins live (FR-003c1); it is
 * deliberately never read from the repository. Runs inside the schema, via
 * `ctx.addIssue`, so a malformed list is reported alongside every other
 * fault rather than only after the rest of the environment is fixed.
 */
function normaliseAllowedEmails(raw: string, ctx: z.RefinementCtx): string[] | typeof z.NEVER {
  const emails = Array.from(
    new Set(
      raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  );

  if (emails.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'must list at least one email address' });
    return z.NEVER;
  }

  const malformed = emails.filter((email) => !looksLikeEmail(email));
  if (malformed.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `contains an address that is not a plausible email: ${malformed.join(', ')}`,
    });
    return z.NEVER;
  }

  return emails;
}

const rawEnvSchema = z.object({
  GITHUB_APP_ID: z.string().min(1, 'is required'),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .min(1, 'is required')
    // The PEM may arrive with literal backslash-n sequences (see .env.example);
    // turn them into real newlines so the key parses as PEM later.
    .transform((value) => value.replace(/\\n/g, '\n')),
  GITHUB_INSTALLATION_ID: z
    .string()
    .min(1, 'is required')
    .regex(/^\d+$/, 'must be a positive integer')
    .transform(Number),
  GITHUB_REPO: z.string().min(1, 'is required').regex(GITHUB_REPO_PATTERN, 'must be in the form owner/name'),
  NETLIFY_TOKEN: z.string().min(1, 'is required'),
  NETLIFY_SITE_ID: z.string().min(1, 'is required'),
  NETLIFY_WEBHOOK_SECRET: z.string().min(1, 'is required'),
  OPENROUTER_API_KEY: z.string().min(1, 'is required'),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ALLOWED_EMAILS: z.string().min(1, 'is required').transform(normaliseAllowedEmails),
  TOTP_SECRET: z.string().min(1).optional(),
  /** The old spelling, honoured for one release so a live installation keeps starting. */
  CONFIG_TOTP_SECRET: z.string().min(1).optional(),
  SMTP_URL: z.string().min(1, 'is required'),
  SMTP_FROM: z.string().min(1, 'is required'),
  PUBLIC_BASE_URL: z.url({ message: 'must be a valid absolute URL' }),
  /**
   * The host admission daemon's socket, as seen from inside the container
   * (docker-compose.yml mounts /run/webamend at the same path). Unset means no
   * host-wide queue: a development machine, or a host not yet upgraded.
   */
  SLOT_BROKER_SOCKET: z.string().min(1, 'must be a socket path when set').optional(),
})
  // Either spelling satisfies the requirement; the fault is reported under
  // the name a fresh deployment should use.
  .superRefine((data, ctx) => {
    if (!data.TOTP_SECRET && !data.CONFIG_TOTP_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['TOTP_SECRET'], message: 'is required' });
    }
  });

/** One line per fault, each prefixed with the variable it names. */
function formatAggregatedError(error: z.ZodError): Error {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join('.') || '(environment)';
    return `- ${name}: ${issue.message}`;
  });
  return new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}

function toEnv(data: z.infer<typeof rawEnvSchema>): Env {
  const [githubRepoOwner, githubRepoName] = data.GITHUB_REPO.split('/');
  return {
    githubAppId: data.GITHUB_APP_ID,
    githubAppPrivateKey: data.GITHUB_APP_PRIVATE_KEY,
    githubInstallationId: data.GITHUB_INSTALLATION_ID,
    githubRepoOwner: githubRepoOwner!,
    githubRepoName: githubRepoName!,
    netlifyToken: data.NETLIFY_TOKEN,
    netlifySiteId: data.NETLIFY_SITE_ID,
    netlifyWebhookSecret: data.NETLIFY_WEBHOOK_SECRET,
    openrouterApiKey: data.OPENROUTER_API_KEY,
    sessionSecret: data.SESSION_SECRET,
    allowedEmails: data.ALLOWED_EMAILS,
    totpSecret: (data.TOTP_SECRET ?? data.CONFIG_TOTP_SECRET)!,
    smtpUrl: data.SMTP_URL,
    smtpFrom: data.SMTP_FROM,
    publicBaseUrl: data.PUBLIC_BASE_URL,
    slotBrokerSocket: data.SLOT_BROKER_SOCKET,
  };
}

/** Pure and synchronous, so tests build a raw bag of strings without ever touching `process.env`. */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = rawEnvSchema.safeParse(raw);
  if (!result.success) {
    throw formatAggregatedError(result.error);
  }
  return toEnv(result.data);
}

// Not evaluated until something calls `loadEnv()` — importing this module
// must never throw just because `process.env` happens to be incomplete
// (tests import it freely). Application startup is expected to call
// `loadEnv()` once, early, so a bad configuration refuses to serve rather
// than failing later at the first request.
let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = parseEnv(process.env);
  }
  return cachedEnv;
}
