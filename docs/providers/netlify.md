# Netlify

SplitMind connects each Netlify login with a **personal access token**. Netlify also offers OAuth, but it needs an
OAuth app registered per deployment for no gain when you connect your own logins, so the setup page uses tokens.
Each token becomes a **named connection** of the `netlify` provider, and Claude picks the login by passing the
connection's name.

> Every value in `<angle brackets>` is a placeholder. Never commit real tokens, site ids or your Worker URL.

## Before you start

- SplitMind is deployed and `<origin>/setup/` opens (see the [setup page guide](../setup/connect-accounts.md)).
- The action allowlist includes Netlify: `OOMOL_CONNECT_ALLOWED_ACTIONS` contains `netlify.*`.

## Connect each login

1. In Netlify, open **User settings → Applications → Personal access tokens → New access token**. Name it
   `SplitMind`, pick an expiry, and copy the token.
2. On `<origin>/setup/`, in the Netlify card, type a nickname such as `<alias-a>`, paste the token and click
   **Connect an account**. The Worker checks the token with Netlify before it stores it, encrypted.
3. Repeat for each other login with its own nickname.

A personal access token reaches every team that login belongs to and can't be narrowed, so one connection per
login is the right grain. To let Claude look but not change anything, grant it read-only access on the MCP consent
page ([Claude setup](../claude.md)).

## What Claude can do

Upstream's `netlify` provider (pinned release, `src/providers/netlify/actions.ts`): read the user and accounts, list
and read sites, deploys and builds, create sites, start builds, deploy from a zip URL, lock, unlock and cancel
deploys, and list or delete form submissions. The raw API proxy stays blocked.

## Check it

Ask Claude: "List my Netlify connections." Each nickname should appear with the login's name. `npm run verify`
checks there's no `default` Netlify connection and that a write naming no account is refused.

## Rotating or revoking

When a token expires, the connection fails with an auth error. Disconnect it on the setup page and connect again
with a new token under the same nickname. Deleting the token in Netlify cuts SplitMind off immediately.
