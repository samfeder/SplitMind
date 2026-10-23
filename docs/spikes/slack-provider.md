# E5.1 spike: OpenConnector's Slack provider (2026-10-23)

Issue: #23. Checked against **OpenConnector v1.9.2** (`2748be7758ad388b4eb59a33696285a8444a3c81`), the tag `vendor/open-connector` is pinned to.

Paths and line numbers are relative to the OpenConnector repo at that tag: <https://github.com/oomol-lab/open-connector/tree/v1.9.2>. The Slack provider lives in [`src/providers/slack/`](https://github.com/oomol-lab/open-connector/tree/v1.9.2/src/providers/slack). The setup docs this spike feeds are `slack/app-manifest.json` and `docs/providers/slack.md` (#24).

## Answers

| Question | Answer | Evidence |
|---|---|---|
| Provider id for the allowlist | `slack` → `slack.*`. (`slackbot` is a separate bot-token provider; not used.) | `src/providers/slack/definition.ts:7,165`; `src/providers/slackbot/definition.ts:8` |
| Auth types | `oauth2` (user token via `https://slack.com/oauth/v2_user/authorize`, token from `oauth.v2.user.access`) and `api_key` (paste an `xoxb-`/`xoxp-` token) | `definition.ts:168-187` |
| User vs bot token | The `slack` provider's OAuth yields a **user token** (`xoxp-`), so actions run as Sam and `search.messages` works. `slackbot` uses `oauth/v2/authorize` (bot token). | `definition.ts:172`; `slackbot/definition.ts:23`; test `src/oauth/oauth-flow-service.test.ts:828` asserts the `v2_user` path and an `xoxp-` token |
| Scopes | 18 authorization options; 16 selected by default, only `channels:read` required. `search:read.public` / `search:read.private` (Real-time Search) are off by default. | `definition.ts:8-159` |
| Search | `slack.search_messages` (`search.messages`, scope `search:read`, user token only). Also `slack.search_context` (Real-time Search, needs `search:read.public`). | `actions.ts:387,431` |
| Channel history | `slack.get_channel_messages`, `limit` up to 999, cursor paging | `actions.ts:325-353` |
| Thread replies | `slack.get_thread` (`conversations.replies`), `limit` up to 999 | `actions.ts:500` |
| List channels | `slack.list_channels` (public only, max 100) and `slack.list_conversations` (all types) | `actions.ts:309,529` |
| Post | `slack.post_message`, `slack.reply_message`; cleanup via `slack.delete_message` | `actions.ts:476,485,681` |
| React | `slack.add_reaction`, `slack.remove_reaction`, `slack.get_reactions` | `actions.ts:714,722,730` |
| Account shown on a connection | Profile from `auth.test`: `accountId` = Slack user id, `displayName` = **workspace name** (falls back to team id). Useful for E6.2. | `src/providers/slack/runtime.ts:247-252` |
| Rate-limit errors | Slack `ratelimited` → HTTP 429, keeping `Retry-After`. | `runtime.ts:1489-1491,1512-1516` |

### Minimal scopes for the v0.1 actions

All are **user** scopes. Slack checks the scope that matches the conversation type, so the history scopes are only needed for the kinds of conversation you want to read.

| Action | Scopes |
|---|---|
| `slack.get_current_user` | none |
| `slack.search_messages` | `search:read` |
| `slack.list_channels` | `channels:read` |
| `slack.list_conversations` | `channels:read`, plus `groups:read` / `im:read` / `mpim:read` for private channels, DMs and group DMs |
| `slack.get_channel_messages`, `slack.get_thread` | `channels:history` (public), `groups:history` (private), `im:history` (DMs), `mpim:history` (group DMs) |
| `slack.post_message`, `slack.reply_message`, `slack.delete_message` | `chat:write` |
| `slack.add_reaction`, `slack.remove_reaction` | `reactions:write` |

**Minimal set for public and private channels:** `channels:read`, `channels:history`, `groups:read`, `groups:history`, `search:read`, `chat:write`, `reactions:write`. Add `users:read` so user ids resolve to names. Upstream marks only `channels:read` as required (`definition.ts:9-16`).

The manifest in #24 requests the provider's 16 **default** scopes instead (see "Decisions" below). The manifest can be trimmed to the minimal set as long as the connection requests the same subset, because Slack rejects an authorization that asks for a scope the app does not declare.

### Decision 4: one OAuth app per connection: **confirmed**

