# TOTP at Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the email link, a client enters a six-digit authenticator code before getting a session; the `/settings` page and its console password are removed.

**Architecture:** The magic-link callback issues a short-lived *pending* cookie instead of a session. A new `POST /api/auth/code` route verifies a TOTP code against the installation's shared secret and upgrades the pending cookie to the unchanged session cookie. Enrollment is a signed, operator-issued link that renders a QR. Everything is HMAC over `SESSION_SECRET` subkeys, with no server-side state, matching the existing magic link and session modules.

**Tech Stack:** Next.js 15 app router, `node:crypto` HMAC, `otplib` v13 for TOTP, `qrcode` for server-side SVG, vitest (unit + int projects), zod.

**Spec:** `docs/superpowers/specs/2026-09-08-totp-sign-in-design.md`

## Global Constraints

- No database. Every credential is a signed value; nothing is recorded server-side.
- Never print a secret value in tests, logs, scripts, or docs. Names only.
- `Env` field `totpSecret` replaces `configTotpSecret`; env var `TOTP_SECRET`, with `CONFIG_TOTP_SECRET` read as a fallback for one release.
- Pending cookie: name `webagent_pending`, subkey `pending-session`, 10 minutes, httpOnly, sameSite lax.
- Enrollment token: subkey `totp-enroll`, 24 hours.
- Code drift: 30 seconds either side (`epochTolerance: 30`).
- Session cookie shape and `verifySession` unchanged.
- Dictionary keys must exist in all four languages (`en`, `fr`, `nl`, `he`); `tests/unit/i18n/dictionaries.test.ts` audits placeholders.
- Commit after every task with the repository's attribution trailer.

---

### Task 1: Rename the secret and drop the password hash from Env

**Files:**
- Modify: `src/types/index.ts:32-33`
- Modify: `src/lib/config/env.ts:77-78,114-115`
- Modify: `src/lib/config/startup.ts:1,109-136`
- Modify: `scripts/check-env.ts` (warn on the deprecated name)
- Modify (bulk rename): `tests/**/*.ts`, `tests/integration/harness.ts`, `tests/setup/integration.ts`
- Test: `tests/unit/config/env.test.ts`, `tests/integration/startup.test.ts`

**Interfaces:**
- Produces: `Env.totpSecret: string`. `Env.configPasswordHash` and `Env.configTotpSecret` no longer exist.

- [ ] **Step 1: Write the failing env tests**

Add to `tests/unit/config/env.test.ts` (keep the existing `VALID` fixture but replace its two `CONFIG_*` lines with `TOTP_SECRET: 'BASE32SECRET'`):

```ts
it('reads TOTP_SECRET into totpSecret', () => {
  expect(parseEnv(VALID).totpSecret).toBe('BASE32SECRET');
});

it('still accepts CONFIG_TOTP_SECRET as a fallback for one release', () => {
  const { TOTP_SECRET: _dropped, ...withoutNew } = VALID;
  const env = parseEnv({ ...withoutNew, CONFIG_TOTP_SECRET: 'OLDNAME' });
  expect(env.totpSecret).toBe('OLDNAME');
});

it('requires one of the two names', () => {
  const { TOTP_SECRET: _dropped, ...withoutNew } = VALID;
  expect(() => parseEnv(withoutNew)).toThrow(/TOTP_SECRET/);
});

it('no longer knows CONFIG_PASSWORD_HASH', () => {
  const env = parseEnv({ ...VALID, CONFIG_PASSWORD_HASH: 'anything' });
  expect(env).not.toHaveProperty('configPasswordHash');
});
```

Update the required-names list in that file (around line 57): remove `CONFIG_PASSWORD_HASH` and `CONFIG_TOTP_SECRET`; the "every required variable" test should iterate the list without `TOTP_SECRET` because it has a fallback path, and a separate test above covers it.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/unit/config/env.test.ts`
Expected: FAIL, `totpSecret` undefined / type errors.

- [ ] **Step 3: Implement**

`src/types/index.ts`: replace lines 32-33 with:

```ts
  /** Base32 seed shared by every allowed address; the second factor at sign-in. */
  totpSecret: string;
```

`src/lib/config/env.ts`: replace the two `CONFIG_*` schema lines with:

```ts
  TOTP_SECRET: z.string().min(1).optional(),
  /** Deprecated spelling, honoured for one release so a live client keeps starting. */
  CONFIG_TOTP_SECRET: z.string().min(1).optional(),
```

Add a `superRefine` on the object (after `z.object({...})`):

```ts
const rawEnvSchema = z
  .object({ /* ...existing fields... */ })
  .superRefine((data, ctx) => {
    if (!data.TOTP_SECRET && !data.CONFIG_TOTP_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['TOTP_SECRET'], message: 'is required' });
    }
  });
```

In `toEnv`, replace the two `config*` lines with:

```ts
    totpSecret: data.TOTP_SECRET ?? data.CONFIG_TOTP_SECRET!,
```

`src/lib/config/startup.ts`: change the import to `import { isUsableTotpSecret } from '@/lib/auth/totp';` (module created in Task 2; until then keep importing from `config-credential`), rename `checkConfigCredential` to `checkTotpSecret`, delete the hash block, and change the fault to:

```ts
  if (!(await isUsableTotpSecret(env.totpSecret))) {
    faults.push({
      setting: 'TOTP_SECRET',
      message:
        'TOTP_SECRET is not a base32 secret of at least 16 bytes, so no authenticator app ' +
        'could produce a code this installation would accept. Run `npm run gen:secrets` and ' +
        'take the line it prints.',
    });
  }
```

`scripts/check-env.ts`: after the shadowing warning, add:

```ts
  if (merged.CONFIG_TOTP_SECRET && !merged.TOTP_SECRET) {
    console.warn('CONFIG_TOTP_SECRET is the old name; rename it to TOTP_SECRET. It still works this release.');
  }
