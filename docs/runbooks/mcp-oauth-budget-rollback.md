# Runbook: the MCP OAuth registration budget (patch 0017)

Patch 0017 adds a SQLite-backed Durable Object, `McpOAuthAnonymousWriteBudget`, bound as
`MCP_OAUTH_ANONYMOUS_WRITES`, to count client registrations. Cloudflare applies its migration (`v1`) once, on the
first deploy, and a migration cannot be undone by rolling the code back. Read this before the first deploy.

## Deploy checklist

Run after every deploy of 0017, and after any change to the budget:

1. `npm run verify` passes. It probes the gateway's refusal of client assertions, the OAuth library's
   answer for an unknown client, and an authorize request for an unknown client. None of the probes writes to KV.
2. One tool call on an existing connection: a claude.ai connection that has been idle for over 1 hour (its access
   token has expired, so the call must refresh), or Claude Code. For example a read-only `execute_action`. It must
   succeed. This proves token refresh still works. Do this before step 3, because a fresh sign-in revokes the earlier
   claude.ai grant, so afterwards there is no old connection left to test.
3. One fresh sign-in from claude.ai: remove the connector, add it again, enter the administrator token on the consent
   page and allow. It must reach the connected state.

If step 2 or 3 fails, use the kill switch below first, then investigate.

## Kill switch: turn the budget off (reversible)

1. In `wrangler.template.jsonc`, delete the `durable_objects` block (the `MCP_OAUTH_ANONYMOUS_WRITES` binding).
2. Keep the `migrations` block and keep the `McpOAuthAnonymousWriteBudget` class export in the Worker. Cloudflare
   still has the class and the Worker must keep exporting it.
3. Run `npm run deploy`.

With no binding there is no registration cap. The token-endpoint refusal of client assertions, the 64 KiB body cap,
and the owner-only consent page are not part of the binding and stay on. To turn the budget back on, restore the block
and deploy again.

## Full removal

Patches stacked after 0017 must be reversed first, newest first, before 0017 itself: a later patch may edit lines
0017 added, so 0017 will not reverse cleanly underneath it.

After full removal the client-assertion probe in `npm run verify` fails, because the gateway no longer refuses client
assertions. That failure is expected. Remove the probe from `scripts/verify-deployment.ts` (and its tests) in the same
change, or accept the red check knowing what it means.

Warning: reverse-applying 0017 also removes owner-only consent and the client_assertion refusal. That brings back
anonymous KV writes on `GET /oauth/mcp/authorize` (a consent transaction per request) and on token requests with an
assertion (a replay marker), and with them the way to use up the day's 1,000 writes. If you only want the budget off,
use the kill switch.

1. Reverse-apply `patches/0017-mcp-oauth-anonymous-kv-write-budget.patch` in `vendor/open-connector`
   (`git apply -R`), and remove the `durable_objects` block and the two budget vars. Also delete the 0017 patch file, so
   `scripts/bootstrap.sh` no longer applies it.
2. Keep `v1` and append a second migration to `migrations` in `wrangler.template.jsonc`:

   ```jsonc
   { "tag": "v2", "deleted_classes": ["McpOAuthAnonymousWriteBudget"] }
   ```

3. Run `npm run deploy`. Cloudflare deletes the class and its stored counts.

Do this in one deploy. If the class export is removed while the migration list still has only `v1`, the deploy is
rejected.

## Never remove the v1 migration

Never remove or edit the `v1` migration (`new_sqlite_classes`). Cloudflare records which tags it has applied, and
the list must keep every applied tag in order. Removing `v1` makes later deploys fail or recreate state.

## A Worker version rollback cannot cross this deploy

`wrangler rollback`, and rolling back to a previous version in the dashboard, cannot undo the first deploy of 0017.
Versions from before it have no `McpOAuthAnonymousWriteBudget` class, and Cloudflare rejects them once the migration
has been applied. Use the kill switch or full removal above instead. A rollback between versions that both include
0017 works as usual.
