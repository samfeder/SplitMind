# Slack

SplitMind reaches each Slack workspace through **its own internal Slack app**, created in that workspace from `slack/app-manifest.json`. One app is never shared across workspaces. Each workspace becomes a **named connection** in OpenConnector, and Claude picks the workspace by passing that name as `connectionName`.

Background and source references: [Slack provider spike](../spikes/slack-provider.md).

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<origin>` | Your Worker's public origin, the same value as `OOMOL_CONNECT_ORIGIN`, e.g. `https://<your-worker>.workers.dev` |
| `<workspace-alias>` | The connection name you choose for a workspace, e.g. `work` or `side-project`. Letters, digits, `_` and `-`, up to 64 characters. |

## Why one internal app per workspace

Since 29 May 2025, Slack limits **commercially distributed apps that are not in the Slack Marketplace** to 1 request per minute and 15 objects per page on `conversations.history` and `conversations.replies`. Internal customer-built apps keep Tier 3 (50+ requests per minute, up to 1,000 objects per page). A single app with public distribution turned on, installed into several workspaces, is the case that gets throttled. An app created in a workspace and installed only there is the case that does not.

Sources: [Rate limit changes for non-Marketplace apps](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/), [Clarifying rate limit changes](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/), [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/).

So, for every workspace:

- Create the app **while signed in to that workspace**, choosing that workspace as the app's development workspace.
- **Never** click "Activate Public Distribution".

If `get_channel_messages` with `limit: 100` ever comes back with at most 15 messages from a channel that has more, Slack is treating the app as distributed. Stop and recreate the app in the right workspace.

## What SplitMind uses

- **Provider:** `slack` (display name "Slack"). It authorizes a **user token** (`xoxp-…`) through `https://slack.com/oauth/v2_user/authorize`, so actions run as you, and search works. The separate `slackbot` provider uses a bot token; SplitMind does not use it, because `search.messages` needs a user token.
- **Action allowlist entry:** `slack.*`.
- **Scopes:** the manifest requests the 16 user scopes the `slack` provider selects by default, so the connection works with no scope tuning. They cover public and private channels, DMs and group DMs, users, files, reactions, posting, and legacy search. Real-time Search (`search:read.public`, `search:read.private`, used by `slack.search_context`) is left out; `slack.search_messages` covers search.
- **Token rotation:** off in the manifest. User tokens without rotation do not expire, so the connection does not depend on refresh. OpenConnector does support refresh if you turn rotation on.

To grant fewer scopes, remove them from the manifest **and** pass the same subset as `requestedScopes` when connecting (or untick them in the Console), because Slack rejects an authorization that asks for a scope the app does not declare.

## Server settings

These are set once per deployment, in the wrangler config (not secrets):

```jsonc
"vars": {
  "OOMOL_CONNECT_ORIGIN": "<origin>",
  "OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH": "slack",
  "OOMOL_CONNECT_ALLOWED_ACTIONS": "notion.*,slack.*",
  "OOMOL_CONNECT_BLOCKED_PROXIES": "*"
}
```

`OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH=slack` lets each connection carry its own Slack app's client ID and secret. It only works when the `OOMOL_CONNECT_ENCRYPTION_KEY` secret is set; otherwise connecting fails with `oauth_custom_app_encryption_required`. No deployment-wide Slack OAuth app is needed.

## Steps for each workspace

Repeat these for each workspace. They need someone who can create and install apps in that workspace; if the workspace requires admin approval for apps, the install becomes a request that a workspace admin must approve.

1. **Get the manifest.** Run `npm run -s slack-manifest | pbcopy` (macOS; elsewhere drop `| pbcopy` and copy the output). It prints `slack/app-manifest.json` with the redirect URL filled in from your deployment, `https://<your-worker>.workers.dev/oauth/callback`, and writes nothing to disk. Pass `-- --origin <origin>` if you deployed from another machine.
2. **Create the app.** Go to <https://api.slack.com/apps>, click **Create New App → From a manifest**, pick the workspace this app is for, paste the manifest, and click **Create**.
3. **Do not distribute.** Leave **Manage Distribution** alone.
4. **Copy the credentials.** Under **Basic Information → App Credentials**, keep the **Client ID** and **Client Secret** at hand for step 6. Do not paste them into chat, issues, or files in the repo.
5. **Open the Console.** Open `<origin>` and sign in with the admin token. Go to **Providers → Slack**.
6. **Connect with this workspace's app.**
   - Set **OAuth app** to **Custom App**, and paste the Client ID and Client Secret.
   - Set **Connection name** to `<workspace-alias>`. **Never leave it blank**: a blank name creates the `default` connection, and SplitMind must have no default Slack connection so that a write without a workspace name fails instead of landing somewhere by accident.
   - Keep the default scope selection, then connect.
   - Slack shows its consent screen for this workspace. Approve it. If the workspace requires admin approval, Slack asks for it here; finish this step after the admin approves.
7. **Check it.** In **Saved connections**, the new `<workspace-alias>` connection shows the workspace's name. From Claude, `list_connections` with service `slack` should list it.

The connection keeps its own app's client ID and secret (encrypted) for any later token refresh. The callback URL is the same `<origin>/oauth/callback` for every workspace.

### Connecting through the API instead of the Console

The Console is preferred because the secret never goes through your shell history. The equivalent API call is:

```bash
curl -s -X POST "<origin>/api/oauth/authorizations" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d @slack-connect.json   # {"service":"slack","connectionName":"<workspace-alias>","clientId":"…","clientSecret":"…"}
```

Open the returned `authorizationUrl` in a browser and approve. Delete `slack-connect.json` afterwards.

## Using it from Claude

- `list_connections` with `service: "slack"` lists each workspace's `connectionName` and its display name (the workspace name).
- `execute_action` with `actionId: "slack.<action>"` and `connectionName: "<workspace-alias>"` runs the action in that workspace.

| Need | Action |
|---|---|
| Who am I, in which workspace | `slack.get_current_user` |
| Search messages | `slack.search_messages` |
| List channels | `slack.list_channels` (public), `slack.list_conversations` (all types) |
| Channel history | `slack.get_channel_messages` (up to 999 per page) |
| Thread replies | `slack.get_thread` |
| Post / reply | `slack.post_message`, `slack.reply_message` |
| Delete own post | `slack.delete_message` |
| React | `slack.add_reaction`, `slack.remove_reaction` |

## Removing a workspace

Delete the `<workspace-alias>` connection in the Console (Providers → Slack → Saved connections). Then, in Slack, remove the app from the workspace (or delete the app at <https://api.slack.com/apps>), which revokes its tokens.
