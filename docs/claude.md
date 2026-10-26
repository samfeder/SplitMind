# Use SplitMind from Claude

SplitMind is one MCP server at `<origin>/mcp`. Add it once and every connected account is reachable through it.
Claude picks the account with the connection's alias.

> `<origin>` is your Worker's URL, e.g. `https://<your-worker>.workers.dev`. Placeholders are in angle brackets.

## claude.ai on the web

On a Pro or Max plan (on Team or Enterprise, an Owner adds it first under **Organization settings → Connectors →
Add → Custom → Web**, then each member connects):

1. Open **Customize → Connectors** and click **Add custom connector**.
2. **Name:** `SplitMind`. **MCP server URL:** `<origin>/mcp`, exactly: no trailing slash, no query string.
3. If the dialog asks: **Authentication** → **Sign in now**; **OAuth client** → **Use Claude's published identity**.
   Leave request headers, transport and client ID/secret blank.
4. Click **Add**, then **Connect**.
5. A SplitMind consent page opens. Check it says `Client domain: claude.ai` and `Authorization returns to
   claude.ai`. Choose **Access**: *Read only* (the default: Claude can search and read but never send, post, change
   or delete) or *Read and write*. Under **Accounts**, leave it empty for every account, or list nicknames such as
   `work, slack:team` (`slack:team` means only the Slack account named `team`). Paste your **admin token** and click
   **Allow access**. To change the choice later, delete the key (below) and connect again.
6. Back in Claude, the connector shows as connected. In a chat, turn it on in the tools menu and ask:
   "Use SplitMind's list_connections."

You should see the five tools (`list_apps`, `list_connections`, `search_actions`, `get_action_guide`,
`execute_action`) and your connections by alias.

**What the approval creates:** an API key named `MCP OAuth • <client name>` in the Web Console (API Keys). Deleting
it revokes Claude's access immediately. Access tokens last 1 hour and Claude refreshes them; the grant lasts 30 days,
after which Claude asks you to connect again.

## Desktop and mobile

Connectors added on claude.ai sync to the Claude desktop and mobile apps for the same account. Open a chat, turn on
SplitMind in the tools menu and ask for `list_connections`. If the app shows **Connect**, tap it and approve the
consent page as above.

## Claude Code

Claude Code can send a header, so it uses a **runtime token** instead of OAuth. A token can be limited to some
connections and actions, which suits a coding agent.

1. Find the ids of the connections Claude Code may use: run `list_connections` from claude.ai, or open the Web
   Console's connections list. Call them `<conn-id-a>`, ….
2. Create the token and add the server in one shell. The token stays in a variable and is never printed:

   ```bash
   O='<origin>'
   read -rs ADMIN                    # paste the admin token, then Enter
   TOKEN=$(curl -s -X POST "$O/api/runtime-tokens" \
     -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
     -d '{"name":"Claude Code","allowedActions":["notion.*","slack.*","gmail.*"],"blockedActions":[],"allowedProxies":[],"allowedConnections":["<conn-id-a>"]}' \
     | jq -r .token)
   unset ADMIN
   claude mcp add --transport http --scope user splitmind "$O/mcp" --header "Authorization: Bearer $TOKEN"
   unset TOKEN
   ```

3. Check it:

   ```bash
   claude mcp list | grep '^splitmind'
   # splitmind: <origin>/mcp (HTTP) - ✔ Connected
   ```

- Omit `allowedConnections` (or pass `[]`) to allow every connection.
- For a read-only token, list only read action ids; see [guardrails](guardrails.md#5-read-only-accounts-e64).
- `claude mcp add` stores the header in Claude Code's config file (`~/.claude.json`) **in plain text**. Treat that
  file as a secret. To revoke, delete the token in the Web Console, then `claude mcp remove splitmind`.

Tested against a local Worker on 2026-10-23 (Claude Code 2.1.309): `splitmind-local: http://localhost:8787/mcp
(HTTP) - √ Connected`.

## Talking to it

- Name the account: "In `<alias-a>`, search Notion for …", "Post in `<alias-c>`'s `#<channel>` …". Claude passes
  the alias as `connectionName`.
- A write that names no account fails on purpose ([guardrails](guardrails.md#2-writes-must-name-an-account-decision-8-e61)).
  Claude can recover by calling `list_connections` and asking you which account to use.
- Every result says which account it ran as (`connection.connectionName` and `profile.displayName`).

## Troubleshooting

| Symptom | Check |
|---|---|
| "Couldn't reach the MCP server" | The URL is exactly `<origin>/mcp`; `npm run verify` passes. |
| Consent approved, but Claude still shows **Connect** | Known claude.ai issue (anthropics/claude-ai-mcp #215, #313). Remove the connector, wait 15 minutes, add it again. |
| Tools vanish after about an hour | Claude did not refresh the token (anthropics/claude-ai-mcp #228). See issue #15 for the longer-lifetime setting in patch 0002. |
| "A server with this URL already exists" | You already added SplitMind. You only need one; all accounts are behind it. |
| Consent page says "This client is not allowed." | The client's callback isn't in `OOMOL_CONNECT_MCP_OAUTH_ALLOWED_REDIRECT_URIS` (`wrangler.template.jsonc`). Only Claude's callbacks are listed; add another client's documented callback there and redeploy. |
| "Configure slack credentials first." (or notion, gmail) | The call named no account. The connection is fine: ask Claude to use `list_connections` and pass the account as `connectionName`. Patch 0005 replaces this message with `connection_required`. |
| Claude Code: `✘ Failed to connect` | The token was deleted or mistyped. Create a new one (step 2). |
