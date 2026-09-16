# Self-serve setup wizard — design

**Date:** 2026-09-16 (v2, after three independent reviews)
**Status:** draft, awaiting review
**Repos touched:** `website-ai-auto-builder` (the product), the landing site

## 1. Problem

Bringing a paying customer from "subscribed" to "working editor" takes an
operator and a customer trading secrets by email. Today the operator needs
values only the customer can produce — a GitHub App on their repository,
the installation, the repository, a Netlify token, the Netlify site, an
OpenRouter key — plus the sign-in list, and gets them through the `/thanks`
form and follow-up mail. The Netlify token and the OpenRouter key travel in
plain email, the operator types them into `/srv/webamend/<slug>/.env` by
hand, and every install waits on a DNS record the customer has to create.

The result: one business day per client, secrets handled by a human who
should never see them, and a checklist (`docs/NEW-CLIENT.md`) that only the
operator can run.

## 2. Goal

After payment, the operator runs **one command per site** with no
interactive pause and never touches a customer secret. The customer connects
GitHub, Netlify and OpenRouter from a wizard on **their own instance**, over
HTTPS, and the instance writes its own configuration. The landing, the
email, and the host's shared configuration carry **no customer secret and
no secret shared across customers**. End state is the app in its normal mode
with a valid configuration, ready for the first change request.

