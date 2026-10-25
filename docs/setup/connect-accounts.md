# Connect accounts from the setup page

The Worker serves a setup page at `<origin>/setup/`. It is the shortest way to add accounts: for each provider you
type a nickname, click **Connect**, and finish on the provider's own sign-in screen. The page uses the Web Console's
API and the same admin sign-in, so nothing new is exposed.

> Placeholders: `<origin>` is your Worker's public origin, the value of `OOMOL_CONNECT_ORIGIN`.

## What still has to be done by hand, and why

Every provider needs an OAuth app that belongs to you before any account can sign in to SplitMind. That app holds
the client ID and secret the Worker uses, and the providers only let you create it while signed in to their
developer sites.

| Provider | Done by hand | How often | Why it can't be automated |
|---|---|---|---|
| Gmail | Create a Google Cloud project and a Web OAuth client | Once per deployment | Google has no public API for creating OAuth clients for a consent screen |
| Notion | Create a public connection in Notion's developer portal | Once per deployment | Notion has no API for creating connections |
| Slack | Generate an app configuration token on api.slack.com | Once per workspace | The page creates the app from it, but only Slack's site issues the token. One app per workspace keeps Slack's higher rate limits ([why](../providers/slack.md#why-one-internal-app-per-workspace)) |

After that, each account is a nickname plus **Connect**. The setup page shows the exact steps and the redirect URI
to copy while an app is missing.

## Using the page

1. Open `<origin>/setup/` and sign in with the admin token, if the browser isn't signed in to the Web Console already.
2. **Gmail and Notion, once:** follow the steps on the card, paste the client ID and secret, and click **Save**.
   The secret is stored encrypted, like a secret saved from the Web Console's provider page.
3. **Each account:** type a nickname (`home`, `work`, …) and click **Connect**.
   - **Gmail** always shows Google's account chooser, so pick the mailbox you mean. A private window is no longer
     needed. On the unverified-app screen click **Advanced → Go to SplitMind**: it's your own app.
   - **Notion** asks which workspace and which pages to share. Share only what Claude should see. You can add pages
     later from a page's **••• → Connections**.
   - **Slack** also needs a configuration token: on <https://api.slack.com/apps>, under **Your App Configuration
     Tokens**, click **Generate Token**, pick the workspace, and copy the **Access Token**. The page sends it straight
     from your browser to Slack's `apps.manifest.create`, which creates a SplitMind app in that workspace from
     `slack/app-manifest.json`. It then starts the install with that app. The token is used once and never sent to
     the Worker or stored.
4. The card updates by itself when the provider sends you back. Each account shows its nickname and the account name
   the provider reported.

The page refuses the nickname `default` and blank names, so no account ever becomes a hidden default
([guardrails](../guardrails.md)).

## If the Slack app can't be created from the page

If your browser blocks the call to Slack, or you'd rather create the app yourself, follow
[Steps for each workspace](../providers/slack.md#steps-for-each-workspace), then open **Already made the Slack app
yourself?** on the Slack card and paste its client ID and secret with the nickname.

## How the page is deployed

`scripts/deploy.ts` copies `web/setup/` and `slack/app-manifest.json` into the Web Console build (`dist/web/setup/`),
so `npm run deploy` publishes it as a static asset. The page loads no third-party code, and keeps no token in browser
storage. Its helpers are tested in `tests/setup-page.test.ts`.

The same build step copies `web/privacy/` to `dist/web/privacy/`. That is the privacy policy, served at
`<origin>/privacy/`, which Google's Branding page needs before it lets the Gmail app go to production. `npm run verify`
checks that both pages are served.
