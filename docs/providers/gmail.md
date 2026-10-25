# Gmail

SplitMind reaches each Gmail account through **one Google Cloud OAuth client** that you own. Every account you sign in
with becomes a **named connection** in OpenConnector, and Claude picks the mailbox by passing that name as
`connectionName`. Unlike Slack, one client serves every account: Google has no per-app throttle to avoid.

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<origin>` | Your Worker's public origin, the same value as `OOMOL_CONNECT_ORIGIN`, e.g. `https://<your-worker>.workers.dev` |
| `<mailbox-alias>` | The connection name you choose for an account, e.g. `personal` or `work`. Letters, digits, `_` and `-`, up to 64 characters. |

## What SplitMind uses

- **Provider:** `gmail` (display name "Gmail", upstream `src/providers/gmail/definition.ts`). OAuth 2.0 with
  `access_type=offline` and `prompt=consent`, so every connection gets a refresh token.
- **Scopes:** the provider's four defaults: `gmail.readonly`, `gmail.modify`, `gmail.labels` and
  `gmail.settings.basic`. `gmail.modify` covers reading, labelling, trashing, drafting and sending; it cannot delete
  mail permanently. `gmail.settings.basic` is there for filters.
- **Action allowlist entry:** `gmail.*`, minus these, which `OOMOL_CONNECT_BLOCKED_ACTIONS` refuses on every account:

  | Blocked | Why |
  |---|---|
  | `gmail.update_vacation_settings` | An auto-reply mails everyone who writes to you. |
  | `gmail.update_imap_settings`, `gmail.update_pop_settings` | Opens or closes mailbox access for other clients. |
  | `gmail.update_language_settings` | No use to Claude. |
  | `gmail.stop_watch` | Belongs to triggers, which SplitMind doesn't use. |

  Everything else runs: search, read, labels, drafts, send, reply, trash and untrash, and filters. Filters stay
  allowed because labelling plus-addressed mail by filter is a normal chore to hand to Claude. A filter can forward
  only to an address already verified in that mailbox's settings, and SplitMind cannot add one (that needs
  `gmail.settings.sharing`, which it doesn't request).
- **Attachments:** `gmail.download_attachment` stores the attachment as a transit file and returns its
  `downloadUrl`. Upstream only supports this on a streaming backend, so SplitMind carries
  [patch 0003](../../patches/README.md) for its KV backend. Limits:
  - **Size:** 10 MiB (`OOMOL_CONNECT_TRANSIT_FILE_MAX_BYTES`). A larger one fails with `413`.
  - **Workers Free CPU:** decoding costs about 4.5 ms of CPU per MiB, measured on Node. Under Free's 10 ms
    limit, expect attachments above about 1–2 MiB to fail with Cloudflare error 1102 (exceeded CPU). Workers Paid
    handles the full 10 MiB.
  - **Who can fetch it:** the `downloadUrl` (`<origin>/api/files/<random id>`) needs no token. Anyone holding the
    link can download the file until it expires an hour later (`OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS`).
  - **Getting it to Claude:** Claude Code can `curl` the link. On claude.ai, Claude sees the file's name, type and
    size, but may not be allowed to fetch the link; open it yourself in that case.
- **Catalog cost on Workers Free:** Gmail adds about 108 KB to the trimmed catalog chunk (144 KB to 252 KB for all
  three providers) and about 0.7 ms of JSON parsing on a cold start, measured locally. The Worker bundle doesn't
  change: provider code ships in it either way.

## Server settings

Set once per deployment in the wrangler config:

```jsonc
"vars": {
  "OOMOL_CONNECT_ALLOWED_ACTIONS": "notion.*,slack.*,gmail.*",
  "OOMOL_CONNECT_BLOCKED_ACTIONS": "gmail.update_vacation_settings,gmail.update_imap_settings,gmail.update_pop_settings,gmail.update_language_settings,gmail.stop_watch",
  "OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH": "slack,gmail",
  "OOMOL_CONNECT_BLOCKED_PROXIES": "*"
}
```

