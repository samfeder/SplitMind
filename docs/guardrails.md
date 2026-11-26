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

### Budget for anonymous KV writes (patch 0017, #78)

Workers Free allows 1,000 KV writes a day, and two unauthenticated requests could write to `OAUTH_KV`: registering a
client (`POST /oauth/mcp/register`) and a token request that carries a client assertion (the library stores a replay
marker). Starting a sign-in (`GET /oauth/mcp/authorize`) used to store a consent transaction as well. If anyone could
use the day's writes up, connected clients could not refresh their tokens. Patch 0017 closes all three:

- **Registration is budgeted.** One Durable Object (`MCP_OAUTH_ANONYMOUS_WRITES`) counts registrations per UTC day, so
  the limit is exact:

  | Setting | Default | Effect |
  |---|---|---|
  | `OOMOL_CONNECT_MCP_OAUTH_MAX_ANONYMOUS_WRITES_PER_DAY` | `100` | Registrations accepted in total. |
  | `OOMOL_CONNECT_MCP_OAUTH_MAX_ANONYMOUS_WRITES_PER_IP_PER_DAY` | `20` | The same, per client address (`CF-Connecting-IP`; IPv6 counts per /64). |

  Registrations the redirect allowlist refuses use no slot. Over the budget, a registration answers
  `400 invalid_client_metadata` with a `Retry-After` of the seconds left until 00:00 UTC, and nothing is written. If
  the counter cannot answer, the registration is refused and an error is logged. An over-budget refusal logs one
  warning that names the limit that refused (`global` or `per_address`, `global` if both are reached) and neither the
  address nor the client; a counter failure logs an error; a registration the allowlist refuses logs nothing.
- **Sign-in writes nothing before the administrator token.** `GET /oauth/mcp/authorize` only shows the consent page.
  The page posts back to the same URL, and the Worker stores the authorization (and writes anything) only after
  checking the administrator token, for Allow and for Deny. An anonymous request therefore never writes, and sign-in
  never touches the budget.
  A wrong or missing token logs one warning, `{ event: "mcp_oauth_consent_token_refused" }`, with no token, address or client in it.
- **Client assertions are refused.** A token request with `client_assertion` or `client_assertion_type` gets
  `401 invalid_client`, since this gateway has no use for them (one warning line, no client_id). Token bodies are
  also capped at 64 KiB.

Trade-off: an attacker can spend the registration budget and block new registrations until 00:00 UTC. claude.ai and
Claude Code sign in with CIMD (a client metadata URL) and do not register, so real sign-ins are unaffected, and
connections that already exist keep refreshing. Clients that do register (some other MCP clients) wait until the
budget resets.

The way out is to raise the variable: change the value in `wrangler.template.jsonc` and redeploy with
`npm run deploy`. A value that is empty, not a whole number or below 1 means the default.

The token-endpoint refusal and the body cap run whether or not the `MCP_OAUTH_ANONYMOUS_WRITES` binding exists. Without
the binding only the registration budget is off. To undo the Durable Object, see the
[rollback runbook](runbooks/mcp-oauth-budget-rollback.md).

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

OpenConnector v1.9.2 has no per-connection read-only switch, so SplitMind carries one as patch 0018
([patches/README.md](../patches/README.md)). The upstream issue is drafted in
[docs/upstream/connection-read-only-issue-draft.md](upstream/connection-read-only-issue-draft.md). Option 0 is the
switch; options 1 to 4 are workarounds that still apply and stack with it.

