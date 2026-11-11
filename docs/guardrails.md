# Guardrails

SplitMind lets one Claude connector act as several accounts. These are the rules that keep each call on the account
you meant, and how to check them. `npm run verify` (below) tests the ones that can be tested from outside.

> Placeholders in `<angle brackets>`; never put real workspace names, ids or your Worker URL in issues or commits.

## Check a deployment

```bash
npm run verify                          # uses the origin saved by npm run deploy
npm run verify -- --origin https://<your-worker>.workers.dev
```

It asks for the admin token with hidden input (or reads `SPLITMIND_ADMIN_TOKEN`). It never prints it. It creates
one temporary runtime token, which is allowed every proxy and every action, so any refusal it sees comes from the
deployment's own policy. It deletes the token before it exits. Expected output:

```
PASS  GET /health returns {"ok":true}  (200)
PASS  the account setup page is served at /setup/  (200)
PASS  the setup page has a strict Content-Security-Policy  (default-src 'none'; script-src 'self'; …)
PASS  the privacy policy is served at /privacy/  (200)
PASS  OAuth discovery names this origin as issuer  (200 issuer=https://<your-worker>.workers.dev)
PASS  a client with a non-Claude redirect URI can't register  (400 invalid_client_metadata)
PASS  POST /mcp without a token is refused  (401)
PASS  raw gmail proxy is blocked by deployment policy  (403 proxy_blocked)
PASS  raw notion proxy is blocked by deployment policy  (403 proxy_blocked)
PASS  raw slack proxy is blocked by deployment policy  (403 proxy_blocked)
PASS  only cloudflare_dns, cloudflare_worker, gmail, netlify, notion and slack are offered  (200 [cloudflare_dns, cloudflare_worker, gmail, netlify, notion, slack])
PASS  an action outside the allowlist is refused  (404 unknown_action)
PASS  an allowlisted action is not refused by policy  (400 invalid_input)
PASS  the 5 blocked action(s) are refused by policy  (gmail.stop_watch=400 action_blocked, …)
PASS  no default notion connection  (200 2 connection(s): [<alias-a>, <alias-b>])
PASS  each notion connection is a different account  (2 connection(s))
PASS  unnamed notion write is refused (MCP execute_action, no connectionName)  (ok=false connection_required)
PASS  notion write to connectionName "default" is refused  (ok=false connection_not_found)
PASS  no default slack connection  (200 2 connection(s): [<alias-c>, <alias-d>])
PASS  each slack connection is a different account  (2 connection(s))
PASS  unnamed slack write is refused (MCP execute_action, no connectionName)  (ok=false connection_required)
PASS  slack write to connectionName "default" is refused  (ok=false connection_not_found)
PASS  no default gmail connection  (200 2 connection(s): [<alias-e>, <alias-f>])
PASS  each gmail connection is a different account  (2 connection(s))
PASS  unnamed gmail write is refused (MCP execute_action, no connectionName)  (ok=false connection_required)
PASS  gmail write to connectionName "default" is refused  (ok=false connection_not_found)
PASS  temporary runtime token deleted  (200)
All 25 checks passed.
```

Before any account is connected, the per-account lines are skipped and the total is 14. "Different account" runs
once a provider has two or more connections: it fails when two aliases hold the same account (easy with Google, which
may sign in as whichever account the browser is using).

## 1. Policy baseline (decision 7)

Set in [`wrangler.template.jsonc`](../wrangler.template.jsonc):

