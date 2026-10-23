# E3 test plan: Claude connector

Covers E3.1–E3.5. Prerequisite for all: E2.2 is done (Worker deployed, D1 migrated, `OAUTH_KV` bound, `OOMOL_CONNECT_ORIGIN` set, admin token and encryption key entered by Sam) and R1 is passed. Background and code references: [`docs/research/claude-oauth-2026-10-23.md`](../research/claude-oauth-2026-10-23.md). Written 2026-10-23 against OpenConnector v1.9.2.

**Placeholders.** `<origin>` is the Worker's public origin, for example `https://<worker-name>.<account-subdomain>.workers.dev`, with no trailing slash. Never paste the real value into the repo, issues or CI logs.

**Secrets.** The admin token is read into the shell with `read -rs`, never typed on a command line or echoed. Evidence pastes never include tokens, the origin, workspace names, emails or `profile` / `providerAccountId` values; replace them with `<redacted>`.

**Expected values below are literals** taken from Claude's docs, upstream code constants or this plan, not from running the code under test.

**Order.** Run E3.1–E3.3 with stock MCP OAuth behavior, so a failure is attributable: either without patch 0002, or with it and **none** of the `OOMOL_CONNECT_MCP_OAUTH_*` variables set (unset, the patch changes nothing). Set those variables only at the decision points in E3.3 and E3.5.

---

## E3.1 Server-side OAuth checks

### Step 1. Upstream's suite

Run from the OpenConnector submodule. Whoever runs it, Sam types the admin token:

```bash
cd vendor/open-connector
read -rs MCP_TEST_ADMIN_TOKEN && export MCP_TEST_ADMIN_TOKEN    # Sam pastes the admin token; nothing echoes
MCP_TEST_ORIGIN='<origin>' python3 scripts/test-mcp-oauth.py; echo "exit $?"
unset MCP_TEST_ADMIN_TOKEN
```

Expected:
- Every line starts with `PASS`. There are no `FAIL` lines.
- The last three lines are, in order:
  - `PASS all MCP OAuth integration checks`
  - `PASS cleanup of test runtime tokens`
  - `PASS anonymous runtime API remains protected after cleanup`
- Then `exit 0`.
- Afterwards, the Web Console's API Keys list has no key containing `OAuth Integration Test`.

The script uses ChatGPT's redirect, so it proves the server, not the claude.ai path. Step 2 adds the claude.ai-specific checks.

### Step 2. claude.ai-specific discovery checks

These need no secrets.

```bash
O='<origin>'
curl -s "$O/.well-known/oauth-protected-resource/mcp" | jq -c '{resource, authorization_servers, scopes_supported}'
curl -s "$O/.well-known/oauth-authorization-server" | jq -c '{issuer, cimd: .client_id_metadata_document_supported, none: (.token_endpoint_auth_methods_supported | index("none") != null), pkce: .code_challenge_methods_supported, scopes: .scopes_supported, revocation_is_token: (.revocation_endpoint == .token_endpoint)}'
curl -s -o /dev/null -D - -X POST "$O/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -i -E '^HTTP/|^www-authenticate:'
```

Expected, with `<origin>` substituted:

```
{"resource":"<origin>/mcp","authorization_servers":["<origin>"],"scopes_supported":["mcp:access"]}
{"issuer":"<origin>","cimd":true,"none":true,"pkce":["S256"],"scopes":["mcp:access","offline_access"],"revocation_is_token":true}
HTTP/2 401
www-authenticate: Bearer … resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp" …
```

- `cimd: true` together with `none: true` is what makes claude.ai pick CIMD, per Claude's authentication docs.
- If `cimd` is `false`, the `global_fetch_strictly_public` compatibility flag is missing from the wrangler config. Claude then falls back to DCR. That still works, but say so in the evidence.

### Step 3. Claude's callback accepted, and latency

Again no secrets. This registers a throwaway DCR client with Claude's callback, opens consent, and does not approve.

