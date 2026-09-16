// The second factor at sign-in. The load-bearing case is the drift window:
// a code from the previous 30-second step is accepted, one from two minutes
// ago is not, and an unusable secret refuses everything rather than throwing.
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

  it('accepts surrounding whitespace, since phones add it', async () => {
    expect(await verifyTotpCode(` ${await codeAt(AT)} `, buildEnv(), AT)).toBe(true);
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
    expect(uri.startsWith('otpauth://totp/Webamend%3Aedit.client.example?')).toBe(true);
    expect(uri).toContain(`secret=${SECRET}`);
    expect(uri).toContain('issuer=Webamend');
  });
});
