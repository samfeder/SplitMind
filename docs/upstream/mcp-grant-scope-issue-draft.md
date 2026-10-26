# Upstream issue draft: choose read-only access and accounts at MCP consent (2026-10-26)

**Status: draft only, not filed.** Filing is a public post from Sam's account (#37). SplitMind carries the change as
`patches/0004-mcp-oauth-consent-read-only-and-account-scope.patch` (#76). Written against OpenConnector `v1.9.2`.

---

**Title:** `feat(cloudflare): let MCP OAuth consent grant read-only access or a subset of connections`

**Body:**

> ### Problem
>
> `createMcpOAuthHandler` backs every approved MCP OAuth client with a runtime token that has
> `allowedActions: ["*"]` and `allowedConnections: []` (every connection). So an MCP client such as claude.ai can act
> as every connected account with every action the deployment allows, including sending mail or posting messages.
> With prompt injection in mind (an email the model reads asks it to send another), operators want the narrowest
> grant that does the job, and the consent page is the only place an OAuth client's grant is decided.
>
> ### Proposal
>
> Two optional fields on the consent form:
>
> - **Access:** *Read only* (default) or *Read and write*. Read only grants the catalog's actions whose
>   `operationType` is `read`; read and write keeps `["*"]`.
> - **Accounts:** empty for every connection, or nicknames: `alias` (that alias on every service) or `service:alias`.
>
> Both are resolved only after the administrator token is checked, using the administrator API
> (`/api/actions`, `/v1/connections`), so the page never shows account names to an anonymous visitor. An unknown
> nickname is refused before the consent handle is spent, so the operator can go back and correct it. Deployment
> policy still applies on top.
>
> Open question: a read-only grant stores the read action ids at approval time, so read actions added by a later
> upgrade need a new approval. An `allowedOperationTypes` field on runtime tokens would avoid that; happy to do that
> instead if you prefer a schema change.
>
> A patch with tests is ready (`src/server/cloudflare/mcp-grant-scope.ts` plus consent page and handler changes).
