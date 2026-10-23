# Upstream issue drafts: MCP OAuth (2026-10-23)

**Status: drafts only, not filed.** File them only when E3.3 (#15) or E3.5 (#17) calls for it; see [`docs/research/claude-oauth-2026-10-23.md`](../research/claude-oauth-2026-10-23.md), "Recommendation". Once filed, put the link in the first lines of `patches/0002-…patch`.

Both drafts reference OpenConnector `v1.9.2` (`2748be7`). Before filing, re-check `main`, since the MCP OAuth code is new (#757, #762) and may already have moved.

---

## Draft 1: Configurable MCP OAuth token lifetimes (Cloudflare)

**Title:** `feat(cloudflare): make MCP OAuth access-token and grant lifetimes configurable`

**Body:**

> ### Problem
>
> The Cloudflare MCP OAuth handler hard-codes its lifetimes (`src/server/cloudflare/mcp-oauth.ts`, `accessTokenTTL: 3600` and `refreshTokenTTL: 30 * 86400`). Operators can't tune them, and some MCP clients have trouble with them:
>
> - **Clients that don't refresh reliably.** claude.ai custom connectors have an open report of never refreshing ([anthropics/claude-ai-mcp#228](https://github.com/anthropics/claude-ai-mcp/issues/228)). With a 1-hour access token, the connection breaks every hour until the user reconnects. Claude's current docs say it refreshes proactively and on a 401, and some reporters now see that working, so this is client-dependent. Operators need a lever while it settles.
> - **A fixed grant forces re-consent every 30 days.** Without `refreshTokenIdleTTL`, a grant expires 30 days after sign-in, however actively it is used. A single-administrator gateway may prefer a sliding lifetime, so only an unused grant expires.
>
> ### Proposal
>
> Three optional Worker settings, read in `src/server/cloudflare.ts` and passed to `createMcpOAuthHandler`. Unset, behavior is unchanged.
>
> | Variable | Default | Maps to |
> |---|---|---|
> | `OOMOL_CONNECT_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | `accessTokenTTL` |
> | `OOMOL_CONNECT_MCP_OAUTH_GRANT_TTL_SECONDS` | `2592000` | `refreshTokenTTL` |
> | `OOMOL_CONNECT_MCP_OAUTH_GRANT_IDLE_TTL_SECONDS` | unset (fixed) | `refreshTokenIdleTTL` |
>
> - A value that is set but is not an integer of at least 60 (KV's minimum expiration) makes OAuth requests fail with 503, rather than running with a lifetime the operator didn't choose.
> - The handler cache key includes the settings, so a changed value takes effect without a stale handler.
> - The consent page's `offline_access` line states the configured lifetime instead of the literal "30 days".
> - `docs/cloudflare.md` and `docs/configuration.md` document the variables and the trade-off: longer access tokens survive a client that doesn't refresh, but a revoked grant's existing access token then stays valid longer. Deleting the backing API key still revokes immediately, because the handler re-validates it on every request.
>
> ### Tests
>
> Behavior tests through `worker.fetch` with an in-memory KV and the SQLite D1 test database: the token response's `expires_in` is `3600` by default and the configured value when set, also after a refresh; a sub-60 value returns 503; the consent page states the configured grant lifetime. This needs `server.deps.inline: ["@cloudflare/workers-oauth-provider"]` in `vitest.config.ts` plus a `vi.mock("cloudflare:workers")` stub, because the library imports `WorkerEntrypoint` from the Workers runtime.
>
> I have a branch with this and am happy to open a PR.

---

## Draft 2: Restrict which OAuth clients can connect (Cloudflare)

**Title:** `feat(cloudflare): optional allowlist for MCP OAuth clients`

**Body:**

> ### Problem
>
> With `OAUTH_KV` bound, any client can register through DCR, and any HTTPS client ID is accepted through CIMD. The administrator token on the consent page is the only gate. That is a strong gate, but a single-user gateway connected to one known client (claude.ai, ChatGPT, Claude Code) would rather not show a consent page to anything else. A look-alike client is then a phishing attempt on the admin token.
>
> ### Proposal
>
> An optional `OOMOL_CONNECT_MCP_OAUTH_ALLOWED_REDIRECT_URIS`, a comma-separated list. Empty means current behavior.
>
> - **DCR:** a `clientRegistrationCallback` rejects a registration unless every `redirect_uris` entry is allowlisted (`400 invalid_client_metadata`).
> - **Authorize:** the GET and the approving POST check the validated `redirectUri` from `describeConsent`, and answer `403` locally, never redirecting. This covers CIMD clients, which never register, and clients registered before the allowlist was set.
> - **Loopback:** `http://localhost`, `127.0.0.1` and `[::1]` entries match on any port (RFC 8252 §7.3), so native clients with ephemeral ports work.
>
> Redirect URIs are used rather than client IDs because DCR client IDs are random per registration, and clients document their callbacks (`https://claude.ai/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform/oauth_redirect`) more consistently than their CIMD URLs. If you'd prefer client IDs, a second list, `OOMOL_CONNECT_MCP_OAUTH_ALLOWED_CLIENT_IDS`, matching CIMD URLs exactly, could sit alongside it.
>
> ### Tests
>
> Through `worker.fetch`: a non-allowlisted registration gets a 400 `invalid_client_metadata`; an allowlisted one completes the code exchange; `http://localhost:<port>/callback` matches an allowlisted `http://localhost/callback`; a client registered before the allowlist excluded it gets a 403 with no `Location` header.

---

## Interim patch for SplitMind `patches/`

File: `patches/0002-mcp-oauth-configurable-lifetimes-and-redirect-allowlist.patch`. It implements both drafts together, since both change the same handler signature. If upstream wants them split, split at PR time.

- Applies cleanly to v1.9.2 (`git apply --check` passes).
- Touches `src/server/cloudflare.ts`, `src/server/cloudflare/{cloudflare-env,mcp-consent-page,mcp-oauth}.ts`, `vitest.config.ts`; adds `src/server/cloudflare/mcp-oauth.test.ts`.
- Touches auth, tokens and consent, so under the ground rules any SplitMind PR carrying it waits for Sam's approval.

### Evidence

The new tests fail on stock v1.9.2 (red), with the source changes stashed:

```
$ npx vitest run src/server/cloudflare/mcp-oauth.test.ts
     × issues access tokens with the configured lifetime
     × keeps the configured access token lifetime after a refresh
     × fails closed on a lifetime below 60 seconds
     × states the configured grant lifetime on the consent page
     × refuses to register a client whose redirect URI is not allowlisted
     × refuses consent for a client registered before the allowlist excluded it
      Tests  6 failed | 3 passed (9)
```

The 3 that pass on stock are the default 3600 and the two "allowed" paths, which stock allows because it allows everything.

With the patch (green):

```
$ npx vitest run --reporter=verbose src/server/cloudflare/mcp-oauth.test.ts src/server/cloudflare/mcp-consent-page.test.ts
 ✓ mcp-consent-page.test.ts > escapes untrusted client metadata and the consent handle
 ✓ mcp-oauth.test.ts > … > issues one-hour access tokens by default
 ✓ mcp-oauth.test.ts > … > issues access tokens with the configured lifetime
 ✓ mcp-oauth.test.ts > … > keeps the configured access token lifetime after a refresh
 ✓ mcp-oauth.test.ts > … > fails closed on a lifetime below 60 seconds
 ✓ mcp-oauth.test.ts > … > states the configured grant lifetime on the consent page
 ✓ mcp-oauth.test.ts > … > refuses to register a client whose redirect URI is not allowlisted
 ✓ mcp-oauth.test.ts > … > completes authorization for an allowlisted redirect URI
 ✓ mcp-oauth.test.ts > … > matches an allowlisted loopback redirect on any port
 ✓ mcp-oauth.test.ts > … > refuses consent for a client registered before the allowlist excluded it
 Test Files  2 passed (2)
      Tests  10 passed (10)

$ npm run typecheck
Typechecked src, scripts, examples.

$ npx oxlint src/server/cloudflare.ts src/server/cloudflare/ vitest.config.ts; echo "lint exit $?"
lint exit 0

$ npx oxfmt --check src/server/cloudflare.ts src/server/cloudflare/ vitest.config.ts
All matched files use the correct format.

$ npx vitest run        # upstream's whole suite, patched
 Test Files  283 passed | 1 skipped (284)
      Tests  3592 passed | 20 skipped (3612)
```

### Not yet proven

- The patch has only been exercised in Node through `worker.fetch`, not on a deployed Worker or under `wrangler dev`. E3.1's `test-mcp-oauth.py` run against a patched deployment is the real check.
- The `cloudflare:workers` stub replaces only the `WorkerEntrypoint` base class, which the handler path doesn't use. Upstream may prefer `@cloudflare/vitest-pool-workers` instead.