```

(`merged` is whatever local the script already uses for the combined values; match its name.)

Bulk rename in tests:

```bash
grep -rl "configTotpSecret" tests | xargs sed -i '' 's/configTotpSecret/totpSecret/g'
grep -rl "configPasswordHash" tests | xargs sed -i '' '/configPasswordHash/d'
sed -i '' '/CONFIG_PASSWORD_HASH/,+1d' tests/setup/integration.ts   # removes the two-line assignment
sed -i '' 's/CONFIG_TOTP_SECRET/TOTP_SECRET/' tests/setup/integration.ts
```

Then open `tests/integration/harness.ts` and `tests/setup/integration.ts` to delete the now-orphaned comment about the argon2 hash. In `tests/integration/startup.test.ts` delete the `argon2` import, the `passwordHash` fixture, and the test `refuses a configuration password hash that is not an argon2 hash`; change `faultFor('CONFIG_TOTP_SECRET', ...)` to `faultFor('TOTP_SECRET', ...)`.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx vitest run --project unit tests/unit/config && npx vitest run --project int tests/integration/startup.test.ts`
Expected: typecheck reports only `config-credential.ts` and `src/app/(config)` (removed in Task 2); the named test files PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/types src/lib/config scripts/check-env.ts tests
git commit -m "rename CONFIG_TOTP_SECRET to TOTP_SECRET and drop the password hash"
```

---

### Task 2: TOTP module; delete the configuration surface

**Files:**
- Create: `src/lib/auth/totp.ts`
- Delete: `src/lib/auth/config-credential.ts`, `tests/unit/auth/config-credential.test.ts`, `src/app/(config)/` (all five files)
- Modify: `src/lib/config/startup.ts:1` (import from `@/lib/auth/totp`)
- Test: `tests/unit/auth/totp.test.ts`

**Interfaces:**
- Produces:
  - `verifyTotpCode(code: string, env: Env, now?: Date): Promise<boolean>`
  - `isUsableTotpSecret(secret: string, at?: Date): Promise<boolean>`
  - `otpauthUri(env: Env, issuer: string, account: string): string`

- [ ] **Step 1: Write the failing tests**

`tests/unit/auth/totp.test.ts`:

```ts
import { generate, generateSecret } from 'otplib';
import { describe, expect, it } from 'vitest';

import { isUsableTotpSecret, otpauthUri, verifyTotpCode } from '@/lib/auth/totp';
import type { Env } from '@/types';

const AT = new Date('2026-09-08T10:00:00Z');
const SECRET = generateSecret();

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    githubAppId: 'app-id',
    githubAppPrivateKey: 'private-key',
    githubInstallationId: 1,
    githubRepoOwner: 'client-org',
    githubRepoName: 'client-site',
    netlifyToken: 'netlify-token',
    netlifySiteId: 'netlify-site',
    netlifyWebhookSecret: 'netlify-webhook-secret',
    openrouterApiKey: 'openrouter-key',
    sessionSecret: 'a'.repeat(32),
    allowedEmails: ['jane@client.example'],
    totpSecret: SECRET,
    smtpUrl: 'smtps://user:pass@smtp.example.com:465',
    smtpFrom: 'webagent@client.example',
    publicBaseUrl: 'https://edit.client.example',
    maxConcurrentRuns: 2,
    ...overrides,
  };
}

async function codeAt(at: Date): Promise<string> {
  return generate({ secret: SECRET, epoch: Math.floor(at.getTime() / 1000) });
}

describe('verifyTotpCode', () => {
  it('accepts the current code', async () => {
    expect(await verifyTotpCode(await codeAt(AT), buildEnv(), AT)).toBe(true);
  });

  it('accepts a code from 30 seconds ago', async () => {
    const earlier = new Date(AT.getTime() - 30_000);
    expect(await verifyTotpCode(await codeAt(earlier), buildEnv(), AT)).toBe(true);
  });

  it('refuses a code from two minutes ago', async () => {
    const stale = new Date(AT.getTime() - 120_000);
    expect(await verifyTotpCode(await codeAt(stale), buildEnv(), AT)).toBe(false);
  });

  it('refuses an empty or non-numeric code without throwing', async () => {
    expect(await verifyTotpCode('', buildEnv(), AT)).toBe(false);
    expect(await verifyTotpCode('abcdef', buildEnv(), AT)).toBe(false);
  });

  it('refuses everything when the secret is unusable, rather than throwing', async () => {
    const env = buildEnv({ totpSecret: 'short' });
    expect(await verifyTotpCode('123456', env, AT)).toBe(false);
  });
});

describe('isUsableTotpSecret', () => {
  it('is true for what gen:secrets produces and false for a short one', async () => {
    expect(await isUsableTotpSecret(SECRET, AT)).toBe(true);
    expect(await isUsableTotpSecret('JBSWY3DP', AT)).toBe(false);
  });
});

