# Adding a provider

SplitMind can reach any provider OpenConnector supports. v0.1 turns on only Notion and Slack; turning on another is
configuration, not code.

## Turn on a provider OpenConnector already has

1. **Find its id.** Every provider has a `service` id in upstream's `src/providers/<id>/definition.ts`, e.g.
   `github` or `gmail`. Check it exists in the pinned release:

   ```bash
   ls vendor/open-connector/src/providers | grep -x '<id>'
   ```

2. **Allow its actions.** In [`wrangler.template.jsonc`](../wrangler.template.jsonc), add `<id>.*` to
   `OOMOL_CONNECT_ALLOWED_ACTIONS`:

   ```jsonc
   "OOMOL_CONNECT_ALLOWED_ACTIONS": "notion.*,slack.*,<id>.*",
   ```

   That one list drives both the policy and the catalog trim: `npm run deploy` ships catalog assets only for the
   providers named there. Keep `OOMOL_CONNECT_BLOCKED_PROXIES="*"` unless you deliberately want raw API access.
   To allow only some actions, list exact ids (`<id>.get_x,<id>.list_y`) instead of `<id>.*`; the trim still
   ships the whole provider's catalog entry.

3. **If each account needs its own OAuth app** (like Slack's one internal app per workspace), add the id to
   `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH` (comma separated).

4. **Deploy:** `npm run deploy`, then `npm run verify`. Verify reads the same allowlist, so it now expects the new
   provider in the offered list and checks its raw proxy is blocked.

5. **Connect each account as a named connection** in the Web Console (**Providers → <provider>**). Overwrite the
   pre-filled name `default` with an alias, every time ([why](guardrails.md#2-writes-must-name-an-account-decision-8-e61)).
   Add the provider to `guardedWrites` in `scripts/verify-deployment.ts` with one harmless write action, so
   `npm run verify` checks that unnamed writes are refused for it too.

6. **Check from Claude:** "List my `<provider>` connections." Each alias should appear with its account's display
   name.

Watch CPU after adding providers on the Workers Free plan: each one adds catalog parsing to cold requests
([ADR-0001](adr/0001-deployment-shape.md)).

## A provider OpenConnector doesn't have, or lacks an action

SplitMind writes no provider code. Fix it upstream:

1. Read upstream's contributing guide and an existing provider of the same auth type (`src/providers/<similar>/`).
2. Open an issue or PR on [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) from a fork.
3. If SplitMind needs it before a release, carry it as a patch: `git format-patch` from the fork branch into
   `patches/NNNN-<short-description>.patch`, with the upstream link in its first lines
   ([patches/README.md](../patches/README.md)). Remove the patch when the pin moves past the release that has it
   ([upgrading](upgrading-openconnector.md)).
