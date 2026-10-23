# Deploy SplitMind to Cloudflare

This puts OpenConnector, with SplitMind's patches and policy, on your Cloudflare account as one Worker on a
`workers.dev` URL. The deploy script is safe to re-run: use the same command for the first deploy, for upgrades and
after changing the template.

What it creates, all named after the Worker (default `splitmind`):

| Resource | Name | Why |
|---|---|---|
| Worker | `splitmind` | The OpenConnector runtime and the Web Console |
| D1 database | `splitmind-db` | Connections, encrypted credentials, runtime tokens, run logs |
| KV namespace | `splitmind-transit-files` | Temporary files from actions (≤ 25 MiB each) |
| KV namespace | `splitmind-oauth` | MCP OAuth for Claude (`OAUTH_KV`) |

Design and cost reasoning: [ADR-0001](../adr/0001-deployment-shape.md).

## Before you start

- Node.js 22.18 or newer, and `git`.
- A Cloudflare account. The Workers Free plan is the starting point; see [Free or Paid](#free-or-paid) below.
- A password manager, for the encryption key.

## 1. Get the code

```bash
git clone --recurse-submodules https://github.com/samfeder/SplitMind.git
cd SplitMind
scripts/bootstrap.sh
```

`bootstrap.sh` checks out the pinned OpenConnector release, applies `patches/`, and installs dependencies.

## 2. Log in to Cloudflare

```bash
(cd vendor/open-connector && npx wrangler login)
```

This opens a browser to authorize wrangler. Check it worked with `(cd vendor/open-connector && npx wrangler whoami)`.

## 3. Deploy

```bash
npm run deploy
```

To use another Worker name (for example a throwaway test), pass `-- --name <worker-name>`. To serve on a custom
domain you have already routed to the Worker, pass `-- --origin https://<your-domain>`.

The script prints each step:

1. **Cloudflare resources.** It finds or creates the D1 database and both KV namespaces, and saves their ids to
   `splitmind.local.json` (git-ignored; it holds account-specific ids, not secrets).
2. **Config.** It renders [`wrangler.template.jsonc`](../../wrangler.template.jsonc) into
   `vendor/open-connector/wrangler.local.jsonc` (git-ignored upstream).
3. **D1 migrations**, applied remotely. Upstream's deploy does not run them, so the script always does.
4. **Build.** OpenConnector's catalog and Web Console, then the Worker's catalog assets trimmed to the providers in
   `OOMOL_CONNECT_ALLOWED_ACTIONS` (Notion and Slack).
5. **Deploy.** The first time, wrangler may ask to register a `workers.dev` subdomain for the account. The script
   then reads the Worker's URL from wrangler, sets it as `OOMOL_CONNECT_ORIGIN` and deploys again. Until that
   second pass the Worker answers every request with 503, so it is never reachable half-configured.
6. **Secrets.** If the admin token or encryption key is not set, the script stops at wrangler's prompt for each.
   For each one, run this in **another** terminal and paste its output at the prompt:

   ```bash
   openssl rand -base64 32
   ```

   - `OOMOL_CONNECT_ADMIN_TOKEN` signs you in to the Web Console and approves Claude's OAuth consent. Keep it in
     your password manager too.
   - `OOMOL_CONNECT_ENCRYPTION_KEY` encrypts every stored credential. **Save it in your password manager before
     pasting it.** If it is lost, stored credentials cannot be recovered and every account must be reconnected.
     Paste the `openssl` output exactly: a 32-byte base64 key takes the fast HKDF path
     ([patch 0001](../../patches/README.md)); anything else falls back to slow PBKDF2.

   The script never sees, prints or stores either value. Never paste them into a chat, an issue or a commit.
7. **Health check.** `GET <origin>/health` must return `{"ok":true}`.

Then open the printed URL in a browser and sign in with the admin token.

### Check it yourself

```bash
curl https://<your-worker>.workers.dev/health
# {"ok":true}
curl -s https://<your-worker>.workers.dev/.well-known/oauth-authorization-server | head -c 120
# {"issuer":"https://<your-worker>.workers.dev","authorization_endpoint":"https://<your-worker>.workers.dev/oauth/mcp/authorize",...
```

## Free or Paid

SplitMind starts on **Workers Free**, which allows 10 ms of CPU per request. Two changes make that plausible:
patch 0001 (HKDF instead of PBKDF2) and the trimmed catalog. Measured in local `workerd` on 2026-10-23
(wall-clock time, a proxy for Cloudflare's CPU time):

| First request on a new isolate | Local wall time |
|---|---|
| Full catalog (1,667 providers, 47.8 MB of assets) | 885–1,691 ms |
| Trimmed catalog (2 providers, 144 KB) | 76–144 ms |
| PBKDF2 key setup alone | ~15 ms (HKDF: under 1 ms) |

Warm requests take 4–7 ms. The cold-request figure includes I/O that Cloudflare does not count as CPU, so the real
number is lower, but it is likely still above 10 ms. Cloudflare tolerates infrequent overruns, which is why this is
a trial rather than a prediction.

**Watch it for 24 hours of normal use.** In the Cloudflare dashboard, open Workers & Pages → `splitmind` →
Metrics and look at **CPU time** (the per-request percentiles) and **Errors**. Switch to Paid if:

- any request's CPU time goes over 10 ms on a regular basis, or
- any error 1102 ("Worker exceeded resource limits") appears, or Claude reports the connector failing after an
  idle gap.

**Switching to Paid** costs $5/month for the account (ADR-0001, finding 3) and needs no redeploy: Workers & Pages →
Plans → Workers Paid. Then uncomment the `limits` block in `wrangler.template.jsonc` and run `npm run deploy` again
to cap runaway CPU.

## Re-running and upgrading

- `npm run deploy` again at any time. It reuses the saved resources, applies any new migrations, and only asks for
  secrets that are missing.
- After bumping the OpenConnector pin ([upgrading guide](../upgrading-openconnector.md)), run
  `scripts/bootstrap.sh` and then `npm run deploy`.
- `npm run deploy -- --render-only` rewrites `wrangler.local.jsonc` from the saved state without touching
  Cloudflare, so you can run other wrangler commands against it.
- `npm run deploy -- --dry-run` builds and bundles with placeholder ids. It needs no login and changes nothing;
  use it to check a change before deploying.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/health` returns 503 "MCP OAuth requires a configured origin, administrator token, and encryption key." | A secret is missing. Re-run `npm run deploy`, which prompts for missing ones. |
| `/health` returns 503 right after the first deploy | The origin pass did not run. Re-run `npm run deploy`. |
| `could not find the workers.dev URL in wrangler's output` | The account has no workers.dev subdomain, or you deploy on a route. Re-run with `-- --origin https://<host>`. |
| `splitmind.local.json is for Worker "…"` | You passed a different `--name`. Move the file aside (or delete it) to deploy a second Worker. |
| Error 1102 in the dashboard or in Claude | Over the Free CPU limit; see [Free or Paid](#free-or-paid). |

## Tearing down

To remove a deployment (for example a test Worker named `splitmind-test`):

```bash
cd vendor/open-connector
npx wrangler delete splitmind-test
npx wrangler d1 delete splitmind-test-db
npx wrangler kv namespace delete --namespace-id <id from splitmind.local.json>   # transit, then oauth
cd ../.. && rm splitmind.local.json
```

Deleting the D1 database deletes every stored credential; there is no undo.