describe('otpauthUri', () => {
  it('names the issuer and account and carries the secret', () => {
    const uri = otpauthUri(buildEnv(), 'Webamend', 'edit.client.example');
    expect(uri.startsWith('otpauth://totp/Webamend:edit.client.example?')).toBe(true);
    expect(uri).toContain(`secret=${SECRET}`);
    expect(uri).toContain('issuer=Webamend');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/unit/auth/totp.test.ts`
Expected: FAIL, cannot resolve `@/lib/auth/totp`.

- [ ] **Step 3: Implement `src/lib/auth/totp.ts`**

```ts
import { verify as verifyTotp } from 'otplib';
import type { Env } from '@/types';

/**
 * The second factor at sign-in: a six-digit code from an authenticator app
 * seeded with the installation's one shared secret (TOTP_SECRET).
 *
 * No database, so a code is valid for its window plus the drift below, not
 * single-use. That is the same documented trade-off the magic link makes.
 */

const CODE_DRIFT_SECONDS = 30;

export async function verifyTotpCode(code: string, env: Env, now: Date = new Date()): Promise<boolean> {
  const token = code.trim();
  if (!/^\d{6}$/.test(token)) return false;
  try {
    const result = await verifyTotp({
      secret: env.totpSecret,
      token,
      epoch: Math.floor(now.getTime() / 1000),
      epochTolerance: CODE_DRIFT_SECONDS,
    });
    return result.valid;
  } catch {
    // An unusable secret is a startup fault, reported there; here it only
    // ever means "no code is accepted".
    return false;
  }
}

/** Startup validation asks this so a bad secret refuses to serve rather than refusing every client. */
export async function isUsableTotpSecret(secret: string, at: Date = new Date()): Promise<boolean> {
  try {
    await verifyTotp({ secret, token: '000000', epoch: Math.floor(at.getTime() / 1000) });
    return true;
  } catch {
    return false;
  }
}

/** What an authenticator app scans. The secret is in the URI; render it only behind the enrollment token. */
export function otpauthUri(env: Env, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: env.totpSecret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
```

Delete the old surface:

```bash
git rm -r 'src/app/(config)' src/lib/auth/config-credential.ts tests/unit/auth/config-credential.test.ts
```

Update `src/lib/config/startup.ts` line 1 to `import { isUsableTotpSecret } from '@/lib/auth/totp';`.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx vitest run --project unit tests/unit/auth tests/unit/config && npx vitest run --project int tests/integration/startup.test.ts`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "move TOTP verification to its own module and remove the configuration page"
```

---

### Task 3: Pending session cookie

**Files:**
- Create: `src/lib/auth/pending.ts`
- Modify: `src/lib/auth/index.ts` (re-export)
- Test: `tests/unit/auth/pending.test.ts`

**Interfaces:**
- Produces:
  - `PENDING_COOKIE = 'webagent_pending'`
  - `PENDING_TTL_MS = 10 * 60 * 1000`
  - `issuePending(email: string, env: Env, now?: Date): string`
  - `verifyPending(value: string | undefined, env: Env, now?: Date): { email: string } | null`
  - `pendingCookieOptions(env: Env): { httpOnly: true; sameSite: 'lax'; secure: boolean; path: '/'; maxAge: number }`

- [ ] **Step 1: Write the failing tests**

`tests/unit/auth/pending.test.ts` (reuse the `buildEnv` helper shape from Task 2's test, copied into this file):

```ts
import { describe, expect, it } from 'vitest';

import { issuePending, PENDING_COOKIE, PENDING_TTL_MS, pendingCookieOptions, verifyPending } from '@/lib/auth/pending';
import { verifySession } from '@/lib/auth/session';
import type { Env } from '@/types';

const AT = new Date('2026-09-08T10:00:00Z');
// buildEnv: same fixture as tests/unit/auth/totp.test.ts

describe('pending sign-in cookie', () => {
  it('round-trips the email and lower-cases it', () => {
    const cookie = issuePending('Jane@Client.example', buildEnv(), AT);
    expect(verifyPending(cookie, buildEnv(), AT)).toEqual({ email: 'jane@client.example' });
  });

  it('expires after ten minutes', () => {
    const cookie = issuePending('jane@client.example', buildEnv(), AT);
    const later = new Date(AT.getTime() + PENDING_TTL_MS + 1);
    expect(verifyPending(cookie, buildEnv(), later)).toBeNull();
  });

  it('is rejected when tampered with or signed by another installation', () => {
    const cookie = issuePending('jane@client.example', buildEnv(), AT);
    expect(verifyPending(`${cookie}x`, buildEnv(), AT)).toBeNull();
    expect(verifyPending(cookie, buildEnv({ sessionSecret: 'b'.repeat(32) }), AT)).toBeNull();
    expect(verifyPending(undefined, buildEnv(), AT)).toBeNull();
  });

  it('is never accepted as a session, and a session is never accepted as pending', () => {
    const pending = issuePending('jane@client.example', buildEnv(), AT);
    expect(verifySession(pending, buildEnv(), AT)).toBeNull();
  });

  it('names the cookie and scopes it to the whole site', () => {
    expect(PENDING_COOKIE).toBe('webagent_pending');
    const options = pendingCookieOptions(buildEnv());
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: true, maxAge: PENDING_TTL_MS / 1000 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/unit/auth/pending.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/auth/pending.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '@/types';

/**
 * Half a sign-in: the email link has been followed, the code has not been
 * entered. A different cookie signed with a different subkey, so nothing that
 * checks for a session can be fooled by it, and vice versa.
 */

export const PENDING_COOKIE = 'webagent_pending';
export const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingPayload {
  email: string;
  expiresAt: number;
}

function pendingKey(env: Env): Buffer {
  return createHmac('sha256', env.sessionSecret).update('pending-session').digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length > 0 && bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function issuePending(email: string, env: Env, now: Date = new Date()): string {
  const payload: PendingPayload = {
    email: email.trim().toLowerCase(),
    expiresAt: Math.floor((now.getTime() + PENDING_TTL_MS) / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, pendingKey(env))}`;
}

function parsePayload(encoded: string): PendingPayload | null {
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof decoded?.email === 'string' && typeof decoded?.expiresAt === 'number' ? (decoded as PendingPayload) : null;
  } catch {
    return null;
  }
}

export function verifyPending(value: string | undefined, env: Env, now: Date = new Date()): { email: string } | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  if (!signaturesMatch(signature, sign(encoded, pendingKey(env)))) return null;
  const payload = parsePayload(encoded);
  if (!payload || payload.expiresAt * 1000 <= now.getTime()) return null;
  return { email: payload.email };
}

export function pendingCookieOptions(env: Env): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.publicBaseUrl.startsWith('https://'),
    path: '/',
    maxAge: PENDING_TTL_MS / 1000,
  };
}
```

Add to `src/lib/auth/index.ts`:

```ts
export { PENDING_COOKIE, PENDING_TTL_MS, issuePending, pendingCookieOptions, verifyPending } from '@/lib/auth/pending';
export { verifyTotpCode, otpauthUri } from '@/lib/auth/totp';
```

- [ ] **Step 4: Run**

Run: `npx vitest run --project unit tests/unit/auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth tests/unit/auth/pending.test.ts
git commit -m "add the pending sign-in cookie between the email link and the code"
```

---

### Task 4: Enrollment token

**Files:**
- Create: `src/lib/auth/enroll.ts`
- Modify: `src/lib/auth/index.ts`
- Test: `tests/unit/auth/enroll.test.ts`

**Interfaces:**
- Produces:
  - `ENROLL_TTL_MS = 24 * 60 * 60 * 1000`
  - `issueEnrollToken(env: Env, now?: Date): string`
  - `verifyEnrollToken(token: string | null | undefined, env: Env, now?: Date): boolean`
  - `enrollmentUrl(env: Env, now?: Date): string` returning `${env.publicBaseUrl}/login/enroll?token=…`

- [ ] **Step 1: Write the failing tests**

`tests/unit/auth/enroll.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ENROLL_TTL_MS, enrollmentUrl, issueEnrollToken, verifyEnrollToken } from '@/lib/auth/enroll';
import { issueMagicLinkToken } from '@/lib/auth/magic-link';
import type { Env } from '@/types';

const AT = new Date('2026-09-08T10:00:00Z');
// buildEnv: same fixture as tests/unit/auth/totp.test.ts

describe('enrollment token', () => {
  it('verifies for 24 hours and not after', () => {
    const token = issueEnrollToken(buildEnv(), AT);
    expect(verifyEnrollToken(token, buildEnv(), new Date(AT.getTime() + ENROLL_TTL_MS - 1000))).toBe(true);
    expect(verifyEnrollToken(token, buildEnv(), new Date(AT.getTime() + ENROLL_TTL_MS + 1000))).toBe(false);
  });

  it('is not interchangeable with a magic link', () => {
    const magic = issueMagicLinkToken('jane@client.example', buildEnv(), AT)!;
    expect(verifyEnrollToken(magic, buildEnv(), AT)).toBe(false);
  });

  it('rejects garbage without throwing', () => {
    expect(verifyEnrollToken(undefined, buildEnv(), AT)).toBe(false);
    expect(verifyEnrollToken('not.a.token', buildEnv(), AT)).toBe(false);
  });

  it('builds the URL from PUBLIC_BASE_URL', () => {
    const url = enrollmentUrl(buildEnv(), AT);
    expect(url.startsWith('https://edit.client.example/login/enroll?token=')).toBe(true);
    expect(verifyEnrollToken(new URL(url).searchParams.get('token'), buildEnv(), AT)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/unit/auth/enroll.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/auth/enroll.ts`**

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Env } from '@/types';

/**
 * The one link that shows the authenticator secret. Minted by the operator
 * (`npm run enroll:link`), never by the app on its own, and signed with a
 * subkey the magic link does not use, so proof of an inbox is not proof of
 * the right to see the secret.
 */

export const ENROLL_TTL_MS = 24 * 60 * 60 * 1000;

function enrollKey(env: Env): Buffer {
  return createHmac('sha256', env.sessionSecret).update('totp-enroll').digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length > 0 && bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function issueEnrollToken(env: Env, now: Date = new Date()): string {
  const encoded = Buffer.from(JSON.stringify({ iat: now.getTime(), nonce: randomBytes(12).toString('hex') })).toString('base64url');
  return `${encoded}.${sign(encoded, enrollKey(env))}`;
}

export function verifyEnrollToken(token: string | null | undefined, env: Env, now: Date = new Date()): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts as [string, string];
  if (!signaturesMatch(signature, sign(encoded, enrollKey(env)))) return false;
  try {
    const { iat } = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof iat !== 'number') return false;
    const age = now.getTime() - iat;
    return age >= 0 && age <= ENROLL_TTL_MS;
  } catch {
    return false;
  }
}

export function enrollmentUrl(env: Env, now: Date = new Date()): string {
  return `${env.publicBaseUrl}/login/enroll?token=${encodeURIComponent(issueEnrollToken(env, now))}`;
}
```

Add to `src/lib/auth/index.ts`:

```ts
export { ENROLL_TTL_MS, enrollmentUrl, issueEnrollToken, verifyEnrollToken } from '@/lib/auth/enroll';
```

- [ ] **Step 4: Run**

Run: `npx vitest run --project unit tests/unit/auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth tests/unit/auth/enroll.test.ts
git commit -m "add the operator-issued enrollment token"
```

---

### Task 5: Auth routes: callback issues pending, code upgrades it, logout clears both

**Files:**
- Modify: `src/app/api/auth/[...route]/route.ts`
- Test: `tests/integration/auth-code.test.ts`

**Interfaces:**
- Consumes: `issuePending`, `verifyPending`, `PENDING_COOKIE`, `pendingCookieOptions` (Task 3); `verifyTotpCode` (Task 2); existing `issueSession`, `SESSION_COOKIE`, `sessionCookieOptions`, `verifyMagicLinkToken`.
- Produces: `POST /api/auth/code` with body `{ code: string }` → `200 { status: 'ok' }` + session cookie, `401 { error: 'expired' | 'refused' }`.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/auth-code.test.ts`. Follow `tests/integration/stream-route.test.ts` for the `next/headers` mock and `setInstallation`. The auth route reads cookies from the `Request` (not `next/headers`), so build requests with a `cookie` header:

```ts
import { generate } from 'otplib';
import { afterEach, describe, expect, it } from 'vitest';

import { PENDING_COOKIE, SESSION_COOKIE, issueMagicLinkToken, issuePending, verifyPending, verifySession } from '@/lib/auth';
import { loadEnv } from '@/lib/config/env';
import { setInstallation } from '@/lib/installation';
import { createHarness, type Harness } from './harness';

const { GET, POST } = await import('@/app/api/auth/[...route]/route');

let harness: Harness | null = null;
afterEach(async () => { setInstallation(null); await harness?.cleanup(); harness = null; });

function cookieHeader(name: string, value: string): HeadersInit {
  return { cookie: `${name}=${encodeURIComponent(value)}` };
}

function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

async function currentCode(): Promise<string> {
  return generate({ secret: loadEnv().totpSecret });
}

describe('callback', () => {
  it('issues a pending cookie, not a session, and sends the browser to the code page', async () => {
    harness = await createHarness(); // installs an Installation with the fixture env; see harness.ts
    const env = loadEnv();
    const token = issueMagicLinkToken('jane@client.example', env)!;
    const response = await GET(new Request(`http://localhost:3000/api/auth/callback?token=${encodeURIComponent(token)}`), {
      params: Promise.resolve({ route: ['callback'] }),
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login/code');
    const pending = setCookieFor(response, PENDING_COOKIE)!;
    expect(verifyPending(decodeURIComponent(pending.split(';')[0]!.split('=')[1]!), env)).toEqual({ email: 'jane@client.example' });
    expect(setCookieFor(response, SESSION_COOKIE) ?? '').not.toMatch(/webagent_session=[^;]/);
  });
});

describe('code', () => {
  it('upgrades a pending cookie to a session on the right code', async () => {
    harness = await createHarness();
    const env = loadEnv();
    const pending = issuePending('jane@client.example', env);
    const response = await POST(
      new Request('http://localhost:3000/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader(PENDING_COOKIE, pending) },
        body: JSON.stringify({ code: await currentCode() }),
      }),
      { params: Promise.resolve({ route: ['code'] }) },
    );
    expect(response.status).toBe(200);
    const session = setCookieFor(response, SESSION_COOKIE)!;
    expect(verifySession(decodeURIComponent(session.split(';')[0]!.split('=')[1]!), env)?.email).toBe('jane@client.example');
    expect(setCookieFor(response, PENDING_COOKIE)).toMatch(/Max-Age=0/);
  });

  it('refuses a wrong code and keeps the pending cookie', async () => {
    harness = await createHarness();
    const pending = issuePending('jane@client.example', loadEnv());
    const response = await POST(
      new Request('http://localhost:3000/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader(PENDING_COOKIE, pending) },
        body: JSON.stringify({ code: '000000' }),
      }),
      { params: Promise.resolve({ route: ['code'] }) },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'refused' });
    expect(setCookieFor(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('refuses without a pending cookie', async () => {
    harness = await createHarness();
    const response = await POST(
      new Request('http://localhost:3000/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: await currentCode() }),
      }),
      { params: Promise.resolve({ route: ['code'] }) },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'expired' });
  });
});
```

If `createHarness` does not install an `Installation` by itself, copy the `installHarness` helper from `stream-route.test.ts` and call it; the route only needs `env` and `mailer`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project int tests/integration/auth-code.test.ts`
Expected: FAIL, callback redirects to `/` and `code` answers 404.

- [ ] **Step 3: Implement in `route.ts`**

Imports: add `PENDING_COOKIE, issuePending, pendingCookieOptions, verifyPending, verifyTotpCode` from `@/lib/auth`.

Add a limiter next to the sign-in one:

```ts
const codeLimiter = createRateLimiter({ limit: 10, windowMs: FIFTEEN_MINUTES_MS });
```

(Attach it to the same `globalThis` record the sign-in limiter uses, as a third key `byAddressForCode`.)

Route dispatch in `POST`: add `if (action === 'code') return verifyCode(request);`.

Replace `completeSignIn`:

```ts
async function completeSignIn(request: Request): Promise<NextResponse> {
  const installation = getInstallation();
  const token = new URL(request.url).searchParams.get('token');
  const verified = token ? verifyMagicLinkToken(token, installation.env) : null;
  if (!verified) {
    return NextResponse.redirect(new URL('/login?error=expired', installation.env.publicBaseUrl));
  }
  // Half a sign-in. The session is issued only by `verifyCode`, after the
  // authenticator code; a browser that never enters one holds nothing usable.
  const response = NextResponse.redirect(new URL('/login/code', installation.env.publicBaseUrl));
  response.cookies.set(PENDING_COOKIE, issuePending(verified.email, installation.env), pendingCookieOptions(installation.env));
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(installation.env), maxAge: 0 });
  return response;
}
```

Add:

```ts
const codeSchema = z.object({ code: z.string().trim().min(1).max(12) });

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function verifyCode(request: Request): Promise<NextResponse> {
  const installation = getInstallation();
  const env = installation.env;
  const pending = verifyPending(readCookie(request, PENDING_COOKIE), env);
  if (!pending) return NextResponse.json({ error: 'expired' }, { status: 401 });

  // Counted before the code is looked at, so guessing costs the same whether
  // the guess is close or not.
  if (!signInLimiter.byAddressForCode.allow(clientAddress(request))) {
    console.warn('[webagent] sign-in code refused (rate limited)');
    return NextResponse.json({ error: 'refused' }, { status: 401 });
  }

  const parsed = codeSchema.safeParse(await request.json().catch(() => null));
  const accepted = parsed.success && (await verifyTotpCode(parsed.data.code, env));
  if (!accepted) {
    console.warn('[webagent] sign-in code refused (wrong code)');
    return NextResponse.json({ error: 'refused' }, { status: 401 });
  }

  const response = NextResponse.json({ status: 'ok' });
  response.cookies.set(SESSION_COOKIE, issueSession(pending.email, env), sessionCookieOptions(env));
  response.cookies.set(PENDING_COOKIE, '', { ...pendingCookieOptions(env), maxAge: 0 });
  return response;
}
```

In `logout()`, also clear the pending cookie:

```ts
  response.cookies.set(PENDING_COOKIE, '', { ...pendingCookieOptions(getInstallation().env), maxAge: 0 });
```

- [ ] **Step 4: Run**

Run: `npx vitest run --project int tests/integration/auth-code.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/auth/[...route]/route.ts' tests/integration/auth-code.test.ts
git commit -m "ask for an authenticator code after the sign-in link"
```

---

### Task 6: The code page and the enrollment page, with translations

**Files:**
- Create: `src/app/login/code/page.tsx`, `src/app/login/enroll/page.tsx`, `src/app/login/enroll/EnrollCard.tsx`
- Modify: `src/lib/i18n/types.ts` (login keys), `src/lib/i18n/en.ts`, `fr.ts`, `nl.ts`, `he.ts`, `src/components/client.css`
- Modify: `package.json` (add `qrcode`, `@types/qrcode`; remove `argon2`)
- Test: `tests/unit/components/login-code.test.tsx`, `tests/unit/i18n/dictionaries.test.ts` (existing audit must still pass)

**Interfaces:**
- Consumes: `POST /api/auth/code` (Task 5), `verifyEnrollToken`, `otpauthUri` (Tasks 2, 4).

- [ ] **Step 1: Dependencies**

```bash
npm uninstall argon2
npm install qrcode@^1.5.4
npm install -D @types/qrcode@^1.5.5
```

Check `package.json` `overrides` still apply; run `npm run typecheck` to confirm nothing else imported `argon2`.

- [ ] **Step 2: Dictionary keys (all four languages)**

Add to `Dictionary['login']` in `src/lib/i18n/types.ts`:

```ts
    codeTitle: string;
    codeHint: string;
    codeLabel: string;
    codeSubmit: string;
    codeChecking: string;
    codeRefused: string;
    codeExpired: string;
    enrollTitle: string;
    enrollHint: string;
    enrollKey: string;
    enrollDone: string;
    enrollExpired: string;
```

`en.ts`:

```ts
    codeTitle: 'Enter your code',
    codeHint: 'Open your authenticator app and type the six-digit code for this website.',
    codeLabel: 'Six-digit code',
    codeSubmit: 'Continue',
    codeChecking: 'Checking…',
    codeRefused: 'That code was not accepted. Try the next one your app shows.',
    codeExpired: 'That sign-in link has expired. Request a new one.',
    enrollTitle: 'Set up your authenticator',
    enrollHint: 'Scan this with Google Authenticator, 1Password, Authy or any authenticator app. You will type its six-digit code each time you sign in.',
    enrollKey: 'Or enter this key by hand:',
    enrollDone: 'Done. Sign in',
    enrollExpired: 'This setup link has expired. Ask your developer for a new one.',
```

`fr.ts`:

```ts
    codeTitle: 'Saisissez votre code',
    codeHint: 'Ouvrez votre application d’authentification et saisissez le code à six chiffres de ce site.',
    codeLabel: 'Code à six chiffres',
    codeSubmit: 'Continuer',
    codeChecking: 'Vérification…',
    codeRefused: 'Ce code n’a pas été accepté. Essayez le suivant affiché par votre application.',
    codeExpired: 'Ce lien de connexion a expiré. Demandez-en un nouveau.',
    enrollTitle: 'Configurez votre application d’authentification',
    enrollHint: 'Scannez ceci avec Google Authenticator, 1Password, Authy ou toute application d’authentification. Vous saisirez son code à six chiffres à chaque connexion.',
    enrollKey: 'Ou saisissez cette clé à la main :',
    enrollDone: 'Terminé. Se connecter',
    enrollExpired: 'Ce lien de configuration a expiré. Demandez-en un nouveau à votre développeur.',
```

`nl.ts`:

```ts
    codeTitle: 'Voer je code in',
    codeHint: 'Open je authenticator-app en typ de zescijferige code voor deze website.',
    codeLabel: 'Zescijferige code',
    codeSubmit: 'Doorgaan',
    codeChecking: 'Controleren…',
    codeRefused: 'Die code is niet geaccepteerd. Probeer de volgende die je app toont.',
    codeExpired: 'Deze aanmeldlink is verlopen. Vraag een nieuwe aan.',
    enrollTitle: 'Stel je authenticator in',
    enrollHint: 'Scan dit met Google Authenticator, 1Password, Authy of een andere authenticator-app. Bij elke aanmelding typ je de zescijferige code.',
    enrollKey: 'Of voer deze sleutel handmatig in:',
    enrollDone: 'Klaar. Aanmelden',
    enrollExpired: 'Deze installatielink is verlopen. Vraag je ontwikkelaar om een nieuwe.',
```

`he.ts`:

```ts
    codeTitle: 'הזינו את הקוד',
    codeHint: 'פתחו את אפליקציית האימות והקלידו את הקוד בן שש הספרות של האתר הזה.',
    codeLabel: 'קוד בן שש ספרות',
    codeSubmit: 'המשך',
    codeChecking: 'בודק…',
    codeRefused: 'הקוד לא התקבל. נסו את הקוד הבא שהאפליקציה מציגה.',
    codeExpired: 'קישור הכניסה פג תוקף. בקשו קישור חדש.',
    enrollTitle: 'הגדרת אפליקציית האימות',
    enrollHint: 'סרקו עם Google Authenticator, 1Password, Authy או כל אפליקציית אימות. בכל כניסה תקלידו את הקוד בן שש הספרות שלה.',
    enrollKey: 'או הזינו את המפתח ידנית:',
    enrollDone: 'סיימתי. כניסה',
    enrollExpired: 'קישור ההגדרה פג תוקף. בקשו מהמפתח שלכם קישור חדש.',
```

- [ ] **Step 3: Write the failing component test**

`tests/unit/components/login-code.test.tsx` (match the setup used by `tests/unit/components/composer.test.tsx` for rendering with `LocaleProvider`):

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CodePage from '@/app/login/code/page';
import { LocaleProvider } from '@/components/LocaleProvider';

const assign = vi.fn();
vi.stubGlobal('location', { ...window.location, assign });

afterEach(() => { vi.restoreAllMocks(); assign.mockReset(); });

function renderPage() {
  return render(<LocaleProvider initialLocale="en"><CodePage /></LocaleProvider>);
}

describe('code page', () => {
  it('posts the code and goes home when accepted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    renderPage();
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continue' }).closest('form')!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('shows the refusal and keeps the form', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'refused' }), { status: 401 }));
    renderPage();
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '000000' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continue' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('That code was not accepted');
  });

  it('sends the browser back to sign in when the link expired', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }));
    renderPage();
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '000000' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continue' }).closest('form')!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?error=expired'));
  });
});
```

(If existing component tests use a different `LocaleProvider` prop name, copy their exact usage.)

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run --project unit tests/unit/components/login-code.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `src/app/login/code/page.tsx`**

```tsx
'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