- `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH` takes `*` or a service list (`docs/configuration.md:23`), parsed in `src/server/cloudflare.ts:146`, and gated in `src/server/connect-app.ts:83-90`.
- `POST /api/oauth/authorizations` reads `clientId`, `clientSecret`, `requestedScopes`, `redirectUri`, `extra`, `secretExtra` plus `connectionName` from the body (`src/server/api/console-oauth-routes.ts:36-49,296-317`).
- A custom app is refused unless the service is allowlisted (`oauth_custom_app_not_allowed`) **and** the encryption key is set (`oauth_custom_app_encryption_required`) (`src/oauth/oauth-flow-service.ts:431-443`).
- Callback is `<origin>/oauth/callback` unless a `redirectUri` override is given (`src/oauth/oauth-client-config-service.ts:83,175-178`).
- The app values are stored on the credential as `metadata.oauthClientConfig` for later refreshes (`oauth-flow-service.ts:357-364`).
- No deployment-wide Slack OAuth app is needed on this path: `prepareAuthorization` uses the request's client config (`oauth-flow-service.ts:212-216`).
- The Web Console exposes this as **OAuth app: Default App / Custom App** on the connection form (`web/src/providers-page.tsx:1923-1945`, `web/src/locales/en.json`), and sends `clientId`/`clientSecret` with `connectionName` (`providers-page.tsx:1565-1582`).
- Upstream already tests our exact case, two Slack connections with different custom apps: `oauth-flow-service.test.ts:828` "isolates Slack custom user clients and accepts the pinned top-level user token response".

Run against the pinned tag (lockfile registry rewritten from npmmirror to registry.npmjs.org so it installs here):

```
$ npx vitest run src/providers/slack src/oauth/oauth-flow-service.test.ts -t "Slack|connection-scoped|slack"
 Test Files  3 passed (3)
      Tests  242 passed | 39 skipped (281)
```

Manifest scopes equal the provider's default selection, checked by a script that imports `definition.ts`:

```
upstream default-selected: 16 manifest user scopes: 16
equal: true
upstream not default: search:read.public,search:read.private
```

## Slack rate limits, re-verified 2026-10-23

From Slack's changelog ([29 May 2025](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/), [3 Jun 2025 clarification](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)):

- Commercially distributed **non-Marketplace** apps: `conversations.history` and `conversations.replies` at **1 request/minute**, `limit` max and default **15**. Applies to new apps and new installs from 29 May 2025.
- **Internal customer-built apps are not affected**: they keep 50+ requests/minute and up to 1,000 objects.
- The `conversations.history` reference page still lists Tier 3 (50+/min), `limit` max 999 ([link](https://docs.slack.dev/reference/methods/conversations.history/)). `search.messages` is Tier 2, 20+/min, user token with `search:read` ([link](https://docs.slack.dev/reference/methods/search.messages/)).

Matches decision 4. **Gap:** Slack never defines "internal customer-built" precisely. Our working definition: the app is created in the workspace it is installed in, and public distribution is never activated ([distribution docs](https://docs.slack.dev/app-management/distribution/): an app installs only in its own workspace until distribution is activated). E5.3's `limit=100` check is the real proof.

## Decisions made here (please override if wrong)

1. **Use `slack`, not `slackbot`.** Search needs a user token; acting as Sam is what "my workspaces from Claude" means.
2. **Manifest = the provider's 16 default scopes**, including DMs and files. Zero scope tuning at connect time; Slack rejects a request for scopes the app lacks, so a mismatch would break connecting. A narrower set is documented in `slack.md`.
3. **Token rotation off.** Non-rotating user tokens don't expire, so Slack doesn't add a second refresh dependency next to the claude.ai one (decision 3). Upstream supports refresh if we flip it.
4. **No bot user in the manifest.** Only user scopes are needed.
5. **Console over curl for connecting**, so the client secret never lands in shell history.

## Known vs assumed

- **Known (code + tests):** everything in the Answers table and the decision 4 section.
- **Assumed, to verify in E5.2/E5.3 Sam steps:**
  - Slack accepts a manifest with only user scopes and no `bot_user`. The manifest reference doesn't say. If it refuses, add `features.bot_user` with no bot scopes.
  - The redirect placeholder must be replaced before Slack will save the app (Slack validates URLs).
  - An app created in and installed only to one workspace counts as "internal" for the throttle (see gap above).
  - `search.messages` behaves normally for an internal app's user token.

## Gaps and upstream notes

No upstream issue is filed: none of the gaps below blocks v0.1 or needs an engine change.

- **Unnamed connection falls back to `default`.** If `connectionName` is omitted or blank when connecting, the connection is named `default` (`src/connection-service.ts:27,1150-1151`), and `execute_action` without `connectionName` uses it (`src/mcp.ts:114`). That would break decision 8. The docs say never leave the name blank. E6.1 (#28) should test for this; it's not Slack-specific (the Notion spike, #19, covers the general case).
- **`requiredScopes` is metadata only**, not enforced before calling Slack (only read in `src/mcp.ts:409`, `src/server/api/runtime-api.ts:132`). Missing scopes surface as Slack `missing_scope` errors. Fine for us; no upstream issue needed.
- **`list_channels` returns public channels only, max 100, without a cursor** (`actions.ts:309-322`). `list_conversations` covers private channels. Minor; not worth an upstream issue for v0.1.
- Nothing found that blocks E5.3/E5.4. No upstream issue needed for Slack v0.1.