Out of scope (listed so nobody looks for them here): custom domains
(`edit.<theirdomain>`), automatic provisioning from the Dodo webhook, a
second VPS, deprovisioning, per-user TOTP, a settings page after setup
(re-running one provider's step is covered), wildcard certificates.

## 3. Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Where the wizard lives | On the client's instance, `/setup` | Secrets never leave the box that uses them. |
| GitHub App | **One App per customer**, created by the customer through GitHub's manifest flow | A shared App's private key on every tenant host would let one tenant mint tokens for every other tenant's repository. Per-tenant Apps put the blast radius at one customer. |
| Netlify OAuth | One operator-owned OAuth application, **implicit grant** (`response_type=token`) | No client secret exists anywhere; the token returns in a URL fragment, which no server, log or Referer ever sees. |
| OpenRouter key | Customer brings their own | Their spend, their limit. |
| Default hostname | `<slug>.<WEBAMEND_BASE_DOMAIN>` (wildcard DNS) | Removes the DNS wait; the per-host certificate issues immediately. |
| Unit of provisioning | **One site = one instance = one launch.** An agency with five sites runs five launches with the same buyer email. | Slugs name sites, not people; capacity counts sites. |
| Provisioning trigger | Operator runs `ops/launch-client.sh` by hand after the onboarding-form email | A landing function with root on the host is not worth it at this volume. |
| Capacity | `MAX_CLIENTS` in `/etc/webamend/shared.env`; launch counts `webamend-slots` members and refuses past it | The host already has the count; no fleet file until a second host exists. |
| Connected values | `<WEBAGENT_STATE_DIR>/connect.env`, written by the app at Finish | The app owns the state dir; Compose owns `.env`. |
| Sign-in list | `.env` `ALLOWED_EMAILS` is operator-owned; the wizard adds `TEAM_EMAILS` in `connect.env`; sign-in checks the union | One owner per name; the operator's offboarding lever keeps working. |
| Landing's role | One static page relaying the Netlify fragment to the instance by slug | GitHub needs no relay: the manifest's `redirect_url` and `setup_url` point at the instance. |
| Setup link | Single-use, 24 hours, self-service resend to the seeded address | A 7-day reusable link that reveals the TOTP seed is a sign-in takeover. |

## 4. The flow, end to end

### 4.1 Once per host (operator, manual, documented)

1. **Netlify OAuth application** (app.netlify.com/user/applications).
   Redirect URI: `https://<WEBAMEND_LANDING>/connect/netlify`. Note the
   client ID; the secret is never used.
2. **DNS**: `*.<WEBAMEND_BASE_DOMAIN>` A (and AAAA) record to the host.
3. **`/etc/webamend/shared.env`**, root-owned, mode 0600, created by
   `bootstrap-host.sh` from a commented template, filled by hand:

   ```
   WEBAMEND_BASE_DOMAIN=webamend.com
   WEBAMEND_LANDING_URL=https://webamend.com
   NETLIFY_OAUTH_CLIENT_ID=
   SMTP_URL=
   SMTP_FROM=
   MAX_CLIENTS=8
   ```

   `provision-client.sh` copies `WEBAMEND_LANDING_URL`,
   `NETLIFY_OAUTH_CLIENT_ID`, `SMTP_URL`, `SMTP_FROM` into each client's
   `.env` and derives the hostname from `WEBAMEND_BASE_DOMAIN`. Nothing in
   this file is a secret except the SMTP password, which is already there
   today.

No GitHub registration. Each customer's App is created in step 1 of the
wizard.

### 4.2 Purchase and the onboarding form

Customer pays. Dodo `subscription.active` → the existing operator email,
which now says: *wait for the onboarding-form email; if it does not arrive
in a day, launch with the billing address below.*

`/thanks` collects three things: **contact email** (the person who will run
the wizard), **site name** (one per site; the operator derives the slug,
`[a-z][a-z0-9-]{1,30}`), and notes. Instances live on the apex wildcard
(`<slug>.webamend.com`), so `provision-client.sh` refuses a reserved list
of slugs that are or may become real subdomains: `www`, `mail`, `api`,
`app`, `admin`, `blog`, `docs`, `help`, `status`, `support`, `edit`,
`setup`, `login`. Explicit DNS records always beat the wildcard, so a
reserved name is a naming rule, not a routing risk. The repository, Netlify site and
sign-in list fields are removed; the wizard collects those from the source
of truth. The form's email to the operator ends with the launch command
ready to paste:

```
ops/launch-client.sh acme --email alice@acme.example
```

### 4.3 Provision (operator, one command, no pause)

```
ops/launch-client.sh <slug> --email <contact email> [--port N]
```

1. Refuse if `webamend-slots` already has `MAX_CLIENTS` members, if the slug
   exists, or if `shared.env` is missing a name.
2. `provision-client.sh` as today, with a **new `.env` template**:

   ```
   # provisioning-owned
   WEBAMEND_SLUG=<slug>
   PUBLIC_BASE_URL=https://<slug>.<base>
   WEBAGENT_STATE_DIR=/srv/webamend/<slug>/state
   DOCKER_SOCK=/run/user/<uid>/docker.sock
   SLOT_BROKER_SOCKET=/run/webamend/slotd.sock
   PORT_HOST=<port>
   APP_IMAGE=…   AGENT_IMAGE=…
   # copied from shared.env
   WEBAMEND_LANDING_URL=…  NETLIFY_OAUTH_CLIENT_ID=…  SMTP_URL=…  SMTP_FROM=…
   # operator-owned sign-in list, seeded with the contact address
   ALLOWED_EMAILS=<contact email>
   # gen:secrets
   SESSION_SECRET=…  NETLIFY_WEBHOOK_SECRET=…  TOTP_SECRET=…
   ```

   **No blank `NAME=` lines.** The seven connect names (§5.1) are absent,
   not empty: Compose passes an empty value through as a set, empty
   variable. `gen:secrets` runs inside `provision-client.sh` so the file is
   complete when it returns.
3. `check:env --bootstrap` (names only) confirms the file parses as a
   bootstrap env.
4. `release.sh --client <slug>`. The app starts in **setup mode** (§5.2).
   `release.sh`'s readiness wait treats `SETUP_PENDING` as success (§5.6),
   so a fresh client is not rolled back.
5. Caddy block appended and reloaded. The wildcard record already resolves,
   so the DNS check passes first time and the certificate issues at once.
   The block gains a log filter that drops the `t` and `code` query
   parameters (§7).
6. `wait_for_https`, then **the invitation**: `setup:link --send` in the
   throwaway node container mints a single-use link and emails it to
   `ALLOWED_EMAILS[0]` from `SMTP_FROM`, and prints the link for the
   operator as a fallback. The email is sent only now, after TLS works.

The operator's involvement ends here. The enrollment link is no longer a
separate step; the authenticator QR is inside the wizard.

### 4.4 Setup wizard (customer, on `https://<slug>.<base>/setup`)

**Entry.** The link is `https://<slug>.<base>/setup/enter?t=<token>`. The
route handler verifies the token, marks it consumed, sets the setup cookie
and redirects to `/setup`. Expired or already used → a page with one
button, *Email me a new link*, which sends a fresh link to the seeded
address (no input, rate-limited) and says which inbox to check. If the
installation was already enrolled once (§4.5 reconnect), the page asks for
a current six-digit code before unlocking.

**Pre-flight panel** at the top, always visible: *You will need: a GitHub
account with the site's repository; a Netlify account with the site; an
OpenRouter account with a payment method. About fifteen minutes. Every
connect step names the installation you are connecting to:* **`<slug>`,
bought by `<contact email>`.** That sentence is the phishing defence
(§7).

Steps 1–4 can be done in any order; 5 needs 1 and 4; 7 needs all. The page
shows a step list with done/pending marks and one active step.

| Step | Collects | Verified by |
|---|---|---|
| 1 GitHub | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_REPO` | own-App JWT: `GET /app/installations/{id}`, `GET /installation/repositories` |
| 2 Netlify | `NETLIFY_TOKEN`, `NETLIFY_SITE_ID` | `GET /user`, `GET /sites/{id}`; `repo_url` compared with step 1 |
| 3 OpenRouter | `OPENROUTER_API_KEY` | `GET /auth/key` 200; `limit` null → warning |
| 4 Team | `TEAM_EMAILS`, `alertContact` | syntax |
| 5 Repository file | `.webagent/config.yml` present and valid | `parseSettings` on the file read back |
| 6 Authenticator | nothing; shows the TOTP QR once | one valid code |
| 7 Finish | — | `validateStartup` with the collected values, then write + restart |

**Step 1, GitHub — three clicks.**

*1a Create your app.* The page asks *Is the repository under your personal
account or an organization?* (org name field). It renders a form that
POSTs a `manifest` to `https://github.com/settings/apps/new?state=<state>`
or `https://github.com/organizations/<org>/settings/apps/new?state=<state>`:

```json
{
  "name": "webamend-<slug>",
  "url": "<PUBLIC_BASE_URL>",
  "redirect_url": "<PUBLIC_BASE_URL>/setup/github/created",
  "setup_url": "<PUBLIC_BASE_URL>/setup/github/installed",
  "setup_on_update": true,
  "public": false,
  "hook_attributes": { "active": false },
  "default_permissions": { "contents": "write", "pull_requests": "write", "metadata": "read" }
}
```

GitHub shows the customer the app and its permissions; they press *Create
GitHub App*. GitHub redirects to `redirect_url?code=…&state=…`. The
handler verifies `state` (§5.5), calls
`POST https://api.github.com/app-manifests/{code}/conversions` (no auth;
the code lives one hour), and stores `id`, `slug`, `pem` and `owner.login`
in the draft. The `client_secret` and `webhook_secret` in the response are
discarded; nothing uses them. A `422` because the name exists (a redo) →
retry once with `webamend-<slug>-<4 random chars>`.

*1b Install it.* Button to `https://github.com/apps/<app slug>/installations/new`.
The App is private, so GitHub offers only the creating account; the
customer picks *Only select repositories* and the site repo. GitHub
redirects to `setup_url?installation_id=…&setup_action=install|update`
(`setup_on_update` makes a redo come back here too). The handler mints a
JWT with the App's own key and calls `GET /app/installations/{id}`: a
private App can only see its own installations, so a spoofed id is refused
here without any user token. Then `GET /installation/repositories` with an
installation token.

*1c Confirm.* One repository → pre-selected; several → pick. Always a
confirmation card: *Connected as `<owner>` · `<owner/repo>`* with *Not
this? Install elsewhere*. Confirm stores the four GitHub names in the
draft. The repo read-back (`getDefaultBranch`) is the write-access check:
installing an App on a repository requires admin rights on it.

**Step 2, Netlify.** Button links to
`https://app.netlify.com/authorize?client_id=<NETLIFY_OAUTH_CLIENT_ID>&response_type=token&redirect_uri=<WEBAMEND_LANDING_URL>/connect/netlify&state=<state>`.
Netlify redirects to the landing with `#access_token=…&state=…`. The
landing page's script (§6) checks the state's slug label and does
`location.replace('https://<slug>.<base>/setup/netlify/callback#access_token=…&state=…')`.
The instance's callback page script reads the fragment, clears it with
`history.replaceState`, and POSTs `{accessToken, state}` to
`/setup/api/netlify/token`. The handler verifies `state` and nonce, calls
`GET /api/v1/user` (email to display) and `GET /api/v1/sites` (`id`,
`name`, `ssl_url`, `build_settings.repo_url`), and stores the pending list.
The customer picks (a site whose `repo_url` matches step 1 is
pre-selected; a mismatch is a warning, not a block), then a confirmation
card *Connected as `<netlify email>` · `<site name>`*.

**Deploy Previews**: read the site; if `build_settings.skip_prs` is `true`,
`PATCH /sites/{id}` with `{build_settings:{skip_prs:false}}` and read back.
If the field is absent (it is not in Netlify's published OpenAPI document)
or still `true`, show the manual instruction (Site configuration → Build &
deploy → Deploy Previews → *Any pull request*) with a checkbox. Finish
re-reads the field when it exists. Independently of the wizard, the
preview wait in the job runner gets a timeout whose message names Deploy
Previews and that path, so a wrong setting fails loudly once instead of
silently forever.

The page says: *this token acts as your Netlify user across every site in
your account and does not expire until you revoke it at
app.netlify.com/user/applications; use a separate team if that matters.*

No outgoing webhook is registered: the orchestrator polls the deploy list;
the webhook route is an accelerator and stays optional.

**Step 3, OpenRouter.** Paste field. `GET https://openrouter.ai/api/v1/auth/key`
with the key. Non-200 → *that key was refused*, nothing stored. 200 →
stored; `data.limit === null` → *no spending limit is set on this key*
with a link to openrouter.ai/settings/keys and a checkbox to continue. The
key is echoed back only as its last four characters.

**Step 4, Team.** `TEAM_EMAILS`: additional sign-in addresses (the seeded
contact address is shown, greyed, as *always allowed; the operator manages
it*). `alertContact`, pre-filled with the contact address, goes into
`config.yml` in step 5. The page says plainly that **everyone on this list
signs in with the same authenticator key from step 6**, and that the
operator can send an enrolment link to a colleague later.

**Step 5, Repository file.** With the installation token, read
`.webagent/config.yml` on the default branch.

- Present → run `parseSettings` (strict schema). Valid → show it, done.
  Invalid → show the exact message with two buttons: *I fixed it, check
  again* and *Replace it with Webamend's default*.
- Absent → show the file that will be written and one button whose label
  says what happens: *Add this file to `<default branch>` — your host will
  run one build; the site does not change.* Content:

  ```yaml
  alertContact: <alertContact>
  costCeilingUsd: 2
  model: openrouter/anthropic/claude-sonnet-5
  maxRequestMinutes: 10
  ```

  Written through the Contents API (`PUT /repos/{owner}/{repo}/contents/.webagent/config.yml`,
  message `add Webamend configuration`). If the write is refused (branch
  protection), show the file contents with *add this file to your
  repository, then press Check again*. No pull-request path.

`policy.yml` and `AGENTS.md` are not written: a missing policy means the
defaults, and an example `AGENTS.md` about a fictional studio does not
belong in a customer's repository. The Done page and `NEW-CLIENT.md` point
at both for later.

**Step 6, Authenticator.** The QR from `otpauthUri` and the raw secret,
exactly what `/login/enroll` shows today, then a six-digit code field
verified with `verifyTotpCode`. One valid code completes the step and
writes `<stateDir>/totp-enrolled` (an ISO timestamp; **outside**
`setup/`, so it survives Finish). The seed is shown only while that marker
is absent; a reconnect never shows it again — a colleague who needs it gets
an operator-minted `enroll:link`, as today.

**Step 7, Finish.** Enabled when every step is done. The handler builds a
full `Env` in memory (`parseEnv({...process.env, ...draftAsEnvNames})`) and
runs `validateStartup` with real clients (`checkInstallation`,
`checkRepository`, `checkHostingSite`, `checkTotpSecret`). Faults are shown
against the step that owns them. When it passes:

1. write `<stateDir>/connect.env` atomically (temp file in the same
   directory, mode 0600, rename);
2. delete `<stateDir>/setup/`;
3. respond; then, in `after()` from `next/server` (runs once the response
   has been sent), `process.exit(0)`. Compose's `restart: unless-stopped`
   restarts regardless of exit code; the instrumentation hook merges
   `connect.env`, validation passes, normal mode.

The page polls `/api/health` then `/api/ready`. On `ready`: *Done*, a link
to `/login`, how sign-in works (email link, then the code), and *try a
small change first — shorten a headline*. After two minutes without
`ready`: *setup finished but the editor did not come up; the operator has
been told*, and the app logs `setup.finish_not_ready` for the probe.

### 4.5 After

- `ops/status.sh` shows `setup-pending` in READY, and with `<slug>` prints
  the non-secret progress from `/api/ready` (§5.6): which steps are done,
  the last error's step and code. That is the operator's first look when a
  customer says "it does not work".
- `ops/setup-link.sh <slug> [--send]` mints a fresh single-use link
  (prints it, or emails it to `ALLOWED_EMAILS[0]`).
- `ops/reconnect.sh <slug> <github|netlify|openrouter|team>` (root, bash):
  removes that provider's names from `connect.env` **and** from `.env`
  (the legacy client keeps everything in `.env`), restores owner and mode,
  restarts the app through the client's daemon
  (`run_as_client docker compose restart app`), and sends a new setup link.
  The app comes up in setup mode with the other providers reported done
  from `process.env`; step 6 is skipped because `totp-enrolled` exists;
  entry requires a current code.
- `ops/team.sh <slug> remove <address>` edits `TEAM_EMAILS` in
  `connect.env` the same way and restarts.
- `ops/enroll-link.sh <slug>` stays: the way a second person gets the key.
- Backups: `/srv/webamend/<slug>/.env` and `/srv/webamend/<slug>/state/connect.env`.

## 5. Product changes (`website-ai-auto-builder`)

### 5.1 Environment: bootstrap vs complete

`src/lib/config/env.ts`:

- `CONNECT_NAMES = ['GITHUB_APP_ID','GITHUB_APP_PRIVATE_KEY','GITHUB_INSTALLATION_ID','GITHUB_REPO','NETLIFY_TOKEN','NETLIFY_SITE_ID','OPENROUTER_API_KEY'] as const`.
- `rawEnvSchema` gains **optional** `WEBAMEND_SLUG` (slug pattern),
  `WEBAMEND_LANDING_URL` (absolute URL), `NETLIFY_OAUTH_CLIENT_ID`,
  `TEAM_EMAILS` (CSV, same normalisation as `ALLOWED_EMAILS`). Optional so
  the existing client's `.env` boots unchanged. `toEnv` sets
  `allowedEmails` to the **union** of `ALLOWED_EMAILS` and `TEAM_EMAILS`,
  so `authorizeSession` and `issueMagicLinkToken` are untouched.
- `bootstrapEnvSchema = rawEnvSchema.omit(CONNECT_NAMES)` with
  `WEBAMEND_SLUG`, `WEBAMEND_LANDING_URL`, `NETLIFY_OAUTH_CLIENT_ID`
  required; `parseBootstrapEnv(raw): BootstrapEnv`.
- `resetEnvCache()` test seam beside `loadEnv()`.

`src/lib/config/dotenv-grammar.ts`: the line grammar from
`scripts/repo-env.ts` (bare or double-quoted multi-line values), shared by
`repo-env.ts`, `check-env.ts` and the connect file so they cannot drift.

`src/lib/config/connect-file.ts`: `readConnectFile(stateDir)` accepts only
`CONNECT_NAMES` plus `TEAM_EMAILS`; any other name is a startup fault
naming it. `writeConnectFile(stateDir, values)` is atomic and 0600.
`mergeConnectIntoProcessEnv()` sets `process.env[name]` for each accepted
name, **overriding** `.env` for those names only (this is how `reconnect`
of a legacy client works after `.env` is stripped).

`scripts/repo-env.ts` gains `loadBootstrapEnvFromFiles()`;
`scripts/check-env.ts` gains `--bootstrap` and `--connect FILE`
(`launch-client.sh` mounts `state/connect.env:ro` when it exists).

### 5.2 Setup mode

`src/lib/setup/mode.ts`: `decideMode(raw): {kind:'normal'} | {kind:'setup', missing: ConnectName[]}`
(pure; empty string counts as missing); the decision is published on
`globalThis[Symbol.for('webagent.mode')]` and read by `isSetupMode()`.

`src/instrumentation-node.ts`, new order: `mergeConnectIntoProcessEnv()`
→ `decideMode` → setup: `parseBootstrapEnv` (a fault here still exits 1
and names the setting — a broken bootstrap `.env` is an operator error),
`initLogRedaction`, remove nothing, `log.info('startup.setup_pending', {missing})`,
**no `assertStartupValid`**; normal: delete `<stateDir>/setup/` if it
exists (a leftover draft holds secrets), then exactly today's path.

Gating, explicit (no `middleware.ts` exists and none is added):

- `src/lib/setup/guard.ts` `requireSetup(request)`: mode check (404 when
  not in setup mode), cookie verify, `Origin === PUBLIC_BASE_URL` on
  non-GET. Called **first** in every `/setup/**` handler; the layout and
  page call the same function.
- `requireClient()` checks `isSetupMode()` **before** `getInstallation()`
  and answers `503 {error:'setup_pending'}`.
- `checkReadiness()` itself (not only the route) short-circuits in setup
  mode with the body in §5.6, so route, `status.sh` and `release.sh` see
  one contract.
- `src/app/(client)/layout.tsx`, `src/app/login/**` (including
  `login/enroll`, which calls `getInstallation()`), and every
  `src/app/api/auth/**` action: `isSetupMode()` first → redirect `/setup`
  or `503 setup_pending`.
- `src/app/api/webhooks/netlify/route.ts`: `200 {status:'ignored'}` first.
- `getInstallation()` is never called in setup mode. The wizard's own
  composition is `src/lib/setup/deps.ts`: bootstrap env, `createMailer`,
  `fetch`, the draft store.

### 5.3 Setup link, cookie, resend

`src/lib/setup/token.ts`, modelled on `src/lib/auth/enroll.ts` but with
durable single-use:

- Link token: subkey `'setup-link'`; payload `{kind:'link', iat, nonce}`;
  TTL **24 h**. `setupUrl(env)` = `${publicBaseUrl}/setup/enter?t=…`.
- `GET /setup/enter?t=` (`src/app/setup/enter/route.ts`): verify; refuse
  if `<stateDir>/setup/consumed/<nonce>` exists; create it; set cookie;
  302 `/setup`. If `<stateDir>/totp-enrolled` exists, the cookie is issued
  `locked: true` and `/setup` shows only the code prompt until
  `POST /setup/api/unlock` verifies a TOTP code.
- Cookie `webagent_setup`: subkey `'setup-cookie'`, payload
  `{kind:'cookie', iat, locked, nonces: string[]}` (the last two OAuth
  nonces, so a second tab does not break the first), TTL 24 h enforced by
  the verifier, `httpOnly`, `sameSite:'lax'`, `secure` from the base URL
  scheme, `path:'/setup'`. `lax` is what lets it ride on the top-level GET
  redirects back from GitHub.
- Resend: `POST /setup/api/resend`, no cookie required, allowed only in
  setup mode, 3 per hour per instance; mints a link and sends
  `setupInvitationEmail(link)` to `ALLOWED_EMAILS[0]` from `.env` — never
  to an address the wizard collected.
- `scripts/setup-link.ts` (`setup:link [--send]`) uses the bootstrap loader;
  `ops/setup-link.sh` wraps it.
- Rate limits, same `globalThis` pattern as sign-in: 20 entry attempts per
  address per 15 min; 10 POSTs per step per 15 min.

### 5.4 Draft and resumability

`<stateDir>/setup/draft.json`, mode 0600, atomic writes:

```ts
type Draft = {
  githubApp?:      { appId: number; appSlug: string; privateKey: string; owner: string };
  githubPending?:  { installationId: number; account: string; repos: string[] };
  github?:         { installationId: number; repo: string; account: string };
  netlifyPending?: { token: string; user: string; sites: { id: string; name: string; url: string; repoUrl?: string }[] };
  netlify?:        { token: string; siteId: string; siteName: string; siteUrl: string; previewsConfirmed: boolean };
  openrouter?:     { key: string; limitAcknowledged: boolean };
  team?:           { teamEmails: string[]; alertContact: string };
  repo?:           { configPresent: boolean; configValid: boolean };
  lastError?:      { step: string; code: string; at: string };
};
```

Callbacks are GET redirects and cannot ask questions: each verifies,
fetches candidates, writes the `*Pending` entry, and 302s to
`/setup?step=<p>`; on failure, 302 to `/setup?step=<p>&error=<code>` with
a retry button and `lastError` recorded. `github/select`, `netlify/select`
(POST) validate the choice **against the pending list** and finalise.

`GET /setup/api/status` returns the draft with secrets replaced by their
last four characters, plus which names are already present in
`process.env` (after a reconnect, the other providers are done). The draft
is the same trust boundary as `connect.env` and is deleted at Finish and on
any normal-mode boot. Only Finish writes `connect.env`; its existence
means setup is complete.

### 5.5 OAuth `state`

`src/lib/setup/state.ts`. Value: `<slug>.<base64url({provider, nonce, exp})>.<hexHMAC>`,
subkey `'setup-state'`, `slug` from `env.webamendSlug` (never derived from
the hostname), `exp` **60 minutes** (a customer may create or 2FA an
account mid-redirect). `github/start` and `netlify/start` mint it and
re-issue the cookie with the nonce pushed onto `nonces` (keep two). The
callback requires signature, unexpired, provider match, nonce ∈ cookie,
and `request host === PUBLIC_BASE_URL host`. `state` is used by
`github/created` and `netlify/token`; `github/installed` carries none and
is verified by the App JWT lookup instead (§4.4 step 1b), the setup cookie
being its only browser binding.

### 5.6 Readiness contract

Setup mode: `503 {status:'degraded', faults:['SETUP_PENDING'], setup:{done:['github','team'], lastError?:{step,code,at}}, checkedAt, ageMs}`.

- `ops/release.sh wait_for_ready`: capture `%{http_code}` separately;
  success is `200` with `"status":"ready"` **or** `503` whose body contains
  `"SETUP_PENDING"`; `404` by status code only (fixes the current glob
  that matches `404` inside timestamps).
- `ops/status.sh`: READY prints `setup-pending`; `--prom` emits
  `webamend_client_setup_pending{client} 1` and **omits** `ready_ok` for
  that client (otherwise alerts M2 and A13 page the operator for the whole
  setup). `--json` carries `setup`. `ops/monitoring/grafana/alert-rules.md`
  and the dashboard get the new series.

### 5.7 New provider code

All take `fetch` as a dependency; unit tests use fixtures.

- `src/lib/github/manifest.ts`: `manifestFor(env, slug)`, `convertManifestCode(code)`.
  `src/lib/github/app.ts`: `getInstallation(appId, privateKey, id)`;
  `signAppJwt` becomes exported. `createTokenMinter({appId, privateKey, installationId})`
  and `createRepoClient({owner, repo, minter})` take narrowed inputs (the
  `Env`-taking signatures stay as thin wrappers). `RepoClient` gains
  `putFile(path, content, message, branch)`.
- `src/lib/netlify/oauth.ts`: `authorizeUrl(env, state)`.
  `src/lib/netlify/account.ts`: `getUser(token)`, `listSites(token)`,
  `getSiteRaw(token, id)`, `setDeployPreviews(token, id)`.
- `src/lib/openrouter/key.ts`: `inspectKey(key)`.
- `src/lib/setup/starter-config.ts`: `renderStarterConfig({alertContact})`.
- `src/lib/log/redact.ts`: additive `registerRedactedValue(value)`; every
  handler registers a received code, token or key before its first log
  line.
- `src/lib/notify/setup.ts`: `setupInvitationEmail(link)` (English).
- Job runner: the preview wait's timeout message names Deploy Previews.

### 5.8 Routes and UI

- `src/app/setup/layout.tsx` (mode gate), `src/app/setup/page.tsx` (client
  component; reads `/setup/api/status`; renders `LanguageSwitcher` like
  `/login` does, since it sits outside `(client)/layout.tsx`),
  `src/app/setup/enter/route.ts`, `src/app/setup/github/created/route.ts`,
  `src/app/setup/github/installed/route.ts`,
  `src/app/setup/netlify/callback/page.tsx` (fragment reader),
  `src/app/setup/api/[...route]/route.ts` with `status`, `unlock`,
  `resend`, `github/start` (POST → HTML form auto-submit with the
  manifest), `github/select`, `netlify/start`, `netlify/token`,
  `netlify/select`, `netlify/confirm-previews`, `openrouter`, `team`,
  `repo`, `totp`, `finish`.
- Plain CSS in `src/components/setup.css` on `globals.css` tokens; strings
  through `src/lib/i18n/*`, four locales in the same change.
- `/setup/**` responses carry `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`.
- Errors: customer sees a short sentence; `log.error('setup.step_failed', {step, cause})`
  carries the cause; secrets never in either.

### 5.9 Ops scripts

- `ops/bootstrap-host.sh`: writes `/etc/webamend/shared.env` template
  (0600) if absent.
- `ops/provision-client.sh`: `--shared FILE` (default
  `/etc/webamend/shared.env`), `--email ADDR`, hostname derived; new
  template; runs `gen:secrets`; epilogue rewritten.
- `ops/launch-client.sh`: `<slug> --email ADDR [--port N]`; capacity
  check; no editor pause (`--values` stays as the escape hatch for one
  release); `check:env --bootstrap`; DNS wait unchanged; proxy and HTTPS
  wait **before** sending the invitation; prints the link.
- `ops/release.sh`, `ops/status.sh`, `ops/probe.sh`, alert rules: §5.6.
- New: `ops/setup-link.sh`, `ops/reconnect.sh`, `ops/team.sh` (all bash as
  root for the file edits, node container only for minting/sending).
- Caddy block template: `log { format filter { request>uri query { delete t  delete code } } }`.

### 5.10 Docs

`docs/NEW-CLIENT.md` and `docs/QUICKSTART.md` rewritten around the wizard,
keeping: the third-party `<script src>` warning (`forbidExternalCode`),
"count files before raising `maxFilesChanged`", the `frame-ancestors`
note, and the "prove it works" loop under *when the first request is
blocked*. `.env.example` corrected (drop `CONFIG_PASSWORD_HASH`,
`CONFIG_TOTP_SECRET`, `PORT`; mark which names are shared, which the
wizard writes). `README.md` gains "How a client is connected".
`ops/README.md` for the new scripts.

## 6. Landing changes

- `src/app/connect/netlify/page.tsx`: a static page with an inline script.
  Reads `location.hash`; requires `access_token` and a `state` whose first
  label matches `^[a-z][a-z0-9-]{1,30}$` and whose shape matches
  `^[a-z][a-z0-9-]{1,30}\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$`; then
  `location.replace('https://' + slug + '.' + BASE_DOMAIN + '/setup/netlify/callback' + location.hash)`.
  Anything else → a plain sentence. The host is slug plus a build-time
  constant; nothing from the URL chooses it. The page sends
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store` and has no
  analytics script.
- `src/lib/site.ts` gains `INSTANCE_BASE_DOMAIN` (same value as the host's
  `WEBAMEND_BASE_DOMAIN`).
- `/thanks` and `src/lib/onboarding.ts`: `contactEmail`, `siteName`,
  `notes`; notice includes the launch command with `--email <contactEmail>`.
- `src/lib/webhook-notices.ts`: the `subscription.active` notice tells the
  operator to wait for the form email and gives the billing address as the
  fallback.
- No GitHub route on the landing.
- Tests: `tests/connect.test.ts` (state parsing and target host),
  `tests/onboarding.test.ts`, `tests/webhook-notices.test.ts` updated.

## 7. Security notes

- **No cross-tenant secret.** Each instance holds only its own App's key.
  `shared.env` carries one public client ID and the SMTP URL (already the
  case). A compromised instance reaches its own customer's repository and
  Netlify account, nothing else.
- **Spoofed `installation_id`**: refused by `GET /app/installations/{id}`
  with the instance's own App JWT; a private App sees only its own
  installations.
- **Link forwarding / phishing** (a tenant forwards their setup link so a
  victim connects the victim's accounts): every connect step names the
  installation and the buyer; the link is single-use and 24 h; the resend
  goes only to the operator-seeded address. Strict identity binding
  (connected account email must equal the buyer) was considered and
  rejected because agencies connect on behalf of clients.
- **Callback binding**: HMAC state, 60 min, provider-tagged, nonce must be
  in the cookie of the browser that started the flow, host must be the
  instance's own.
- **Bearer material in URLs**: the GitHub manifest `code` (one hour,
  single-use) is the only server-visible secret in a URL; it is exchanged
  immediately, Caddy drops `t` and `code` from access logs,
  `Referrer-Policy: no-referrer` on `/setup/**`. The Netlify token travels
  only in fragments. The setup token is single-use.
- **TOTP seed**: shown once, never behind a link again; reconnect requires
  a current code.
- **Secrets at rest**: `draft.json` and `connect.env` are 0600 in the
  state dir, owned by the client's host user (the container's root under
  rootless Docker). Drafts are deleted at Finish and on any normal boot.
- **CSRF**: `lax` cookie plus `Origin` check on every non-GET.
- **Logs**: received codes, tokens and keys registered for redaction
  before the first log line; `status` exposes last four characters only.
- **Accepted for v1**: per-host certificates publish `<slug>.<base>` names
  to Certificate Transparency (customer slugs are visible); a wildcard
  certificate needs a Caddy DNS-plugin build and is deferred.

## 8. Testing

- Unit: `decideMode`; connect file grammar, accept-list, atomic write;
  link token single-use and cookie subkey separation; state sign/verify
  (expiry, provider, nonce, host); manifest render and conversion parsing;
  `getInstallation` refusal for a foreign id; Netlify site listing,
  `skip_prs` absent → manual path; OpenRouter `limit: null`; starter
  config; `parseSettings` on an invalid existing file; landing state
  parsing.
- Integration: boot with a bootstrap env → setup mode, `/api/ready`
  carries `SETUP_PENDING` and `setup.done`, `(client)` routes redirect,
  `/api/conversations` and `/api/auth/request` answer 503; walk the wizard
  end to end with fake GitHub/Netlify/OpenRouter servers and assert the
  written `connect.env`; Finish refuses when `validateStartup` reports a
  fault and writes nothing; normal boot removes a leftover draft; a
  consumed link is refused; a locked cookie needs a code.
- Ops: `launch-client.sh` on the staging host with a throwaway slug;
  `release.sh` on a setup-mode client must not roll back; `status.sh --prom`
  must not emit `ready_ok 0` for it; `reconnect.sh` on a copy of the legacy
  client's `.env`.
- `npm run lint && npm run typecheck && npm test && npm run test:int` stay green.

## 9. Rollout

1. Land the product change: an instance whose `.env` has all seven
   connect names boots exactly as before (`decideMode` → normal).
2. Register the Netlify OAuth application, write `/etc/webamend/shared.env`,
   add the wildcard record, deploy the landing with `INSTANCE_BASE_DOMAIN`.
3. The existing client needs no migration; add `WEBAMEND_SLUG`,
   `WEBAMEND_LANDING_URL`, `NETLIFY_OAUTH_CLIENT_ID` to its `.env` only if
   `reconnect` is ever needed for it.
4. Next customer goes through the wizard. Keep `--values` on
   `launch-client.sh` for one release.