import { Wordmark } from '@/components/Brand';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useTranslation } from '@/components/LocaleProvider';
import '@/components/client.css';

export default function CodePage() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checking || code.trim().length === 0) return;
    setChecking(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (response.ok) {
        window.location.assign('/');
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'expired') {
        window.location.assign('/login?error=expired');
        return;
      }
      setError(t.login.codeRefused);
      setCode('');
    } catch {
      setError(t.login.codeRefused);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="login login--narrow">
      <section className="login__form-panel">
        <div className="login__lang">
          <LanguageSwitcher />
        </div>
        <div className="login__card">
          <Wordmark size={24} />
          <form className="login__form" onSubmit={submit}>
            <h2>{t.login.codeTitle}</h2>
            <p className="login__form-hint">{t.login.codeHint}</p>
            <label className="login__label" htmlFor="code">
              {t.login.codeLabel}
            </label>
            <input
              id="code"
              className="login__input login__input--code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              dir="ltr"
            />
            <button className="login__submit" type="submit" disabled={checking}>
              {checking ? t.login.codeChecking : t.login.codeSubmit}
            </button>
            {error ? (
              <p className="login__error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </div>
      </section>
    </main>
  );
}
```

Add to `src/components/client.css` next to the other `.login__*` rules:

```css
.login--narrow { grid-template-columns: 1fr; place-items: center; }
.login__input--code { font-size: 1.6rem; letter-spacing: 0.4em; text-align: center; font-variant-numeric: tabular-nums; }
.enroll__qr { width: min(260px, 70vw); height: auto; margin: 1rem auto; display: block; background: #fff; padding: 12px; border-radius: 8px; }
.enroll__key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; user-select: all; }
```

Also, in `src/app/login/page.tsx`, read `?error=expired` and show `t.login.codeExpired` as the initial `error` state:

```tsx
const [error, setError] = useState<string | null>(() =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('error') === 'expired'
    ? t.login.codeExpired
    : null,
);
```

- [ ] **Step 6: Implement the enrollment page**

`src/app/login/enroll/page.tsx` (server component):

```tsx
import QRCode from 'qrcode';

import { otpauthUri, verifyEnrollToken } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { dictionaryFor } from '@/lib/i18n';
import { readLocale } from '@/lib/i18n/server';
import { getInstallation } from '@/lib/installation';
import { EnrollCard } from './EnrollCard';

export const dynamic = 'force-dynamic';

export default async function EnrollPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { env } = getInstallation();
  const { token } = await searchParams;
  const t = dictionaryFor(await readLocale());

  if (!verifyEnrollToken(token, env)) {
    return <EnrollCard expiredText={t.login.enrollExpired} />;
  }

  const account = new URL(env.publicBaseUrl).hostname;
  const uri = otpauthUri(env, BRAND.name, account);
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 240 });

  return (
    <EnrollCard
      title={t.login.enrollTitle}
      hint={t.login.enrollHint}
      keyLabel={t.login.enrollKey}
      secret={env.totpSecret}
      qrSvg={svg}
      doneText={t.login.enrollDone}
    />
  );
}
```

`src/app/login/enroll/EnrollCard.tsx`:

```tsx
import { Wordmark } from '@/components/Brand';
import '@/components/client.css';