| Setting | Value | Effect |
|---|---|---|
| `OOMOL_CONNECT_BLOCKED_PROXIES` | `*` | No raw provider API calls (`/v1/proxy/:service`), whatever a token is granted. Refusal: `403 proxy_blocked`. |
| `OOMOL_CONNECT_ALLOWED_ACTIONS` | `notion.*,slack.*,gmail.*` (the template also lists Netlify, Cloudflare and `mail_watch.*`) | Only those providers' actions run. Another provider's action: `400 action_not_allowed`. |
| `OOMOL_CONNECT_BLOCKED_ACTIONS` | five Gmail settings writes | Vacation responder, IMAP, POP, language and `stop_watch` are refused on every account: `400 action_blocked` ([why](providers/gmail.md#what-splitmind-uses)). |
| Catalog assets | Notion, Slack and Gmail only | Other providers are not even listed; their actions return `404 unknown_action`. |

The allowlist is a real policy layer, not just the trimmed catalog. With `OOMOL_CONNECT_ALLOWED_ACTIONS="notion.*"`
on a local Worker whose catalog still had Slack, a Slack call was refused:

```
POST /v1/actions/slack.list_channels
{"success":false,"message":"slack.list_channels is not included in the local action allowlist.","errorCode":"action_not_allowed",...} [400]
```

**Adding a provider later** means one edit and a redeploy: add `<service>.*` to `OOMOL_CONNECT_ALLOWED_ACTIONS` in
`wrangler.template.jsonc` (the deploy script derives the catalog trim from it), run `npm run deploy`, then connect
the account. See [adding a provider](adding-a-provider.md).

## 2. Writes must name an account (decision 8, E6.1)

OpenConnector treats a call with no `connectionName` as a call to the connection literally named `default`
(`src/connection-service.ts`, `value?.trim() || "default"`). SplitMind therefore never creates a `default` connection
for any provider. With none:

- `execute_action` with no `connectionName` fails before any request leaves the Worker (`ok:false`,
  `connection_required`: "notion has no default connection. Pass connectionName; …"). Upstream's own message is
  misleading ("Configure notion credentials first.", `authorization_failed`), which agents read as an expired
  sign-in; `patches/0005-…` replaces it until upstream fixes it (U1 in [the Notion spike](spikes/notion-provider.md)).
- `connectionName: "default"` fails with `connection_not_found`.

**The one way to break this:** the Web Console pre-fills `default` as the name of a provider's first connection.
Always overwrite it with an alias. `npm run verify` fails on any connection named `default`, and then skips the
unnamed write so that it can never land in that workspace. To fix one, rename it in the Web Console (or delete and
reconnect it under an alias).

## 3. Every result names its account (E6.2)

- `list_connections` returns each connection's `connectionName` and a safe `profile` (`accountId`, `displayName`
  from the provider). No credentials are ever returned.
- A successful `execute_action` result carries a `connection` object with the same `connectionName` and `profile`.
  From the Notion spike's in-process probe (fake keys):

  ```json
  {"ok":true,"data":{"object":"page","id":"p1","properties":{}},"executionId":"…","auditPersisted":true,
   "connection":{"id":"c-b","service":"notion","connectionName":"notion_b","authType":"api_key","default":false,
   "profile":{"accountId":"bot-B","displayName":"Workspace B","grantedScopes":[]}}}
  ```

- `search_actions` and `get_action_guide` show the selected connection's name and account before you run anything.

So Claude can always say which workspace it acted in. When asking Claude to do something, name the alias ("in
`<alias-a>`, search for …"); it passes that as `connectionName`.

## 4. Run logs (E6.3)

Every action call through HTTP, MCP or the Web Console is recorded in the D1 database.

**Where:** D1 table behind `GET /api/runs`, and the Web Console's **Runs** page (sign in with the admin token).

**How to review:**

- Web Console → **Runs**: newest first; filter by provider, action, caller and success.
- API, with the admin token:

  ```bash
  read -rs SPLITMIND_ADMIN_TOKEN && export SPLITMIND_ADMIN_TOKEN   # paste, Enter; nothing is echoed
  curl -s -H "Authorization: Bearer $SPLITMIND_ADMIN_TOKEN" \
    "https://<your-worker>.workers.dev/api/runs?limit=20&service=slack&ok=false"
  curl -s -H "Authorization: Bearer $SPLITMIND_ADMIN_TOKEN" \
    "https://<your-worker>.workers.dev/api/runs/<run-id>"
  ```

  Filters: `limit` (1–100, default 50), `service`, `actionId`, `caller` (`http`, `mcp`, `web`, `cron`), `ok` (`true`,
  `false`), and `cursor` (from `nextCursor`) for the next page.

**What an entry shows** (a real entry from a local Worker; ids shortened):

```json
{
  "id": "856e0b77-…",
  "service": "slack",
  "actionId": "slack.list_channels",
  "caller": "http",
  "startedAt": "2026-10-23T19:25:50.922Z",
  "completedAt": "2026-10-23T19:25:50.930Z",
  "durationMs": 8,
  "ok": false,
  "runtimeTokenId": "ba66e2c3-…",
  "policy": { "allowed": true, "checks": [
    { "source": "deployment", "outcome": "allow_match", "rule": "slack.*" },
    { "source": "token", "outcome": "allow_match", "rule": "slack.list_channels" } ] },
  "inputSummary": {},
  "errorCode": "authorization_failed",
  "errorMessage": "The provider rejected authorization."
}
```

- `connectionId` and `connectionProfile` say which account ran it (absent here because no account was connected).
- `runtimeTokenId` says which caller: each claude.ai approval has its own `MCP OAuth • <client name>` key, and each
  Claude Code token its own id (Web Console → API Keys).
- `policy.checks` shows which rule allowed or refused it.
- `inputSummary` and `outputSummary` are bounded, redacted copies: keys that look like secrets are masked, and
  strings are cut to 256 characters. They can still contain message text and search queries, so treat the database
  as private.

**Retention:** the newest 5,000 runs (`OOMOL_CONNECT_RUN_LIMIT`); older ones are deleted as new ones arrive.
Cloudflare's own Workers Logs (dashboard → Workers & Pages → `splitmind` → Logs) keep request logs separately, for
the period your plan allows.

## 5. Read-only accounts (E6.4)

OpenConnector has no per-connection read-only switch. The policy layers (deployment, runtime, token) all match on
action ids, and a token applies to every connection it may use. An upstream issue is drafted in
[docs/upstream/connection-read-only-issue-draft.md](upstream/connection-read-only-issue-draft.md).

Until then, pick one of these:

1. **Least privilege at the provider (recommended).** Each workspace has its own Notion integration or Slack app,
   so give the read-only one fewer rights. The provider then refuses writes itself, whatever SplitMind allows.
   - Notion: on that integration tick only **Read content** (and **Read comments** if needed).
   - Slack: create that workspace's app from [`slack/app-manifest.json`](../slack/app-manifest.json) minus the
     four write scopes (`chat:write`, `im:write`, `files:write`, `reactions:write`), and untick the same four when
     connecting. Slack rejects a connection that asks for scopes the app lacks.
   - Gmail: when connecting that mailbox, tick only `gmail.readonly` ([Gmail](providers/gmail.md#a-read-only-mailbox)).
2. **A read-only runtime token** for Claude Code or scripts. List the provider's read actions and allow only those,
   optionally pinned to one connection with `allowedConnections`:

   ```bash
   # ids of read actions, e.g. 17 of Slack's 28 at v1.9.2
   curl -s -H "Authorization: Bearer <a runtime token>" "https://<your-worker>.workers.dev/v1/actions?service=slack" \
     | jq -c '[.data[] | select(.operationType == "read") | .id]'
   ```

   Then create the token in the Web Console (API Keys) with that list as its allowed actions. On a local Worker a
   token restricted this way refused `slack.post_message` with `400 action_not_allowed` and let
   `slack.list_channels` through to the provider.

3. **claude.ai and other OAuth clients:** choose *Read only* on the consent page, and list the accounts the client
   may use (patch 0004, #76). This applies to the whole connector, not one account: claude.ai cannot add a second
   connector with the same URL, so "read-only on `<alias-a>`, writes on `<alias-b>`" still needs option 1.
4. **Deployment-wide:** put explicit read action ids in `OOMOL_CONNECT_ALLOWED_ACTIONS` instead of `slack.*`.
   That makes the provider read-only for every account.

## 6. Email watch (patch 0009, #126)

The Worker's existing once-a-minute cron can check named Gmail accounts for new inbox mail and keep a short list of
machine mail that needs action: a failed deploy or build, a GitHub failure or review request, a billing or quota
warning, an account or security notice. A read action lists them and a write action marks them handled. It is **off
by default**; neither setting below is in `wrangler.template.jsonc`.

**What it reads.** Only three Gmail reads, hard-coded in the watcher (any other action is refused before it reaches
the action runner): `gmail.get_profile` (once per account, for the starting point), `gmail.list_history` (new inbox
messages since the last check; drafts, sent mail, spam and trash are skipped) and `gmail.fetch_message_by_message_id`
with `format: "metadata"` and five named headers: `From`, `Subject`, `Authentication-Results`, `X-GitHub-Reason`
and `List-Id`. It never asks for a body, a snippet, recipients, labels or attachments. Every call goes through the
normal action runner, so `OOMOL_CONNECT_ALLOWED_ACTIONS`, `OOMOL_CONNECT_BLOCKED_ACTIONS` and the runtime policy
apply: an account whose policy refuses one of the three is skipped for that run. Do not put those three actions in
`OOMOL_CONNECT_BLOCKED_ACTIONS`. A run makes at most 15 Gmail action runs (each can cost two subrequests on Workers Free, which allows 50); more mail than that is read over the next
minutes.

**What it stores.** Two D1 tables (migration `0019_email_watch.sql`):

- `email_watch_cursors`: per account, the Gmail history id it has read up to, a page token while it is part-way
  through a backlog, the last run time and a catch-up flag.
- `email_watch_items`: one row per kept message: the account alias, Gmail's message and thread ids, the sender's
  **domain** (not the address), the subject (control characters removed, at most 200 characters), the category and
  rule id, the received time, status (`pending` or `acknowledged`) and a duplicate key. The same alert in the same
  or another account within 24 hours counts on the first row (`occurrences`) instead of adding a row.

Mail that matches no rule writes nothing. Full addresses, recipients, snippets, bodies, labels and other header
values are never stored. If Gmail has dropped the history the watcher was reading (after about a week without a
check), it restarts from the mailbox's current position and adds one `watch_gap` item saying which period was not
checked.

**Rules.** A checked-in table (`src/server/email-watch/rules.ts` in the patch) of sender domains plus a subject
pattern or a GitHub header: `deploy_failed`, `github`, `account_security`, `billing_quota`. The first rule that
matches, in that order, wins.

**Forged mail is not surfaced.** A rule can match only when the **first** `Authentication-Results` header on the
message has the authserv-id `mx.google.com` (Gmail's own mail server stamps it, above anything the sender wrote), says
`dmarc=pass`, and its `header.from` equals the domain of the `From` address. Later `Authentication-Results` headers
and `ARC-*` headers are ignored, because a sender can write those. A message with no such header, a failed or
missing DMARC result, or a `header.from` for another domain stores nothing, so mail that only claims to be from a
rule domain does not appear in the list.

**Logs.** Watcher log lines carry only the account alias, counts, rule ids, categories and error codes: never a
subject, an address, a header value or a Gmail id. Its run-log entries (Runs page, `caller` = `cron`) record the
outcome and policy decision but no `inputSummary` or `outputSummary`, so nothing from a message reaches the run log,
unlike the rows in section 4.

**Retention.** Once a day, on the first watch run after 00:00 UTC, `pending` items older than 14 days and
`acknowledged` items older than 7 days are deleted. Cursors stay.

**Reading it.** `mail_watch.list_pending_mail` (read; filters `category`, `connectionName`, `limit` 1–100, default 50)
returns `{ enabled, items }`, newest first, each with a Gmail link built at read time from the account's stored
profile (the address is not copied into the new tables). `mail_watch.acknowledge_mail` (write; 1–100 item ids) marks
items acknowledged and writes only to `email_watch_items`. A read-only MCP grant (patch 0004) gets the list action and
not the acknowledge action. With the watch off both return `enabled: false` / `acknowledged: 0` and touch nothing.

**Turning it on** is a deliberate step, not part of `npm run deploy`:

1. Sam names the accounts, and the chief approves the list.
2. In the Cloudflare dashboard (or a local, uncommitted wrangler config) set
   `OOMOL_CONNECT_EMAIL_WATCH_CONNECTIONS="gmail:<alias-a>,gmail:<alias-b>"`. Entries for another provider or
   without an alias are ignored with one warning. `OOMOL_CONNECT_EMAIL_WATCH_INTERVAL_MINUTES` (1 to 60, default 10)
   is how often it runs. The rendered config does not name them, and Wrangler replaces
   variables that exist only in the dashboard when it deploys, so confirm they are still set after each
   `npm run deploy`; if they are gone the watch is simply off.
3. Check **Runs**: `caller=cron` rows for `gmail.get_profile` mean the first pass worked. The first pass reads
   nothing from the past; only mail that arrives afterwards is checked.

**CPU.** On Workers Free each invocation has 10 ms of CPU. Measurements for this patch are in the pull request.