```bash
CID=$(curl -s -X POST "$O/oauth/mcp/register" -H 'content-type: application/json' \
  -d '{"client_name":"E3.1 claude callback probe","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}' | jq -r .client_id)
curl -s -o /tmp/consent.html -w '%{http_code} %{time_total}\n' "$O/oauth/mcp/authorize?response_type=code&client_id=$CID&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&scope=mcp%3Aaccess%20offline_access&resource=$(jq -rn --arg r "$O/mcp" '$r|@uri')&state=probe&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
grep -o 'Authorization returns to <strong>[^<]*' /tmp/consent.html
```

Expected:
- `200`, followed by a time under `10` seconds. Claude allows 10 seconds for discovery, registration and token calls, and 30 for refresh.
- `Authorization returns to <strong>claude.ai`

Also time a cold start, the first request after about 10 minutes idle:

```bash
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$O/health"
```

- An invalid bearer on `/mcp` is rejected before the app loads, so it would not measure this. `/health` goes through the same app creation (catalog load) that an authenticated `/mcp` pays.
- Record the number. Above about 5 s is a risk for claude.ai's first `tools/list`; record it on E2.1 (#7).

**Done when** steps 1–3 all match, with the outputs pasted into the E3.1 issue.

---

## E3.2 claude.ai web, then mobile and desktop

### Sam steps: web

These follow a Pro or Max account. On Team or Enterprise, an Owner adds it under **Organization settings > Connectors > Add > Custom > Web**, then connects as a member.

1. Open **Customize > Connectors** (`https://claude.ai/customize/connectors`) and click **Add custom connector**.
2. **Name:** `SplitMind`.
3. **MCP server URL:** `<origin>/mcp`, exactly. No trailing slash and no query string: Claude requires the metadata's `resource` to equal the entered URL.
4. If the dialog shows these settings:
   - **Authentication:** choose **Sign in now**.
   - **OAuth client:** choose **Use Claude's published identity**.
   - Leave **Request headers** empty and **Advanced > Transport** unchanged.
   - In the one-screen layout, leave **Advanced settings** (client ID and secret) blank.
5. Click **Add**, then **Connect** on the new connector.
6. A window opens on the SplitMind consent page. Before typing anything, check:
   - The title is `Allow Claude to use your gateway?`, or another client name; record it.
   - It shows `Client domain: claude.ai` (the CIMD path). If it says `This client's name is self-reported and has not been verified.`, Claude used DCR. Both work, but record which.
   - It shows `Authorization returns to claude.ai`.
7. Paste the admin token from the password manager into **Administrator token** and click **Allow access**.
8. The window returns to Claude, and the connector shows as connected. **Record the time: this is T0 for E3.3.**

### Checks: web

Expected literals:
- **Tool list.** Open the connector under **Customize > Connectors**. It lists exactly five tools: `list_apps`, `list_connections`, `search_actions`, `get_action_guide`, `execute_action`. The prompt said four; five is correct (see findings).
- **Tool call.** In a new chat, open **+ > Connectors**, turn on **SplitMind**, and send: `Call the SplitMind list_connections tool with no arguments and show me the raw JSON it returned.`
  - Before any E4/E5 connection exists, expected: `{"ok": true, "data": []}`.
  - After connections exist: one object per connection with `id`, `service`, `connectionName`, `authType`, `default`, `profile`. Redact `profile` in evidence.
- **Backing key.** In the Web Console, **API Keys** shows exactly one new key whose name starts with `MCP OAuth • `. Record the suffix, which is Claude's client name.

Server-side evidence:

```bash
npx wrangler tail <worker-name> --format pretty
```

Run this before step 5. Expected sequence:
1. `POST /mcp` 401
2. `GET /.well-known/oauth-protected-resource/mcp` 200
3. `GET /.well-known/oauth-authorization-server` 200
4. `GET /oauth/mcp/authorize` 200
5. `POST /oauth/mcp/authorize` 302
6. `POST /oauth/mcp/token` 200
7. `POST /mcp` 200, several times

If the sequence stops after step 5, that is the #215 / #1110 pattern. Redact query strings when pasting.

### Mobile and desktop

