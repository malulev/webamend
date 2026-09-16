# Quickstart

The short version. The [README](../README.md) explains why each step exists; this page only says
what to type. To onboard a client on an existing host, use the
[new client checklist](NEW-CLIENT.md) instead.

## You need

- A GitHub repo for the site, linked to a Netlify site with **Deploy Previews** on for pull requests.
- A GitHub App installed on that one repo. Permissions: Contents and Pull requests, read and write.
  Webhook off. Note the App ID, the private key `.pem`, and the installation ID.
- A Netlify personal access token and the site ID.
- An OpenRouter API key with a spending limit.
- SMTP credentials (resend for example)
- Docker with Compose v2.17+, Node 22+.

## In the client's repo

```
.webagent/config.yml   required
.webagent/policy.yml   write one; the default allows everything
AGENTS.md              optional, how this site likes to be edited
```

Minimal `config.yml`:

```yaml
alertContact: dev@agency.example
costCeilingUsd: 2.00
model: openrouter/anthropic/claude-sonnet-5
maxRequestMinutes: 10
```

Minimal `policy.yml`:

```yaml
allow:
  - 'src/**'
  - 'public/images/**'
maxFilesChanged: 15
maxDiffLines: 800
```

Copy [`docs/AGENTS.example.md`](AGENTS.example.md) to the repo root as `AGENTS.md` and edit it.

## Run locally

```bash
git clone <this repository> && cd website-ai-auto-builder
npm ci
docker build -t webagent/agent:latest agent/

cp .env.example .env
npm run gen:secrets >> .env
# fill in by hand: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_REPO,
# NETLIFY_TOKEN, NETLIFY_SITE_ID, OPENROUTER_API_KEY, SMTP_URL, SMTP_FROM,
# PUBLIC_BASE_URL=http://localhost:3000, ALLOWED_EMAILS=you@example.com
npm run check:env

export WEBAGENT_STATE_DIR="$PWD/.webagent-state"
npm run dev
```

Enrol your authenticator once: `npm run enroll:link`, open the URL, scan the QR. Then open
`http://localhost:3000`: sign-in is the email link followed by the six-digit code.

Skip the sign-in email while testing:

```bash
npm run dev:session -- --out /tmp/jar.txt
curl -b /tmp/jar.txt localhost:3000/api/conversations
```

## Run on a VPS

Once per host, as root, on Ubuntu 24.04:

```bash
apt-get update && apt-get install -y git curl caddy
mkdir -p /opt/webamend && git clone <this repository> /opt/webamend/src && cd /opt/webamend/src
ops/bootstrap-host.sh
ufw allow 22,80,443/tcp && ufw --force enable
```

Once per client, one command. It pauses for the `.env` edit, waits until `edit.acme.example`
resolves to this box, releases, adds the Caddy block, and prints the client's enrollment link:

```bash
ops/launch-client.sh acme edit.acme.example        # picks the next free port
```

Create the DNS record first: an **A record** for `edit.acme.example` to the VPS's public IP, and
an AAAA record if it has IPv6. Caddy cannot get a certificate until it resolves.

<details>
<summary>The same steps by hand</summary>


```bash
ops/provision-client.sh acme edit.acme.example 3001
sudoedit /srv/webamend/acme/.env        # fill in the same values as the local .env
```

Mint the secrets as the client user, then confirm the file parses (the script prints both commands
verbatim; they run Node in a throwaway container, so the host needs no toolchain):

```bash
docker run --rm -v /opt/webamend/src:/src:ro -w /build node:22-slim \
  sh -c 'cp -a /src/. /build && npm ci --silent \
         && npm run --silent gen:secrets' \
  | sudo -u acme tee -a /srv/webamend/acme/.env >/dev/null
```

Point DNS at the box: an **A record** for `edit.acme.example` to the VPS's public IP (and an AAAA
record if it has IPv6). Caddy cannot get a certificate until that resolves. Then:

```bash
ops/release.sh --client acme
cat >>/etc/caddy/Caddyfile <<'CADDY'
edit.acme.example {
    reverse_proxy 127.0.0.1:3001
}
CADDY
systemctl reload caddy
ops/status.sh
```

Set `PUBLIC_BASE_URL=https://edit.acme.example` in the client's `.env` so sign-in links point at
the right place.

</details>

Deploying new code to every client later:

```bash
cd /opt/webamend/src && git pull && ops/release.sh
```

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run test:int
```

## Back up

Each client's `.env`. Nothing else; the authenticator secret is in it.
