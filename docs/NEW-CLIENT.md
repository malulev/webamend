# New client checklist

Copy this into the ticket for the client and tick it off. Replace `acme`, `edit.acme.example`
and `3001` with the client's slug, hostname and a port no other client on the box uses.

## Accounts and access

- [ ] Client's site repo on GitHub, linked to a Netlify site.
- [ ] Netlify: Site configuration → Build & deploy → **Deploy Previews** on for pull requests.
- [ ] GitHub App installed on **this repo only**. Contents + Pull requests, read and write. Webhook off.
      Note the App ID, download the `.pem`, note the installation ID from the URL after installing.
- [ ] Netlify personal access token and the site ID. Own Netlify team if the token must not reach other sites.
- [ ] OpenRouter API key with a spending limit set.
- [ ] SMTP credentials and a from address.
- [ ] List of client email addresses allowed to sign in.

## In the client's repo

- [ ] `.webagent/config.yml` with `alertContact`, `costCeilingUsd`, `model`, `maxRequestMinutes`.
- [ ] `.webagent/policy.yml`. Count the files one normal request touches (header, footer on every
      page, sitemap, stylesheet) before setting `maxFilesChanged`.
- [ ] `AGENTS.md` at the repo root, from `docs/AGENTS.example.md`.
- [ ] If pages carry a third-party `<script src>` in `<head>`, move it behind a same-origin loader
      or new pages will be refused by `forbidExternalCode`.
- [ ] The preview pane frames deploy previews, so the site must allow `https://edit.<client>` in
      `Content-Security-Policy: frame-ancestors` and must not send `X-Frame-Options` (it cannot
      name a second origin). Otherwise the pane shows "refused to connect".

## On the VPS

One command does this whole section, pausing for the `.env` edit and waiting for DNS, and ends by
printing the client's enrollment link:

```bash
ops/launch-client.sh acme edit.acme.example        # picks the next free port
```

Create the DNS record before or while it runs. If it stops, fix what it names and re-run; it
resumes. The manual steps, for reference or for doing one by hand:

- [ ] `ops/provision-client.sh acme edit.acme.example 3001`
- [ ] `sudoedit /srv/webamend/acme/.env`: GitHub App, Netlify, OpenRouter, SMTP, `ALLOWED_EMAILS`,
      `PUBLIC_BASE_URL=https://edit.acme.example`.
- [ ] Run `gen:secrets` as the client user (the provision script prints the command; no password). Never `PORT`, only `PORT_HOST`.
- [ ] Run `check:env` the same way. It names missing variables and prints no values.
- [ ] DNS: A record (and AAAA if applicable) for `edit.acme.example` pointing at the VPS public IP. Wait until it resolves.
- [ ] `ops/release.sh --client acme`
- [ ] Add the Caddy block for `edit.acme.example` → `127.0.0.1:3001` and `systemctl reload caddy`.
- [ ] `ops/status.sh acme` shows daemon up, container up, HTTP answering.
- [ ] Mint the enrollment link (`enroll:link` in the node container) and send it to the client. It works 24 hours.

## Prove it works

- [ ] Open the enrollment link, scan the QR into an authenticator app.
- [ ] Open `https://edit.acme.example`, request a sign-in link with an allowed address, receive the email, enter the code.
- [ ] Send a small change ("shorten the hero headline"). Preview appears within a few minutes.
- [ ] Press Publish. Live site updates. Press Undo. Live site reverts.
- [ ] Ask for a change the policy forbids. It is refused as blocked, not applied.

## Hand over

- [ ] Client has the URL and knows sign-in is the email link plus their authenticator code, no password.
- [ ] `alertContact` is an inbox someone reads.
- [ ] Backed up: the client's `.env`. Nothing else needs backing up.