`gmail` in `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH` is only for the Workspace case [below](#a-google-workspace-account);
the normal path uses the deployment-wide client.

## Create the Google Cloud OAuth client (once)

Use the Google account you want to own the project. It doesn't have to be one of the mailboxes.

1. **Project.** In the [Google Cloud console](https://console.cloud.google.com/), create a project, e.g.
   `splitmind`.
2. **Enable the Gmail API.** APIs & Services → Library → **Gmail API** → **Enable**.
3. **Branding.** Google Auth Platform → **Branding**: app name `SplitMind`, your support email, your developer
   contact email. Under **App domain**, set the home page to `<origin>` and the privacy policy link to
   `<origin>/privacy/`, the policy `npm run deploy` serves from `web/privacy/`. Google keeps **Publish app**
   (step 4) greyed out for Gmail's restricted scopes until the app has a privacy policy link. If Google asks
   for an authorized domain, add your Worker's host (`<your-worker>.workers.dev`). Leave the logo empty.
4. **Audience.** Google Auth Platform → **Audience**: user type **External**. Then click **Publish app** so the
   status reads **In production**. Do not stay in **Testing**: there, a test user's authorization (refresh token
   included) expires seven days after consent, and every account would need reconnecting weekly.
   You don't need to submit for verification. Unverified, the app shows a "Google hasn't verified this app" screen on
   each connect, and it is capped at 100 users over the project's lifetime, which a personal deployment won't reach.
   ([Manage app audience](https://support.google.com/cloud/answer/15549945))
5. **Data access.** Google Auth Platform → **Data access** → **Add or remove scopes**, and add `gmail.readonly`,
   `gmail.modify`, `gmail.labels` and `gmail.settings.basic`. This only fills the consent screen; the Worker asks
   for the scopes itself.
6. **Client.** Google Auth Platform → **Clients** → **Create client**: type **Web application**, name `SplitMind`,
   **Authorized redirect URIs** → add `<origin>/oauth/callback` exactly, with no trailing slash. Create it, and keep
   the **Client ID** and **Client secret** at hand for the next step. Do not paste them into chat, issues, or files in
   the repo.
7. **Give the Worker the client.** Open `<origin>/setup/`, sign in with the admin token, and paste the Client ID and
   secret on the Gmail card (or use the Web Console's **Providers → Gmail**). The Console stores the secret encrypted.

## Connect each account

**Shortcut:** on `<origin>/setup/`, type the mailbox's nickname and click **Connect a mailbox**. The page always asks
Google for the account chooser (`prompt=select_account consent`), so step 1 below isn't needed there; pick the
mailbox you mean, then continue at step 3. See the [setup page guide](../setup/connect-accounts.md).

Repeat for every mailbox.

1. **Open a private browser window** signed in to no Google account, or one signed in only to the mailbox you are
   connecting. Google may otherwise pick the account the browser is already using, and you would store the same
   mailbox under a second alias. (`npm run verify` fails if that happens: "each gmail connection is a different
   account".)
2. In the Console, **Providers → Gmail**: set **Connection name** to `<mailbox-alias>`. **Never leave it blank**: a
   blank name creates the `default` connection, and SplitMind must have no default Gmail connection so that a send
   with no mailbox named fails instead of going out from whichever account is default.
3. Keep the default scope selection and connect. Sign in to the mailbox, click **Advanced → Go to SplitMind
   (unsafe)** on the unverified-app screen (it's your own app), and allow every requested permission.
4. **Check it.** In **Saved connections**, `<mailbox-alias>` shows the mailbox's email address. From Claude,
   `list_connections` with service `gmail` should list it. Then run `npm run verify`.

### Connecting through the API instead of the Console

```bash
curl -s -X POST "<origin>/api/oauth/authorizations" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"service":"gmail","connectionName":"<mailbox-alias>"}'
```

Open the returned `authorizationUrl` in the private window and approve.

### A Google Workspace account

A Workspace admin can block unverified third-party apps. If the work mailbox's consent ends in "access blocked" or
"admin approval required", either ask the admin to trust the client ID (Admin console → Security → Access and data
control → API controls → **Manage third-party app access**), or, if you administer that Workspace, create a second
OAuth client in a Cloud project inside that organization with user type **Internal** (no unverified screen, no
seven-day limit) and use it for that one connection: in the Console set **OAuth app** to **Custom App** and paste
that client's ID and secret while connecting. The connection keeps its own client for refreshes.

### A read-only mailbox

When connecting, tick only `gmail.readonly`. Google then refuses every write for that mailbox, whatever SplitMind
allows ([guardrails](../guardrails.md#5-read-only-accounts-e64)).

## Using it from Claude

- `list_connections` with `service: "gmail"` lists each `connectionName` with its email address.
- `execute_action` with `actionId: "gmail.<action>"` and `connectionName: "<mailbox-alias>"` runs in that mailbox.
  Every result names the connection it used.

| Need | Action |
|---|---|
| Which mailbox is this | `gmail.get_profile` |
| Search | `gmail.search_threads` (Gmail search syntax, e.g. `from:<sender> newer_than:7d`) |
| Read | `gmail.fetch_message_by_thread_id`, `gmail.get_message` |
| List | `gmail.list_threads`, `gmail.fetch_emails` |
| Draft (safest write) | `gmail.create_draft`, `gmail.update_draft`, `gmail.send_draft` |
| Send / reply | `gmail.send_email`, `gmail.reply_to_thread` |
| Labels | `gmail.list_labels`, `gmail.create_label`, `gmail.modify_thread_labels` |
| Trash | `gmail.move_thread_to_trash`, `gmail.untrash_thread` |
| Filters | `gmail.list_filters`, `gmail.create_filter`, `gmail.delete_filter` |

Ask Claude to draft rather than send when it matters: drafts appear in that mailbox's Gmail for you to review.

## Removing an account

Delete the `<mailbox-alias>` connection in the Console (Providers → Gmail → Saved connections). Then, signed in to
that mailbox, remove SplitMind at <https://myaccount.google.com/connections>, which revokes its refresh token.
