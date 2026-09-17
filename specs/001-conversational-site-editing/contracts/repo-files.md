# Contract: Repository Files

The installation reads these from the site's own repository. They are the developer-facing
contract; changing their shape breaks installations.

## `.webagent/config.yml`

```yaml
alertContact: dev@agency.example
costCeilingUsd: 2.00
model: openrouter/anthropic/claude-sonnet-5
maxRequestMinutes: 10
# optional
models:
  free: openrouter/cohere/north-mini-code:free
  high: openrouter/anthropic/claude-opus-5
uploadDir: public/uploads
```

The first four fields are required. Unknown fields are rejected rather than ignored, so a typo
fails loudly instead of being silently ignored — inside `models:` too, where the only keys are
the five tiers `free`, `low`, `medium`, `high`, `extra`.

`model` runs when a request names no tier. `models` re-points any tier away from its built-in
model (src/lib/models.ts holds the defaults); every value is `provider/model`. `uploadDir` is
where a client's attached files are written, relative to the repository root and never escaping
it; default `public/uploads`. Attachments are ordinary files to the policy and the commit.

**Permitted sign-ins are not here.** They are deployment configuration (`ALLOWED_EMAILS`), so
that write access to the site's repository cannot grant access to the editing interface
(FR-003c1). The schema rejects an `allowedEmails` key outright rather than ignoring it, so a
developer who puts it here is told, not quietly disregarded.

**On invalid content**: the previous valid settings stay in force, the fault is reported to the
last known `alertContact`, and the interface shows a configuration warning to configuration
holders only. Access control never falls back to permissive.

## `.webagent/policy.yml`

```yaml
allow:
  - "src/components/**"
  - "src/content/**"
  - "public/images/**"
deny:
  - "src/lib/payments/**"
maxFilesChanged: 15
maxDiffLines: 800
forbidNewDependencies: true
forbidExternalCode: true
```

All fields optional; defaults in [../data-model.md](../data-model.md).

**Evaluation order**, and the order matters:

0. Path shape and symbolic links. A path that is not plainly repository-relative, or that is a
   symbolic link in the working tree, is refused before any glob is read (`protected_path`,
   `symlink`). A link named like an allowed file publishes whatever it points at.
1. Unconditional denies — `.webagent/**`, `AGENTS.md`, `**/.env*`, `.github/**`; everything the
   hosting runs or is told to run (`netlify.toml`, `netlify/**`, `_redirects`, `_headers`,
   `vercel.json`, `api/**`, `functions/**`, `wrangler.toml`); build-time configuration
   (`*.config.js|ts`, `tsconfig*.json`, `.npmrc`, `.husky/**`, `Dockerfile`, `*.sh`); git's own
   configuration (`.gitmodules`, `.gitattributes`); dependency manifests and lockfiles. A site
   cannot allow these.
2. Site `deny`.
3. Site `allow`. A path matching nothing in `allow` is denied — except a file the host itself
   placed for the client as an attachment (see `uploadDir`), while it is still byte-for-byte what
   the client sent. An attachment the agent rewrote, removed or replaced is the agent's change and
   is judged like any other. Attachments are still subject to rules 0–2 and 4–6.
4. Size limits: `maxFilesChanged`, `maxDiffLines`.
5. `forbidNewDependencies`: any change to a manifest or lockfile — already denied by rule 1, so
   this exists to catch vendored dependency directories.
6. `forbidExternalCode` (default on): the text a change *adds* to a page (`.html`, `.svg`, `.md`,
   component templates) may not load or run anything from another origin — no off-site
   `<script src>`, no `<iframe>`/`<object>`/`<embed>`, no `<meta http-equiv="refresh">`, no
   `<base>`, no `javascript:` URL. Stylesheets, images and ordinary links are untouched; a site
   that wants an embedded map or an analytics tag sets `forbidExternalCode: false`.

**Result**: `{ ok: true }` or `{ ok: false, violation, path?, actual?, limit? }`. The violation
must name the offending path so the client-facing message can say which area is protected.

The agent is told the `allow` globs in its prompt (advisory: it saves a run that would be refused
anyway), and an attached SVG is refused at upload if it contains scripting, event handlers,
`javascript:` URLs, `<foreignObject>`, off-site references or entity declarations.

## `AGENTS.md`

Free-text guidance at the repository root, read by the agent as instructions. Brand rules, tone,
component conventions. **Advisory only** — it never widens what the gate permits, and the agent
may not edit it.

---

# Contract: Agent Container

## Inputs

| Channel | Contents |
|---|---|
| Mount `/work` | Working tree at the conversation's branch. **No git remote configured.** |
| Mount `/control` | Separate from the repository tree. Holds `prompt.json`: `{ request, history[], guidance, targetHint? }` |
| Environment | `OPENROUTER_API_KEY`, `MODEL` |

The container receives no GitHub token, no Netlify token, and no git remote.

Control files live at `/control`, never inside `/work`, so they cannot become part of a change
to the client's site no matter what the agent does with the working tree.

## Behaviour

Runs `opencode run --model "$MODEL" --format json --auto "<prompt>"`, **edits files in `/work`
and nothing else**, exits 0. Exits non-zero on failure. Killed at `maxRequestMinutes`.

**The container does not run git.** It does not commit, does not branch, and need not have git
installed. Committing is the host's job, after the gate has passed.

## Outputs

| Channel | Contents |
|---|---|
| stdout | OpenCode JSON events, one per line — streamed as progress |
| `/work` | Modified, added, and deleted files — the uncommitted change set |
| `/control/result.json` | `{ summary, filesChanged[], tokensIn, tokensOut, costUsd }` |

The host derives the change set from the working tree's status, which includes untracked
additions and deletions, gates it, and only then stages the permitted paths and commits with an
author and message it controls.

## Non-negotiable properties

- No credential capable of writing to the repository or hosting (FR-015).
- No git remote, and no commit authored inside the container. A blocked change is discarded by
  deleting the working tree, because no commit was ever made.
- Outbound network restricted to the model provider where the environment permits; the absence
  of credentials is the enforced boundary, network restriction is defence in depth.
- Destroyed after every request, successful or not.
- One exception to "nothing survives a failed request": a run interrupted by the model provider
  (`model_credit`, `model_quota`, `model_unavailable`) or by the clock (`agent_timeout`) has its
  edits kept by the **host**, after they pass the policy gate, as a host-authored commit on
  `refs/webagent/wip/c-<conversation>`. That ref is outside `refs/heads`, so nothing builds or
  previews it. The conversation's next request starts with those edits laid over its tree,
  uncommitted, so the gate judges the whole change again before anything is published. The ref is
  removed once a tree containing it has been judged. The container still never commits, and a
  change the gate refuses is still discarded (`src/lib/jobs/wip.ts`).
