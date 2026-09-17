# Contract: Durable Request Record

One pull request comment per finished request. Prose for people, structured block for the
dashboard. This is the entire history mechanism — the product keeps none of its own.

## Format

```markdown
I made the headline shorter and changed the button to dark blue.

Changed the homepage hero and the shared button styles. Your preview is ready.

<!-- webagent:v1
{
  "requestId": "r_01J...",
  "startedAt": "2026-09-02T10:31:02Z",
  "finishedAt": "2026-09-02T10:34:19Z",
  "outcome": "succeeded",
  "stages": [
    {"stage": "running", "at": "2026-09-02T10:31:04Z"},
    {"stage": "gating",  "at": "2026-09-02T10:33:40Z"},
    {"stage": "pushing", "at": "2026-09-02T10:33:44Z"},
    {"stage": "building","at": "2026-09-02T10:33:51Z"},
    {"stage": "succeeded","at": "2026-09-02T10:34:19Z"}
  ],
  "commitSha": "a1b2c3d",
  "filesChanged": 3,
  "diffLines": 47,
  "model": "anthropic/claude-sonnet-latest",
  "tokensIn": 48211,
  "tokensOut": 3140,
  "costUsd": 0.42,
  "previewUrl": "https://deploy-preview-42--client.netlify.app",
  "notified": ["preview_ready"]
}
-->
```

## Rules

- **Exactly one block per comment**, opened by `<!-- webagent:v1` and closed by `-->`. A comment
  without one is a human comment and is rendered as prose.
- **The prose is the client-facing message.** It is written first and must stand alone; a reader
  who never sees the block loses nothing. No paths, no diffs, no build logs (Principle I).
- **Parsing is total.** An unparseable block degrades to prose rather than breaking history.
- **Rendering and parsing are inverses**, property-tested as such.
- **`outcome`** is one of `succeeded`, `blocked`, `failed`, `abandoned`. `blocked` carries
  `violation` and `blockedPath`. `failed` carries `errorCode` and a short `errorDetail`.
  `abandoned` is written when a stale lock is broken, by the process that breaks it.
- **`wipSaved`** is `true` on a `failed` record whose run was interrupted and whose edits were kept
  for the conversation's next request (contracts/repo-files.md). Absent otherwise; never `false`.
- **`notified`** lists events already emailed, which is how notification stays idempotent without
  a delivery record (OD-004): before sending, read the record; if the event is listed, skip.
- **Versioning**: the marker carries `v1`. A future shape uses a new marker; readers ignore
  markers they do not recognise, so old conversations stay readable.