type Props =
  | { expiredText: string }
  | { title: string; hint: string; keyLabel: string; secret: string; qrSvg: string; doneText: string };

export function EnrollCard(props: Props) {
  return (
    <main className="login login--narrow">
      <section className="login__form-panel">
        <div className="login__card">
          <Wordmark size={24} />
          {'expiredText' in props ? (
            <p className="login__error" role="alert">
              {props.expiredText}
            </p>
          ) : (
            <div className="enroll">
              <h2>{props.title}</h2>
              <p className="login__form-hint">{props.hint}</p>
              {/* The SVG comes from the qrcode library over a URI we built; nothing user-supplied is in it. */}
              <div className="enroll__qr" dangerouslySetInnerHTML={{ __html: props.qrSvg }} />
              <p className="login__form-hint">{props.keyLabel}</p>
              <p className="enroll__key" dir="ltr">
                {props.secret}
              </p>
              <a className="login__submit" href="/login">
                {props.doneText}
              </a>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 7: Run**

Run: `npx vitest run --project unit && npm run typecheck && npm run lint`
Expected: PASS, including `tests/unit/i18n/dictionaries.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src tests
git commit -m "add the code page and the enrollment page"
```

---

### Task 7: gen:secrets without a password; enroll:link script

**Files:**
- Modify: `scripts/gen-secrets.ts`
- Create: `scripts/enroll-link.ts`
- Modify: `package.json` scripts
- Test: `tests/unit/config/dotenv-escaping.test.ts` (existing; keep passing), `tests/unit/config/gen-secrets.test.ts` (new)

- [ ] **Step 1: Write the failing test**

`tests/unit/config/gen-secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { mintSecrets } from '../../../scripts/gen-secrets';

describe('gen:secrets', () => {
  it('emits exactly the three deployment secrets, escaped for dotenv', () => {
    const lines = mintSecrets().split('\n');
    expect(lines.map((line) => line.split('=')[0])).toEqual(['SESSION_SECRET', 'NETLIFY_WEBHOOK_SECRET', 'TOTP_SECRET']);
    expect(lines.every((line) => !line.includes('$'))).toBe(true);
    expect(lines[2]!.split('=')[1]).toMatch(/^[A-Z2-7]{32}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit tests/unit/config/gen-secrets.test.ts`
Expected: FAIL, `mintSecrets` not exported.

- [ ] **Step 3: Implement**

In `scripts/gen-secrets.ts`: remove the `argon2` import and `readPassword`; replace `main` with:

```ts
export function mintSecrets(): string {
  return [
    ['SESSION_SECRET', randomBytes(48).toString('base64url')],
    ['NETLIFY_WEBHOOK_SECRET', randomBytes(32).toString('base64url')],
    ['TOTP_SECRET', toBase32(randomBytes(20))],
  ]
    .map(([name, value]) => `${name}=${escapeForDotenv(value!)}`)
    .join('\n');
}

function main(): void {
  console.log(mintSecrets());
}
```

Update the header comment: three values, usage `npm run gen:secrets >> .env`.

Create `scripts/enroll-link.ts`:

```ts
import { enrollmentUrl } from '../src/lib/auth/enroll';
import { loadEnvFromFiles } from './repo-env';

/**
 * Prints the one link that shows the authenticator secret. Send it to the
 * client; it works for 24 hours. Run it again for a new one.
 */
console.log(enrollmentUrl(loadEnvFromFiles()));
```

`package.json` scripts: add `"enroll:link": "tsx scripts/enroll-link.ts"`.

- [ ] **Step 4: Run**

Run: `npx vitest run --project unit tests/unit/config && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts package.json tests/unit/config/gen-secrets.test.ts
git commit -m "mint three secrets without a password and add enroll:link"
```

---

### Task 8: Ops scripts

**Files:**
- Modify: `ops/launch-client.sh` (steps 3 and print_done), `ops/provision-client.sh` (skeleton comment and epilogue)

- [ ] **Step 1: launch-client.sh**

Replace `step_secrets` with:

```bash
step_secrets() {
  step "3/8 mint secrets"
  local env_file
  env_file="$(env_file_path)"
  if [ -n "$(read_env_value "$env_file" TOTP_SECRET)" ] || [ -n "$(read_env_value "$env_file" CONFIG_TOTP_SECRET)" ]; then
    note "secrets already present (TOTP_SECRET is set); not minting again"
    return 0
  fi
  local out
  out="$(node_in_container 'npm run --silent gen:secrets')" || die "gen:secrets failed; see the output above"
  [ -n "$out" ] || die "gen:secrets produced nothing"
  printf '\n%s\n' "$out" | runuser -u "$SLUG" -- tee -a "$env_file" >/dev/null
  chmod 0600 "$env_file"
  note "appended SESSION_SECRET, NETLIFY_WEBHOOK_SECRET, TOTP_SECRET"
}
```

Delete `read_console_password`. Add after `step_verify`, called from `main` before `print_done`:

```bash
# The client enrols their authenticator through this link. It is the only
# place the secret is shown, and it is valid for 24 hours.
print_enrollment_link() {
  local env_file link
  env_file="$(env_file_path)"
  link="$(node_in_container 'cp /secret/.env /build/.env && npm run --silent enroll:link' -v "${env_file}:/secret/.env:ro")" || {
    note "could not mint an enrollment link; run later: npm run enroll:link (in the node container, see ops/README.md)"
    return 0
  }
  echo
  echo "Send this to the client. It shows the authenticator QR once and works for 24 hours:"
  echo "  ${link}"
}
```

Update the header comment (step 3 line) and the "Two things are deliberately interactive" paragraph: only the editor is interactive now. In `print_done`, replace the "Open /settings with the console password" line with "Sign in: the email link, then the code from the authenticator."

- [ ] **Step 2: provision-client.sh**

In `write_env_skeleton`'s heredoc, replace the last comment block with:

```
# --- Minted by gen:secrets, never chosen by hand ----------------------------
# Append them; do not type them:
#   npm run gen:secrets >> ${env_file}
# SESSION_SECRET, NETLIFY_WEBHOOK_SECRET, TOTP_SECRET
```

In `print_next_steps`, drop `--password "<console password>"` from the docker command and replace the `CONFIG_TOTP_SECRET` paragraph with:

```
     Then mint the client's enrollment link and send it to them:
       docker run --rm -v ${REPO_ROOT}:/src:ro -v ${dir}/.env:/secret/.env:ro -w /build node:22-slim \\
         sh -c 'cp -a /src/. /build && cp /secret/.env /build/.env && npm ci --silent && npm run --silent enroll:link'
```

- [ ] **Step 3: Check and commit**

Run: `bash -n ops/launch-client.sh && bash -n ops/provision-client.sh`

```bash
git add ops
git commit -m "mint secrets without a password and print the enrollment link"
```

---

### Task 9: Docs and contract

**Files:**
- Modify: `README.md`, `docs/QUICKSTART.md`, `docs/NEW-CLIENT.md`, `ops/README.md`, `.env.example`, `specs/001-conversational-site-editing/contracts/http-api.md`

- [ ] **Step 1: README**

- Lines 95-104: `npm run gen:secrets >> .env`; it mints `SESSION_SECRET`, `NETLIFY_WEBHOOK_SECRET`, `TOTP_SECRET`. Replace the "Add CONFIG_TOTP_SECRET to an authenticator app" paragraph with: "Signing in takes the email link and then a six-digit code from an authenticator app seeded with `TOTP_SECRET`. Send each client `npm run enroll:link`'s URL once; it shows the QR for 24 hours."
- Line 179 table row: `npm run gen:secrets` and add a row for `npm run enroll:link`.
- Line 243: drop "and `/settings` shows it".
- Lines 328-332 ("`/settings` shows the configuration in force…"): replace with one sentence: "There is no configuration page: the configuration in force is the repository's `.webagent/` files and the deployment's `.env`, both versioned or backed up, neither editable from the web."
- Line 413 "its TOTP secret in an authenticator": keep; it is now the client's authenticator.

- [ ] **Step 2: QUICKSTART and NEW-CLIENT**

- `docs/QUICKSTART.md`: `npm run gen:secrets >> .env`; remove `CONFIG_TOTP_SECRET` sentence; in the VPS section replace "pauses for the `.env` edit, the console password and the TOTP secret" with "pauses for the `.env` edit and prints the client's enrollment link at the end". Add under "Run locally": "Enroll your authenticator: `npm run enroll:link`, open the URL, scan."
- `docs/NEW-CLIENT.md`: replace the `gen:secrets`, `CONFIG_TOTP_SECRET` and `/settings` items with: "Run `gen:secrets` as the client user (no password)", "Send the client the enrollment link the script prints; it works 24 hours", and under "Prove it works": "Scan the QR, request a sign-in link, enter the code, land on the conversation list."

- [ ] **Step 3: ops/README, .env.example, contract**

- `ops/README.md`: remove `--password "a console password you pick"` and the `CONFIG_TOTP_SECRET` note; add the enroll:link docker command from Task 8 step 2.
- `.env.example`: replace `CONFIG_PASSWORD_HASH=` and `CONFIG_TOTP_SECRET=` with a single `TOTP_SECRET=` and a comment "base32, minted by gen:secrets; the shared authenticator seed for sign-in". Edit with `sed`, since the Read tool is denied on this path by project settings.
- `specs/001-conversational-site-editing/contracts/http-api.md` auth table: callback row → "`302` to `/login/code` with a pending cookie"; add `/api/auth/code | POST | { code } | 200 sets the session cookie; 401 { error: 'expired' | 'refused' }`; add `/login/enroll?token= | GET | operator-issued, 24 h | the QR page`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs ops/README.md .env.example specs
git commit -m "document sign-in with an authenticator code and the enrollment link"
```

---

### Task 10: Full check, release, migrate the live client

- [ ] **Step 1: Everything green**

Run: `npm run lint && npm run typecheck && npm test && npm run test:int`
Expected: PASS. Fix anything that is not.

- [ ] **Step 2: Push**

```bash
git push
```

- [ ] **Step 3: On the VPS (operator, as root)**

```bash
cd /opt/webamend/src && git pull
sudo -u malulev sed -i 's/^CONFIG_TOTP_SECRET=/TOTP_SECRET=/' /srv/webamend/malulev/.env
sudo -u malulev sed -i '/^CONFIG_PASSWORD_HASH=/d' /srv/webamend/malulev/.env
ops/release.sh --client malulev
docker run --rm -v /opt/webamend/src:/src:ro -v /srv/webamend/malulev/.env:/secret/.env:ro -w /build node:22-slim \
  sh -c 'cp -a /src/. /build && cp /secret/.env /build/.env && npm ci --silent && npm run --silent enroll:link'
```

Open the printed link, scan, then sign in at `https://edit.malulev.com` with the email link and the code.
