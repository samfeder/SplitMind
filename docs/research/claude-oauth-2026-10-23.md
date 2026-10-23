# Research: claude.ai and OpenConnector's MCP OAuth (2026-10-23)

Read-and-plan spike for E3 ([#11](https://github.com/samfeder/SplitMind/issues/11)): #13–#17. Nothing deployed, nothing filed upstream, no secrets touched.

**Pinned upstream:** OpenConnector `v1.9.2` = `2748be7758ad388b4eb59a33696285a8444a3c81` (the tag SplitMind pins in `vendor/open-connector`). `@cloudflare/workers-oauth-provider` resolves to `1.2.3` in upstream's lockfile (`1.2.4` exists on npm). All `file:line` references below are at that tag.

Related:
- [`docs/testing/e3-claude-connector.md`](../testing/e3-claude-connector.md): steps and expected literals for E3.1–E3.5.
- `patches/0002-mcp-oauth-configurable-lifetimes-and-redirect-allowlist.patch` and `docs/upstream/mcp-oauth-issue-drafts.md`: the interim patch and the upstream issue texts (separate pull request, because it changes auth).

## Bottom line

1. **Decision 3 holds, with three corrections.** OpenConnector's MCP OAuth is what the prompt says, but (a) the MCP server exposes **five** tools, not four (`list_apps` is the fifth); (b) the 30-day grant is a **fixed** lifetime from the first sign-in, so even with perfect refresh, claude.ai must re-consent every 30 days; (c) the OAuth code is five days old (merged 2026-10-20, PR #757), so expect rough edges.
2. **Neither lifetime nor client restriction is configurable upstream.** Both are hard-coded or absent. I wrote a patch that adds both behind optional env vars. Unset, behavior is unchanged. With the patch, 9 new tests pass, and upstream's full suite stays green (3,592 passed).
3. **The refresh risk (#228) is lower than the prompt assumed, but not gone.** Claude's own connector docs now say Claude refreshes "proactively up to five minutes before the stored expiry" and "reactively on a 401". A September 2026 comment on #228 saw autonomous refreshes. Older reports said Claude never refreshed. E3.3 is still the deciding test.
4. **claude.ai will most likely use CIMD, not DCR, against this server.** Claude picks CIMD when the server advertises `client_id_metadata_document_supported: true` and `none` among token auth methods, and OpenConnector advertises both. That makes the closest open failure report #1110 (CIMD plus rotating refresh, sign-in "never sticks"), not #215.
5. **"The connector form cannot send custom headers" is now only partly true.** claude.ai has a **Request headers** beta for "a limited set of organizations". If the operator's account has it, a runtime token sent as `authorization: Bearer …` with **No sign-in** skips OAuth entirely. That is a fallback if E3.2 or E3.3 fails. It has not been verified on the operator's account.

## Decision 3, claim by claim

| Claim in the prompt | Verdict | Evidence (v1.9.2) |
|---|---|---|
| OAuth turns on when an `OAUTH_KV` binding exists and `OOMOL_CONNECT_ORIGIN` is set | **Confirmed, plus:** the admin token and encryption key must also be set, or every request gets 503 | `src/server/cloudflare.ts:65-75`; `docs/cloudflare.md:165-171` |
| Discovery | Confirmed. Protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, with the origin-level path rewritten to it. `resource` is `<origin>/mcp` | `src/server/cloudflare/mcp-oauth.ts:56`, `:176-181` |
| Client ID Metadata Documents | Confirmed. Needs the `global_fetch_strictly_public` compatibility flag, which upstream's example config sets | `mcp-oauth.ts:51`; `wrangler.example.jsonc` `compatibility_flags` |
| Dynamic client registration | Confirmed, and **open**: anyone can register; no `clientRegistrationCallback` | `mcp-oauth.ts:50` |
| S256 PKCE | Confirmed (library advertises only `S256`) | library `buildOAuthServerCapabilities` |
| Rotating refresh tokens | Confirmed. The previous refresh token stays valid until the new one is used, so a lost refresh response is recoverable | library `handleRefreshTokenGrant`; library `docs/advanced-configuration.md` ("A refresh rotates the token…") |
| Revocation | Confirmed. `revocation_endpoint` is the token endpoint. Deleting the backing API key kills MCP access at once and makes refresh return `invalid_grant` | `mcp-oauth.ts:65-67`, `:78-83` |
| Access tokens last 1 hour; grants last 30 days | **Confirmed, hard-coded, and the 30 days is fixed** (no `refreshTokenIdleTTL`). A grant expires 30 days after sign-in however often it refreshes | `mcp-oauth.ts:54-55`; library: "Leave unset for a fixed lifetime" |
| Consent page requires the admin token | Confirmed, compared in constant time; POST also requires `Origin` to equal the origin | `mcp-oauth.ts:113`, `:130-132` |
| Each approval creates an `MCP OAuth • <client name>` API key | Confirmed. Policy: all actions (`["*"]`), no proxies, **all connections** (an empty `allowedConnections` means unrestricted) | `mcp-oauth.ts:136-142`; `src/server/api/openapi.ts:730-731` |
| MCP tools are `search_actions`, `get_action_guide`, `list_connections`, `execute_action` | **Wrong: five tools.** (The README said four; this PR corrects it.) `list_apps` is also registered (present since at least 2026-08-31) | `src/mcp.ts:61-111`, `:156-174` |
| Upstream documents and tests this for ChatGPT, not claude.ai | Confirmed. The test script's redirect is ChatGPT's; there is no claude.ai mention in docs or commit history | `scripts/test-mcp-oauth.py:23`; `docs/cloudflare.md:163` |

Not a tripwire: the behavior differs from the prompt only in detail (tool count, fixed grant), not in license or OAuth mechanism. License is still Apache-2.0 (`LICENSE.txt`).

Also relevant to E3:
- With OAuth on, a plain runtime token still works at `/mcp` as `Authorization: Bearer oct_…` (`mcp-oauth.ts:74-77`). E3.4 works on the same deployment.
- With OAuth on, the runtime API needs auth even before any API key exists (`cloudflare.ts:137`).
- The backing key's policy is re-read on every request, so it can be narrowed after approval with `PUT /api/runtime-tokens/:id`, for example to specific connection IDs.
- After approval the server redirects with **302** (`mcp-oauth.ts:152`), so the #313 failure (a 307 that replays the POST to Claude's callback) does not apply.
- I ran the stock Worker in-process (Node, `worker.fetch`, in-memory KV, SQLite D1) to check the discovery literals in the test plan. Output, with a placeholder origin:
  - `/.well-known/oauth-protected-resource/mcp` returned `{"resource":"https://o.example/mcp","authorization_servers":["https://o.example"],"scopes_supported":["mcp:access"],…}`.
  - The unauthenticated `POST /mcp` returned 401 with `Bearer realm="OAuth", resource_metadata="https://o.example/.well-known/oauth-protected-resource/mcp", scope="mcp:access"`.
  - Authorization server metadata advertised `token_endpoint_auth_methods_supported: ["client_secret_basic","client_secret_post","none"]`. It reported `client_id_metadata_document_supported: false` in Node only because the `global_fetch_strictly_public` flag doesn't exist there. On Workers with the flag it should be `true`; E3.1 step 2 checks this.
- The token endpoint and consent page never load the 13.8 MiB catalog; only `/mcp` does. Cold-start cost matters for Claude's 10-second timeout on the first `tools/list`, not for token refresh (ADR-0001 covers cold-start cost).

## What Claude's docs say (fetched 2026-10-23)

From [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md), [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication.md) and [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted.md):

- **Callback** for web, Desktop, mobile and Cowork: `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a loopback redirect on a random port, with its own CIMD at `https://claude.ai/oauth/claude-code-client-metadata`.
- **Client choice:** CIMD only if the server advertises `client_id_metadata_document_supported: true` **and** `"none"` in `token_endpoint_auth_methods_supported`. Otherwise DCR. OpenConnector advertises both.
- **Refresh:** "Claude refreshes tokens reactively on a `401` response, and proactively up to five minutes before the stored expiry." It expects `invalid_grant` for a dead refresh token, which OpenConnector returns.
- **Timeouts:** 10 s for discovery, registration and token endpoints; 30 s for refresh.
- **Resource match:** the metadata's `resource` "must equal the URL as the user enters it". So the operator must enter `<origin>/mcp`, with no trailing slash.
- **Scopes:** Claude requests the protected resource's `scopes_supported` (`mcp:access`) plus `offline_access`. OpenConnector grants both on approval regardless of what was asked (`mcp-oauth.ts:133`).
- **Egress:** Anthropic's requests come from `160.79.104.0/21`.
- **Request headers (beta, limited organizations):** with **No sign-in**, an `authorization` header value such as `Bearer <token>` is sent on every request. It cannot be combined with `Authorization` on an OAuth connection.
- **Plans:** custom connectors work on Free (one connector), Pro, Max, Team and Enterprise. On Team or Enterprise, an Owner adds it under Organization settings.

## claude-ai-mcp issues: status on 2026-10-23

Firecrawl had no credits, so these were read with WebFetch. Comment dates are often not shown on the fetched pages; dates below are the latest ones visible.

| Issue | State | What it means for SplitMind |
|---|---|---|
| [#178](https://github.com/anthropics/claude-ai-mcp/issues/178): duplicate URL rejected | Open; no staff reply; latest reference 2026-09-17 | Premise holds. The known workaround (`?org=foo` query strings) is reported as flaky ("Claude seems to silently strip the query parameters"). |
| [#228](https://github.com/anthropics/claude-ai-mcp/issues/228): refresh never attempted | Open; no staff reply; latest date 2026-09-15 | Mixed. Several stacks saw no refresh. Entra stacks saw refresh fail on a missing `scope`. One Supabase stack saw "21/21" automatic refreshes by mid-September. Raising access tokens from 1 h to 24 h only "stretched the interval". |
| [#215](https://github.com/anthropics/claude-ai-mcp/issues/215): code never exchanged | No confirmed root cause; reports through 2026-07-25 | One reporter used `workers-oauth-provider@0.4.0`; upstream is on 1.2.3. One user says an Anthropic-side fix in late April resolved it. A reply traced two failures to servers rotating a DCR secret. With CIMD, there is no DCR secret. |
| [#313](https://github.com/anthropics/claude-ai-mcp/issues/313): callback returns Method Not Allowed | Closed as duplicate of #250 | The cause was a 307 redirect from the consent POST. OpenConnector uses 302. Not affected. |
| [#247](https://github.com/anthropics/claude-ai-mcp/issues/247): Enterprise refresh fails | No staff reply | Suspected cause: the client authenticates with HTTP Basic and the server ignored it. The OAuth library accepts Basic. Probably not affected. |
| [#430](https://github.com/anthropics/claude-ai-mcp/issues/430): token not bound to new connector | Closed (not a Claude bug) | Fixes were server-side: Cloudflare **Bot Fight Mode / "Block AI bots"** dropping Anthropic's requests, and invalid tool schemas. Matters if SplitMind later moves to a custom domain on a Cloudflare zone. |
| [#702](https://github.com/anthropics/claude-ai-mcp/issues/702): no re-auth prompt on expiry | State not shown | On expiry, tools silently disappear. Manual fix: disconnect and reconnect. This is what a failed E3.3 would look like. |
| [#1110](https://github.com/anthropics/claude-ai-mcp/issues/1110): OAuth completes, Claude never treats it as signed in | **Open, opened 2026-10-05** | Closest match to our stack (CIMD, rotating refresh, works from Claude Code). No resolution. If E3.2 fails this way, cite it. |

## Answers

**Is the access-token lifetime configurable upstream?** No. `accessTokenTTL: 3600` and `refreshTokenTTL: 30 * 86400` are literals (`mcp-oauth.ts:54-55`), and `CloudflareEnv` has no setting for them (`cloudflare-env.ts:3-26`). The library supports per-provider and per-grant overrides, so the change is small.

**Can upstream restrict which OAuth clients connect (E3.5)?** No. DCR is open, CIMD accepts any HTTPS client ID, and the only gate is the admin token at consent. The library offers `clientRegistrationCallback` for DCR, and the consent handler sees the validated redirect URI for both DCR and CIMD clients.

I chose to restrict by **redirect URI**, not client ID. A DCR client's ID is random per registration, and I could not find the CIMD client ID that hosted claude.ai uses (Claude Code's is documented; the web app's is not). A redirect allowlist covers both, and `https://claude.ai/api/mcp/auth_callback` is documented. Upstream may prefer client IDs; the issue draft offers both.

**Interim patch** (`patches/0002-…patch`, applies cleanly to v1.9.2). Four optional variables:

| Variable | Unset means | Purpose |
|---|---|---|
| `OOMOL_CONNECT_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | 3600 | Longer access tokens if claude.ai doesn't refresh |
| `OOMOL_CONNECT_MCP_OAUTH_GRANT_TTL_SECONDS` | 2592000 (30 days, fixed) | Grant lifetime |
| `OOMOL_CONNECT_MCP_OAUTH_GRANT_IDLE_TTL_SECONDS` | fixed lifetime | Sliding: only an unused grant expires |
| `OOMOL_CONNECT_MCP_OAUTH_ALLOWED_REDIRECT_URIS` | any registered URI | Comma-separated; `http` loopback URIs match any port |

A lifetime that is set but under 60 seconds or not an integer returns 503 (fails closed). The consent page states the configured grant lifetime. Test evidence is in the issue drafts file.

## Recommendation

1. **Run E3.1–E3.3 on stock upstream first.** If the patch is on from the start and something fails, we won't know whether the patch caused it.
2. **If E3.3 fails at the 1-hour mark:** apply the patch with `ACCESS_TOKEN_TTL_SECONDS=86400`, file the lifetime issue, and redo E3.3. This is a stopgap. #228 shows it only turns an hourly break into a daily one.
3. **If E3.3 passes:** still consider `GRANT_IDLE_TTL_SECONDS=2592000` (30 days, sliding), so daily use never forces a re-consent. That trades a scheduled re-consent for convenience, so it's the operator's call (Sam, for this instance).
4. **E3.5:** after E3.2 passes, carry the patch with `ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,http://localhost/callback,http://127.0.0.1/callback` and file the upstream issue. The patch touches auth, so per the ground rules it waits for Sam's approval before merge.
5. **If E3.2 fails twice in different ways** (the prompt's tripwire), check whether the operator's account shows **Request headers**. If it does, connecting with a narrowed runtime token is a working fallback for claude.ai, and E3.3 stops mattering.

## Known vs. assumed

**Known (read in code or docs today):** everything in the claim table; the Claude doc quotes; issue states as fetched; the patch's test results.

**Assumed, to verify in E3:**
- claude.ai uses CIMD here, not DCR. This follows from Claude's docs; E3.2 confirms it if the consent page shows "Client domain: claude.ai".
- Claude's documented proactive refresh works for this server. Only E3.3 shows that.
- `search_actions` returns a normal (non-error) result under a `notion.*,slack.*` allowlist, so `test-mcp-oauth.py`'s `hackernews` search check passes. From reading `src/mcp.ts:250-280`, it lists matching actions with their policy status and does not error.
- workers.dev hostnames are not subject to a zone's Bot Fight Mode. That is my understanding of Cloudflare, not verified here.
- Whether the operator's claude.ai account has the Request headers beta.

## Lens for Claude

- The 30-day grant is fixed. Re-consent every 30 days is expected stock behavior. It is not a refresh bug.
- There are five MCP tools. A check for "four tools" will fail on a correct deployment.
- Before blaming claude.ai, rule out the server and edge: 302 vs 307, Bot Fight Mode, `resource` matching the entered URL exactly, and the 10-second limit on a cold `/mcp`.
