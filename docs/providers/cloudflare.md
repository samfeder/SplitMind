# Cloudflare

SplitMind turns on two of upstream's Cloudflare providers, each connected with a **Cloudflare API token**:

| Provider id | What Claude can do | Token template |
|---|---|---|
| `cloudflare_dns` | List zones, read, create, update and delete DNS records | **Edit zone DNS** (Zone Read + DNS Edit) |
| `cloudflare_worker` | List, read, create, edit and delete Workers and their scripts, settings and secrets; Workers Builds | **Edit Cloudflare Workers**, plus Workers Builds Configuration Edit for builds |

Each token becomes a **named connection**, and Claude picks the account by passing the connection's name. Upstream
also supports Cloudflare OAuth for these providers; SplitMind uses tokens because they need no OAuth app and can be
scoped to exact accounts and zones.

> Every value in `<angle brackets>` is a placeholder. Never commit real tokens, account ids, zone ids or your Worker
> URL.

## Before you start

- SplitMind is deployed and `<origin>/setup/` opens (see the [setup page guide](../setup/connect-accounts.md)).
- The action allowlist includes them: `OOMOL_CONNECT_ALLOWED_ACTIONS` contains `cloudflare_dns.*` and
  `cloudflare_worker.*`.

## Connect each account

1. In Cloudflare, open **My Profile → API Tokens → Create Token** and start from the template in the table above.
   Narrow **Account Resources** and **Zone Resources** to what Claude should touch. For read-only DNS, use Zone Read
   and DNS Read instead.
2. On `<origin>/setup/`, in the matching card, type a nickname such as `<alias-a>` and paste the token.
   **Cloudflare Workers** also needs the account ID (32 hex characters, from **Workers & Pages → Account details**).
   Click **Connect an account**. The Worker checks the token with Cloudflare before it stores it, encrypted.
3. Repeat for each other Cloudflare account with its own nickname. DNS and Workers are separate connections, so the
   same account can use one token for both or a narrower token for each.

## Careful with SplitMind's own account

If SplitMind itself runs in an account you connect, Claude can edit or delete the SplitMind Worker and its secrets
through `cloudflare_worker`. Scope the token to other accounts, or grant read-only access on the MCP consent page
([Claude setup](../claude.md)), unless you mean to let Claude manage it.

## Check it

Ask Claude: "List my Cloudflare DNS connections." Each nickname should appear. `npm run verify` checks there's no
`default` connection for either provider and that a write naming no account is refused.

## Not turned on

Upstream also has `cloudflare_r2`, `cloudflare_email_routing`, `cloudflare_browser_rendering`, `cloudflare_docs` and
`cloudflare_mcp` (Cloudflare's own MCP server, which runs code against the whole API). Turning one on is the same
three steps as [adding a provider](../adding-a-provider.md), plus an entry in `TOKEN_PROVIDERS` in
`web/setup/setup.js` for its token fields.