0. **Mark the connection read-only (patch 0018).** Set `OOMOL_CONNECT_READ_ONLY_CONNECTIONS` to a comma- or
   whitespace-separated list of `<providerId>:<connectionName>` entries, for example
   `notion:<alias-a>, slack:<alias-b>`. It is a deployment setting like `OOMOL_CONNECT_BLOCKED_ACTIONS` (a Worker
   variable, not stored per connection), and it applies to every caller: MCP OAuth clients such as claude.ai,
   runtime tokens and the HTTP API. Other connections of the same provider are unaffected. Use `<providerId>:default`
   for an unnamed connection.
   - Actions: only a catalog `operationType` of `read` runs. `write`, `destructive` and an action with no
     `operationType` are refused with `action_blocked` (a deployment policy check, message `Connection
     "<providerId>:<connectionName>" is read-only; write actions are refused.`), and the run log records it.
   - Proxy: every `POST /v1/proxy/:service` request through the connection is refused with 403, whatever the
     method, because a raw request cannot be safely classed as a read (Notion's search is a POST).
   - Triggers: creating or deleting a provider webhook or resource (`reconcile`, `resource`) is refused with 403.
     Polling, options, event-source checks and inbound deliveries still work, and cleanup and maintenance still
     remove existing webhooks, so none are orphaned.
   - `list_connections` and `/v1/apps/services/:service` add `readOnly: true` to listed connections, so agents
     can pick the right account.
   - Guidance agrees with enforcement (#94): when a connection is selected (`connectionName` on
     `get_action_guide`, the default connection for `search_actions`, `?connectionName=`, `?alias=` or the
     `x-oo-connector-alias` header on the console `agent.md` route), the policy shown for a write, destructive or
     unlabelled action is `Denied:` with the same message. With no connection selected, nothing changes.
   - **Set it as a Wrangler secret,** from the repo root:
     `(cd vendor/open-connector && npx wrangler secret put OOMOL_CONNECT_READ_ONLY_CONNECTIONS --config wrangler.local.jsonc)`
     (`npm run deploy` renders that config there). Never set it as a dashboard variable: the next deploy deletes it, which silently turns
     read-only off.
   - **After each deploy,** check that `list_connections` still shows `readOnly: true` on the connections you listed.
   - **After deploying patch 0019,** revoke the runtime tokens whose names start with "MCP OAuth" and reconnect
     claude.ai and Claude Code. Existing read-only grants keep the action ids from consent time (#95), so they do
     not pick up the relabelled actions. Do this in the same step as the re-issue the 0017 deploy already asks for
     (#130). If 0017 was already deployed and its grants re-issued, reconnect again after 0019.
   - **Patch 0020 (#134)** relabels 17 more pass-through and mutating actions (raw SQL and GraphQL runners, MCP
     `call_tool` forwarders, scrapers that take any HTTP method) as `write` or `destructive`, so read-only
     connections and read-only grants lose them. Existing read-only grants keep their consent-time action ids
     (#95), so reconnect again after 0020, or in the same step as 0019 if they deploy together. An executor-level
     gate that could return some of them to `read` is tracked in #137.
   - **Patch 0030 (#95)** ends the reconnects above. A new read-only grant stores the rule `@read`, which allows
     an action only while its catalog label is `read`, checked on every request. A later relabel to `write`
     takes effect at once, and new read actions are included. **After deploying 0030,** revoke the runtime
     tokens whose names start with "MCP OAuth" and reconnect claude.ai and Claude Code once; grants made
     before 0030 keep their frozen ids. Hand-made tokens can use `@read` in `allowedActions` too (it is
     accepted only for actions, not for proxies or triggers).
   - **Startup warnings:** an entry that can never match (an uppercase letter in the provider id, `*` in either
     part, or a provider that is not in the catalog) is kept but logged once, naming the entry. Malformed entries
     are ignored with a warning. Nothing throws. Valid entries log nothing. Each warning is logged once per isolate
     per config (#135): the app and the email watch share one parsed list, so a cron run does not repeat them. The
     "not in the catalog" warning is Worker-only: the Node entry parses the setting before it has a catalog (#136).
   - **Not covered yet:** the `call_tool` and `execute_tool` pass-throughs are not audited for this rule; #134
     tracks it.
   - **What it trusts:** the catalog's `operationType` labels. Patch 0019 corrects the known mislabels (presigned
     URL generators, one-time verifications and similar actions that were labelled `read` but write), so keep it
     with 0018. An action nobody has audited can still carry a wrong label.
   - **It keys on the connection name.** Connecting the same account again under another name gives a writable
     connection, so restrict who can add connections (the admin token) if that matters.
   - **Webhooks created before the connection was marked read-only** can no longer be renewed or deactivated by
     callers. Only the admin cancel route (`POST /api/trigger-subscriptions/:id/cancel`) and the maintenance job
     remove them.
   - **It does not cap spend.** Billed read actions (LLM calls, embeddings, screenshots) still run.
   - Matching is exact and case-sensitive. A malformed entry (no `:`, more than one, or an empty side) is ignored
     and logged once as a warning at startup. Unset or empty changes nothing. Changing the variable takes effect on
     the next request after deploy.

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
   That makes the provider read-only for every account. Alternatively put `@read` in the list: it follows the
   catalog's `read` labels instead of fixed ids, so new read actions are included on upgrade (patch 0030). Patch
   0032 warns at startup about a misspelled `@…` entry. Because the list follows labels, audit new or changed `read`
   labels on every upstream bump (`docs/upgrading-openconnector.md`, step 6).

## 6. Email watch (patches 0009, 0011 and 0012, #126, #104 to #107, #110, #111)

The Worker's existing once-a-minute cron can check named Gmail accounts for new inbox mail and keep a short list of
machine mail that needs action: a failed deploy or build, a GitHub failure or review request, a billing or quota
warning, an account or security notice. A read action lists them and a write action marks them handled. It is **off
by default**; neither setting below is in `wrangler.template.jsonc`.

**What it reads.** Only three Gmail reads, hard-coded in the watcher (any other action is refused before it reaches
the action runner): `gmail.get_profile` (once per account, for the starting point), `gmail.list_history` (new inbox
messages since the last check; drafts, sent mail, spam and trash are skipped) and `gmail.fetch_message_by_message_id`
with `format: "metadata"` and four named headers: `From`, `Subject`, `Authentication-Results` and
`X-GitHub-Reason`. It never asks for a body, recipients, labels or attachments. Gmail's `format=metadata` response
still includes a short snippet; the watcher discards it without storing or logging it. Every call goes through the
normal action runner, so `OOMOL_CONNECT_ALLOWED_ACTIONS`, `OOMOL_CONNECT_BLOCKED_ACTIONS` and the runtime policy
apply: an account whose policy refuses one of the three is skipped for that run. Do not put those three actions in
`OOMOL_CONNECT_BLOCKED_ACTIONS`. A run makes at most 15 Gmail action runs (each can cost two subrequests on Workers Free, which allows 50); more mail than that is read over the next
minutes.

**What it stores.** Two D1 tables (migration `0019_email_watch.sql`, plus indexes in `0020_email_watch_indexes.sql`, one of which
`0021_email_watch_drop_connection_index.sql` drops again; `0022_email_watch_cursor_state.sql` adds three cursor columns; `0023_email_watch_cursor_created_at.sql` adds `created_at`):

- `email_watch_cursors`: per account, the Gmail history id it has read up to, a page token while it is part-way
  through a backlog, the last run time and a catch-up flag, the time of the last successful read (`last_success_at`),
  the time the "could not read" item was left for the current failure streak (`failing_notice_at`) and the id of the
  Gmail connection the alias pointed at when the cursor was written (`connection_id`), and when the row was first
  written (`created_at`; migration 0023 backfills it from `last_success_at`, else `last_run_at`).
- `email_watch_items`: one row per kept message: the account alias, Gmail's message and thread ids, the sender's
  **domain** (not the address), the subject (control characters removed, at most 200 characters), the category and
  rule id, the received time, status (`pending` or `acknowledged`) and a duplicate key. The same alert in the same
  or another account within 24 hours counts on the first row (`occurrences`) instead of adding a row.

Mail that matches no rule writes nothing. Full addresses, recipients, snippets, bodies, labels and other header
values are never stored. If Gmail has dropped the history the watcher was reading (after about a week without a
check), it restarts from the mailbox's current position and adds one `watch_gap` item saying which period was not
checked. That item's window starts at the **last successful read** (`last_success_at`), not at the last attempt, so
days of failed polls before the history expired are inside it.

**When an account keeps failing.** A poll that cannot read Gmail (an auth error, a refusal by policy, a 5xx or a rate
limit) leaves the cursor where it was and goes back to the normal interval: it does **not** retry every minute. Only
an account the 15-run budget did not reach is flagged for an off-interval run. When the first failed poll of a streak
comes 24 hours or more after the last successful read, the watcher leaves one pending `watch_gap` item with rule id
`watch-failing` and the subject `Email watch could not read this account since <time of the last successful read>`.
It carries no error text, address or subject. Migration 0022 backfills `last_success_at` from `last_run_at`, which
overstates the last success for an account that was already failing when the migration ran, so its first item can name
a later time than the real last read. There is one per failure streak; the next successful read clears the
streak, and a later 24-hour failure gets a new item. The item is claimed only while the cursor still holds the
`last_success_at` the poll loaded, so a poll that a concurrent success overtook leaves none.

**An account that never started.** If the very first `get_profile` for an alias fails (not for lack of budget), the
watcher writes a **stub cursor**: empty `history_id`, no `last_success_at`, `connection_id` set, `created_at` now. Each
later poll asks Gmail for the profile again; the first success fills in `history_id` and `last_success_at` and clears
the streak on the same row, with no backfill. While it keeps failing, the rules above apply with the time counted from
`last_success_at`, else `created_at`; after 24 hours one `watch-failing` item says
`Email watch could not start reading this account (trying since <time>)`. A stub is subject to the alias check and
the purges like any cursor. An alias the budget did not reach gets no stub.

**An alias reused by another account.** At the start of each poll the watcher asks the connection store (no Gmail
call) which connection the alias points at and compares an **account fingerprint** with the cursor's `connection_id`.
The fingerprint is the sha256 hex of the connection's row id, a bar and the provider account id from its profile; no
address or id is stored. So deleting the connection and saving the alias again, and saving the alias over in place
for a different Google account, both count as a different account; reconnecting the same account in place does not. A
cursor from before patch 0015 has no fingerprint and simply adopts the current one: **if its alias was already reused
before the patch, the new account is adopted with the old items and nothing can detect it.** If the fingerprint
differs, or the alias no longer points at any connection, the alias's items and cursor are deleted in one batch (each
delete only while the cursor still holds the fingerprint that poll read, so a slower overlapping poll cannot delete
what a newer one stored), one warn line carrying only the alias is logged, and, if the alias resolves, the watch
starts fresh for it (no backfill). If the store cannot be read the poll is skipped and nothing is deleted. Until the
next poll runs, `list_pending_mail` and `acknowledge_mail` hide and leave alone the items of an alias whose recorded
fingerprint differs from the current one, and the items of an alias that has no cursor at all (a cursor deleted by
hand: the sweep skips its cursor purge when the items purge failed, and a purge cannot stop half way), so the new
account does not see the previous one's mail in either case.

**Rules.** A checked-in table (`src/server/email-watch/rules.ts` in the patch) of sender domains plus a subject
pattern or a GitHub header: `deploy_failed`, `github`, `account_security`, `billing_quota`. The first rule that
matches, in that order, wins. GitHub items depend on the `X-GitHub-Reason` header (`review_requested`,
`security_alert`, or `ci_activity` with a failing subject), never on the subject alone, because issue and pull
request titles are written by anyone. Mail from github.com that carries that header is judged by the GitHub rule
only. GitHub account mail without it (a new sign-in, say) can still match `account_security`.

**Subjects can be sensitive.** A stored subject is whatever the sender wrote, and a security notice's subject may
contain a verification code. Before a subject is stored, and before its duplicate key is computed, these are
removed: every Unicode default-ignorable code point (all format characters, category Cf: soft hyphen, zero-width
characters, directional marks, tag characters; the combining grapheme joiner U+034F; the Hangul fillers U+115F, U+1160,
U+3164 and U+FFA0; the variation selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF; the Mongolian free variation
selectors), the braille blank U+2800, the combining enclosing keycap U+20E3, and any combining mark that follows a
decimal digit. Marks after letters stay (`café`). Keycap digits such as `4️⃣8️⃣2️⃣9️⃣` become `4829` and are redacted.
Then every run of 4 or more digits is replaced with
`[redacted]`, in every category. A digit is any Unicode decimal digit (fullwidth and Arabic-Indic included). Neighbouring
digits may be separated by nothing or by exactly one separator: whitespace (including no-break spaces), a dot, a
hyphen, a dash (U+2010 to U+2015) or a minus (U+2212), so `123456`, `123 456`, `482.913` and `482–913` are all
redacted. Years, invoice numbers, decimals such as `1.234` and IP-like strings with 4 or more digits are redacted too,
and two code mails with different codes count as one item. **Residual:** these are not redacted: codes that mix
letters and digits, have fewer than 4 digits, or use a multi-character separator (`123 - 456`). A zero-width joiner
(U+200D) is a format character, so emoji joined with it are split into separate emoji in the stored subject, and
U+FE0F is removed too, so emoji show in their text presentation. Other invisible characters outside these classes, and a
combining mark that follows a non-digit and sits inside a digit run, are not covered.
Treat `email_watch_items` like the run log: private, and kept only for the retention period below.

**Forged mail is not surfaced.** A rule can match only when the **first** `Authentication-Results` header on the
message has the authserv-id `mx.google.com` (Gmail's own mail server stamps it, above anything the sender wrote), says
`dmarc=pass`, and its `header.from` equals the domain of the `From` address. Later `Authentication-Results` headers
and `ARC-*` headers are ignored, because a sender can write those. A message with no such header, a failed or
missing DMARC result, or a `header.from` for another domain stores nothing, so mail that only claims to be from a
rule domain does not appear in the list.

**Logs.** Watcher log lines carry only the account alias, counts, rule ids, categories and error codes: never a
subject, an address, a header value or a Gmail id. Its run-log entries (Runs page, `caller` = `cron`) are written
only for a **failed** Gmail call (a successful poll leaves no row, so the watcher does not fill the run log); a failure
records the outcome and policy decision but no `inputSummary` or `outputSummary`, so nothing from a message reaches the
run log, unlike the rows in section 4. The host log's completion line for those runs omits the connection id. Runs of the `mail_watch` actions (`list_pending_mail`, `acknowledge_mail`) are
outcome-only too, whoever calls them and whatever `audit` value they pass: `ActionRunner` enforces it for the
`mail_watch` provider, and a failed run keeps its error code but a fixed message.

**Retention.** A sweep runs on every cron invocation whose UTC minute is a multiple of the watch interval, whether
or not any account is configured. It deletes `pending` items older than 14 days and `acknowledged` items older than 7
days, then deletes all items and cursors of any account that is not in the current
`OOMOL_CONNECT_EMAIL_WATCH_CONNECTIONS` list (an empty or unset list purges everything; malformed entries count as
not watched). So removing an account, or turning the watch off, purges what was stored for it within one interval.
The sweep uses D1 only: no Gmail call, no KV write, no run-log row. If the tables do not exist yet it does nothing;
any other failure is logged once per sweep by error name and the other cron work still runs. Only the first error
of a sweep is logged; later, different errors in the same sweep are not logged, on purpose. The pending-expiry delete,
the acknowledged-expiry delete and each table's purge are independent, so a failure (or a missing table) in one does
not stop the others, except that a failed (not missing) items purge skips the cursor purge for that sweep, so
items are never left without a cursor. The purge of unwatched accounts has no limit on the number of watched
accounts (D1 allows 100 bound parameters per statement): it reads the distinct account names in each table and
deletes the unwatched ones in chunks of 50. **Cost:** the expiry deletes use the two status indexes from migration
0020, so they read about the rows they delete. The distinct-names read scans the unique `(connection_name,
gmail_message_id)` index of `email_watch_items` (a covering-index scan, not a table scan), so it reads one index entry
per stored item; with 14-day retention of machine mail only, that stays small. Migration
`0021_email_watch_drop_connection_index.sql` drops 0020's `(connection_name)` index, which duplicated the unique index
for this read.

**Reading it.** `mail_watch.list_pending_mail` (read; filters `category`, `connectionName`, `limit` 1–100, default 50)
returns `{ enabled, items }`, newest first, each with a Gmail link built at read time from the account's stored
profile (the address is not copied into the new tables). `mail_watch.acknowledge_mail` (write; 1–100 item ids) marks
items acknowledged and writes only to `email_watch_items`. A read-only MCP grant (patch 0004) gets the list action and
not the acknowledge action. A token or grant scoped to chosen accounts (patch 0004) sees and
acknowledges only the items of those Gmail accounts, `watch_gap` items included; an unscoped one sees all. One statement lists at most 90 accounts (D1 allows 100 bound values); if more accounts than that have items the
list logs one warn line with the count left out (`omitted`) and no names. With the watch off both return `enabled: false` / `acknowledged: 0` and touch nothing.

**Turning it on** is a deliberate step, not part of `npm run deploy`:

1. Sam names the accounts, and the chief approves the list.
2. In the Cloudflare dashboard (or a local, uncommitted wrangler config) set
   `OOMOL_CONNECT_EMAIL_WATCH_CONNECTIONS="gmail:<alias-a>,gmail:<alias-b>"`. Entries for another provider or
   without an alias are ignored with one warning. `OOMOL_CONNECT_EMAIL_WATCH_INTERVAL_MINUTES` (1 to 60, default 10)
   is how often it runs. The rendered config does not name them, and Wrangler replaces
   variables that exist only in the dashboard when it deploys, so confirm they are still set after each
   `npm run deploy`; if they are gone the watch is simply off.
3. Check the cursors: a row in `email_watch_cursors` for each alias, with `connection_id` set, means the first pass
   worked (successful passes leave no run-log row; a failed Gmail call leaves a `caller=cron` row on **Runs**). The
   first pass reads nothing from the past; only mail that arrives afterwards is checked.

**CPU.** On Workers Free each invocation has 10 ms of CPU. Measurements for this patch are in the pull request.
