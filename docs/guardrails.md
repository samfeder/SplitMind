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
PASS  OAuth discovery names this origin as issuer  (200 issuer=https://<your-worker>.workers.dev)
PASS  POST /mcp without a token is refused  (401)
PASS  raw gmail proxy is blocked by deployment policy  (403 proxy_blocked)
PASS  raw notion proxy is blocked by deployment policy  (403 proxy_blocked)
PASS  raw slack proxy is blocked by deployment policy  (403 proxy_blocked)
PASS  only gmail, notion and slack are offered  (200 [gmail, notion, slack])
PASS  an action outside the allowlist is refused  (404 unknown_action)
PASS  an allowlisted action is not refused by policy  (400 invalid_input)
PASS  the 5 blocked action(s) are refused by policy  (gmail.stop_watch=400 action_blocked, …)
PASS  no default notion connection  (200 2 connection(s): [<alias-a>, <alias-b>])
PASS  each notion connection is a different account  (2 connection(s))
PASS  unnamed notion write is refused (MCP execute_action, no connectionName)  (ok=false authorization_failed)
PASS  notion write to connectionName "default" is refused  (ok=false connection_not_found)
PASS  no default slack connection  (200 2 connection(s): [<alias-c>, <alias-d>])
PASS  each slack connection is a different account  (2 connection(s))
PASS  unnamed slack write is refused (MCP execute_action, no connectionName)  (ok=false authorization_failed)
PASS  slack write to connectionName "default" is refused  (ok=false connection_not_found)
PASS  no default gmail connection  (200 2 connection(s): [<alias-e>, <alias-f>])
PASS  each gmail connection is a different account  (2 connection(s))
PASS  unnamed gmail write is refused (MCP execute_action, no connectionName)  (ok=false authorization_failed)
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
| `OOMOL_CONNECT_ALLOWED_ACTIONS` | `notion.*,slack.*,gmail.*` | Only Notion, Slack and Gmail actions run. Another provider's action: `400 action_not_allowed`. |
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

- `execute_action` with no `connectionName` fails before any request leaves the Worker (`ok:false`). Upstream's
  message is misleading ("Configure notion credentials first.", `authorization_failed`); an upstream issue is
  drafted in [the Notion spike](spikes/notion-provider.md) (U1).
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

  Filters: `limit` (1–100, default 50), `service`, `actionId`, `caller` (`http`, `mcp`, `web`), `ok` (`true`,
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

   This does not help claude.ai: its OAuth key covers every connection, and claude.ai cannot add a second
   connector with the same URL.
3. **Deployment-wide:** put explicit read action ids in `OOMOL_CONNECT_ALLOWED_ACTIONS` instead of `slack.*`.
   That makes the provider read-only for every account.
