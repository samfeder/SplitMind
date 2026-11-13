# Patches

Fixes SplitMind needs from OpenConnector before upstream merges them.
`scripts/bootstrap.sh` applies every `*.patch` here to `vendor/open-connector`
in name order, at build time only. Nothing here is committed into the
submodule.

Rules:

- One fix per patch, named `NNNN-short-description.patch`, made with
  `git format-patch` from a branch in the `samfeder/open-connector` fork.
- The first lines of each patch link to its upstream issue or pull request.
- When upstream releases the fix, upgrade the pin and delete the patch. See
  [docs/upgrading-openconnector.md](../docs/upgrading-openconnector.md).

## Current patches

| Patch | What it does | Upstream | Issues |
| --- | --- | --- | --- |
| `0001-worker-secret-codec-hkdf-for-raw-keys.patch` | When `OOMOL_CONNECT_ENCRYPTION_KEY` is 32 random bytes in base64, derive the Worker's AES key with HKDF instead of 100k-iteration PBKDF2, writing `enc:worker:v2:` records. Existing v1 records still decode. Saves about 15 ms of CPU per cold isolate, needed for the Workers Free plan (ADR-0001). | Not filed yet; draft in [docs/upstream/hkdf-issue-draft.md](../docs/upstream/hkdf-issue-draft.md) | #8, #37 |
| `0002-mcp-oauth-configurable-lifetimes-and-redirect-allowlist.patch` | Optional `OOMOL_CONNECT_MCP_OAUTH_*` settings for access-token and grant lifetimes and a redirect-URI allowlist. Unset, behaviour is unchanged. | Not filed yet; drafts in [docs/upstream/mcp-oauth-issue-drafts.md](../docs/upstream/mcp-oauth-issue-drafts.md) | #15, #17 |
| `0004-mcp-oauth-consent-read-only-and-account-scope.patch` | The MCP OAuth consent page asks for **Access** (read only, the default, or read and write) and optional **Accounts** (nicknames). The backing key gets only the catalog's read actions and only those connections. Accounts are resolved after the admin token is checked, so the page never lists them. | Not filed yet; draft in [docs/upstream/mcp-grant-scope-issue-draft.md](../docs/upstream/mcp-grant-scope-issue-draft.md) | #76 |
| `0003-gmail-attachments-on-non-streaming-transit-backends.patch` | `gmail.download_attachment` works on transit backends without streaming (Workers KV): it decodes the response in memory with native JSON and base64, with the same validation and size limit as the streaming parser. About 4.5 ms of CPU per MiB on Node, against 100 ms for the streaming parser. | Not filed yet; draft in [docs/upstream/gmail-attachments-issue-draft.md](../docs/upstream/gmail-attachments-issue-draft.md) | #56 |
| `0005-connection-required-when-only-named-connections.patch` | A call without `connectionName` to a provider that has only named connections fails with `connection_required` ("Pass connectionName; list_connections shows the accounts") instead of running with no credential and answering "Configure slack credentials first.", which agents took for an expired sign-in. The message lists no names, since the caller may not be granted every connection. | Not filed yet; draft is U1 in [docs/spikes/notion-provider.md](../docs/spikes/notion-provider.md) | #28 |
| `0009-email-watch.patch` | An opt-in email watch on the Worker's existing once-a-minute cron. For named Gmail accounts it reads new inbox mail through three hard-coded reads (profile, history, message metadata with five headers) and keeps only machine mail that needs action (failed deploys or builds, GitHub failures and review requests, billing or quota warnings, account or security notices) as a deduplicated list, only when Gmail's own first `Authentication-Results` header says `dmarc=pass` for the From domain. New `mail_watch` provider: `list_pending_mail` (read) and `acknowledge_mail` (write). New D1 migration `0019_email_watch.sql` (Postgres mirror too). Watcher runs use a new `cron` run-log caller and record no input or output summaries. Gmail's `fetch_message_by_message_id` gains `metadataHeaders`. Off unless `OOMOL_CONNECT_EMAIL_WATCH_CONNECTIONS` is set; see [guardrails](../docs/guardrails.md#6-email-watch-patch-0009-126). | Not filed yet | #126 |
| `0010-oauth-flow-test-relative-expiry.patch` | Test-only. The OAuth flow test "stores the token returned by a provider OAuth runtime" hard-coded `expiresAt` 2026-10-30, which has passed, so the test failed. The expiry is now one hour from `Date.now()`. Candidate for upstream. | Not filed yet | #93 |
| `0011-email-watch-pre-enable-fixes.patch` | Fixes to the email watch (0009) required before enabling it. `mail_watch` runs are always outcome-only in run logs, enforced in `ActionRunner` (#104). Runs of 4 or more digits in a stored subject become `[redacted]`, so one-time codes are not kept (#105). The retention sweep is its own function, run on every due cron minute with or without a configured account, and also deletes items and cursors of accounts no longer in the list (#106). `List-Id` is no longer requested (#107). Apply after 0009. | Not filed yet | #104, #105, #106, #107 |