Same account, no re-adding. Custom connectors share one backend across web, Desktop and mobile, per Claude's docs.

1. **Claude Desktop:** new chat, **+ > Connectors**, turn on **SplitMind**, send the same prompt. Expected: the same JSON as on web, with no new consent page and no new `MCP OAuth •` key.
2. **Claude mobile (iOS or Android):** same as Desktop.

**Done when** all of the above match, with screenshots (origin and account redacted) and the tail excerpt pasted into the E3.2 issue. Stop at **R2** and report.

### Failure handling (tripwire: two distinct failed fixes)

| Symptom | First thing to check |
|---|---|
| "Couldn't reach the MCP server" | Step 2's `www-authenticate`; the `resource` equals the entered URL |
| Consent approved, no `POST /oauth/mcp/token` in tail | #215 / #1110 pattern. Retry once after 15 minutes. Then try the DCR path: remove the connector, re-add with **OAuth client: Register automatically** |
| Token 200, but the connector shows **Connect** again | #1110. Note the reference ID Claude shows, if any |
| Requests blocked before the Worker | Only on a custom domain: Cloudflare **Bot Fight Mode / Block AI bots** (#430); Anthropic egress is `160.79.104.0/21` |

**Fallback after two failures:** check whether **Add custom connector** shows a **Request headers** section (beta). If it does, the alternative is **No sign-in**, plus header `authorization` with value `Bearer <runtime token>`, using a token made as in E3.4. Report this to Sam as a decision rather than doing it silently: it changes how claude.ai authenticates.

---

## E3.3 Token lifetime (more than 1 hour, more than 24 hours)

Stock lifetimes are 1-hour access tokens and a 30-day **fixed** grant. Claude's docs say it refreshes "proactively up to five minutes before the stored expiry" and "reactively on a 401".

Don't touch the connector between checks. Use the same prompt as E3.2.

| Check | When | Expected |
|---|---|---|
| A | T0 + 65 min (after the first access token expired) | The tool call returns the same JSON. No **Connect** prompt, no consent page, no new `MCP OAuth •` key |
| B | T0 + 25 h | Same as A |
| C | Optional: T0 + 30 days + 1 h | Stock: Claude asks to connect again. That is expected (fixed grant), not a bug |

Server evidence for A, either kind:
- **Live:** `wrangler tail` running from about T0 + 50 min to T0 + 66 min. Expected: one `POST /oauth/mcp/token` 200 (the refresh) before the next `POST /mcp` 200, with no `POST /mcp` 401 in between if the refresh is proactive.
- **After the fact:** Workers Logs in the Cloudflare dashboard (persisted logs are on in upstream's example config). Filter `path = /oauth/mcp/token` over the window.

Record which pattern appears:
- **Proactive:** a refresh before expiry, no 401.
- **Reactive:** a `POST /mcp` 401, then a refresh, then a 200.
- **None:** a 401, and tools silently gone (#702). That is a failure.

### Decision points

- **A and B pass:** record the pattern, close E3.3. Raise with Sam whether to set `OOMOL_CONNECT_MCP_OAUTH_GRANT_IDLE_TTL_SECONDS=2592000` (sliding 30 days) via the patch, to avoid a monthly re-consent. That is a convenience-versus-security choice, so it's his.
- **A fails:**
  1. File upstream Draft 1 from `docs/upstream/mcp-oauth-issue-drafts.md`, citing claude-ai-mcp#228.
  2. Make sure patch 0002 is merged (it touches tokens, so it waits for Sam) and set `OOMOL_CONNECT_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS=86400`.
  3. Redeploy, reconnect (new T0), and rerun A at T0 + 65 min (expected pass, no refresh needed yet) and B at T0 + 25 h.
  4. If B still fails, the stopgap only moved the break to daily. Stop and report to Sam, with the Request-headers fallback as the option.

---

## E3.4 Claude Code with a restricted runtime token

Claude Code can also do OAuth itself, with its own CIMD and a loopback redirect, but E3.4 is specifically the runtime-token path.

This works with OAuth enabled: a runtime token is accepted at `/mcp` as `Authorization: Bearer oct_…`.

**When to run it.** To prove `allowedConnections` restricts something, at least two connections must exist. So run this after the first E4/E5 connections exist. Before then, only steps 2 and 3 are meaningful.

1. **Get connection IDs.** Run `list_connections` from claude.ai (E3.2) and note the `id` of each connection. Call them `<conn-A>` and `<conn-B>`.

2. **Create the token and add it to Claude Code** in one shell. The token is held in a variable and never printed:

   ```bash
   O='<origin>'
   read -rs ADMIN                                  # Sam pastes the admin token
   TOKEN=$(curl -s -X POST "$O/api/runtime-tokens" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
     -d '{"name":"Claude Code","allowedActions":["notion.*","slack.*"],"allowedConnections":["<conn-A>"]}' | jq -r .token)
   unset ADMIN
   claude mcp add --transport http --scope user splitmind "$O/mcp" --header "Authorization: Bearer $TOKEN"
   unset TOKEN
   ```

   Note for the docs: `claude mcp add` stores the header in Claude Code's user config file in plain text. Say so in `docs/claude.md`.

3. **Check it connects:**

   ```bash
   claude mcp list | grep '^splitmind'
   ```

   Expected: `splitmind: <origin>/mcp (HTTP) - ✔ Connected`

4. **Check the restriction:**

   ```bash
   claude -p 'Call the splitmind list_connections tool with no arguments and print its raw JSON result only.' --allowedTools mcp__splitmind__list_connections
   ```

   Expected: `data` has exactly one entry, with `"id": "<conn-A>"`. `<conn-B>` is absent, because `list_connections` filters by the token's grants.

5. **Check that a call outside the grant is refused:**

   ```bash
   claude -p 'Call splitmind get_action_guide with actionId "<an action of conn-B'"'"'s service>" and connectionName "<conn-B name>", and print the raw JSON result only.' --allowedTools mcp__splitmind__get_action_guide
   ```

   Expected: `"ok": false` with error `"code": "connection_not_allowed"`. That code string is defined upstream in `src/core/action-policy.ts`; this test makes no writes.

6. **Check revocation.** In the Web Console, delete the `Claude Code` API key, then run step 3 again. Expected: `splitmind` is no longer `✔ Connected`. Record the exact status text. Re-create the token afterwards if Claude Code should keep working.

**Done when** steps 2–6 match and `docs/claude.md` has a Claude Code section with placeholders only.

---

## E3.5 Restrict which OAuth clients connect

Upstream does not support this at v1.9.2 (see findings). The plan:

1. After E3.2 passes on stock, file upstream Draft 2. With patch 0002 merged (it touches auth, so it waits for Sam's approval), configure:

   ```
   OOMOL_CONNECT_MCP_OAUTH_ALLOWED_REDIRECT_URIS = https://claude.ai/api/mcp/auth_callback,http://localhost/callback,http://127.0.0.1/callback
   ```

   This is a plain var, not a secret.

2. After deploy, check a stranger is refused:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$O/oauth/mcp/register" -H 'content-type: application/json' \
     -d '{"client_name":"E3.5 stranger","redirect_uris":["https://example.invalid/cb"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}'
   ```

   Expected: `400`.

3. Rerun E3.1 step 3 (Claude's callback). Expected: still `200`, and `Authorization returns to <strong>claude.ai`.

4. Rerun the E3.2 web tool call. Expected: unchanged, and no reconnect needed. The existing grant's redirect is allowlisted.

5. Rerun E3.1 step 1. `test-mcp-oauth.py` registers a ChatGPT redirect, so with the allowlist on, expect it to **fail** at `public client registration`.
   - Either run it with `https://chatgpt.com/connector_platform/oauth_redirect` temporarily added to the allowlist, or accept and document this known incompatibility.
   - Recommendation: document it, and run the suite before enabling the allowlist.

**Done when** steps 2–4 match, the upstream issue link is in the patch header, and the incompatibility from step 5 is documented.
