# Upstream issue draft: per-connection action policy (2026-10-23)

**Status: draft only, not filed.** Filing is a public post from Sam's account (#37). Once filed, link it from
[docs/guardrails.md](../guardrails.md) section 5 and close E6.4 (#31). Written against OpenConnector `v1.9.2`.

**SplitMind carries this as patch 0018** (`patches/0018-connection-read-only-setting.patch`), as a deployment
setting rather than a per-connection field: `OOMOL_CONNECT_READ_ONLY_CONNECTIONS`, a list of
`<providerId>:<connectionName>` entries, so it needs no storage migration in the D1, SQLite and Postgres backends.
If you file this, say that a per-connection check has to cover three paths, not only actions, or it can be walked
around:

- `ActionRunner` (MCP `execute_action` and `POST /v1/actions/:actionId`): refuse anything but `operationType: read`.
- `POST /v1/proxy/:service` bypasses `ActionRunner`. A raw HTTP request cannot be classed as a read (Notion's
  search is a POST), so the patch refuses every proxy request on a read-only connection.
- Triggers (`TriggerRunner`) resolve the connection themselves, and `reconcile` / `resource` create or delete
  provider webhooks. The patch refuses those and keeps polling and inbound deliveries working. Cleanup of
  existing webhooks must stay allowed, or a read-only connection leaves orphaned webhooks.

---

**Title:** `feat: per-connection action policy (e.g. a read-only connection)`

**Body:**

> ### Use case
>
> One deployment holds several accounts of the same provider as named connections (for example two Notion
> workspaces). An operator wants one of them read-only, while the others keep write access, for every caller,
> including MCP OAuth clients such as ChatGPT or claude.ai.
>
> ### Today
>
> Action policy has three layers (deployment, runtime, token) and each matches action ids
> (`src/core/action-policy.ts`). A runtime token's `allowedConnections` picks which accounts it may use, and its
> `allowedActions` which actions, but the two are independent: a token cannot say "writes only on connection A".
> MCP OAuth clients get one backing key per approval, so per-client tokens do not help either.
>
> ### Proposal
>
> An optional policy stored on the connection, checked in the same place as `evaluateConnectionGrant`:
>
> - `allowedOperationTypes`: subset of `read`, `write`, `destructive` (the catalog's `operationType`), default all.
> - or the existing rule syntax: `allowedActions` / `blockedActions` per connection.
>
> The check must run wherever a resolved connection reaches a provider, not only in `ActionRunner`: the HTTP proxy
> (`POST /v1/proxy/:service`) and Trigger operations that register or delete webhooks (`reconcile`, `resource`)
> skip it. A raw proxy request cannot be classed as a read, so a read-only connection should refuse all of them.
>
> A refused call returns `action_blocked` with a policy check whose `source` is `connection`, and the run log
> records it like the other layers. `list_connections` exposes the restriction so agents can pick the right
> account.
>
> ### Workarounds we document meanwhile
>
> Least privilege at the provider (read-only Notion capabilities or Slack scopes per workspace), or a runtime token
> limited to read action ids.

---

## Mislabelled actions (separate issue, SplitMind patch 0019)

**Title:** `fix(catalog): actions that write are labelled operationType "read"`

**Body:**

> Per-connection read-only, and the read-only grant on the MCP consent page, trust each action's `operationType`.
> These actions are labelled `read` but are not (paths under `src/providers/`, at `v1.9.2`):
>
> - `destructive`: `aws_s3.generate_presigned_url` and `aliyun_oss.generate_presigned_url` (both can sign a DELETE).
> - `write`: `cloudflare_r2.generate_presigned_url`, `tailscale.rotate_webhook_secret`, `pinata.pin_by_cid`,
>   `keygen.ping_machine`, `keygen.ping_process`, `linear.run_query` (it takes arbitrary GraphQL text, so a read-only label cannot be trusted), `mailgun.verify_domain`, `vercel.verify_project_domain`,
>   `msg91.verify_otp`, `myotp_app.verify_otp`.
> - `write`, failing closed because the effect is uncertain: `fusion-api.file_upload_generate_presigned_url` and
>   `..._urls`, `harpa_ai.run_ai_prompt` (open-ended browser actions), and `fuxin.create_pdf_from_document`,
>   `create_pdf_from_html`, `merge_documents`, `remove_password_from_document` (may leave files in the account).
>
> Billed but non-mutating actions (LLM completions, embeddings, screenshots) are correctly `read`.
>
> A later audit (#134, SplitMind patch 0020) found more `read` labels that forward caller-chosen tools, SQL,
> GraphQL, code or HTTP methods, or that mutate:
>
> - `destructive`: `google_bigquery.query` (raw GoogleSQL runs DML and DDL, including DROP TABLE) and
>   `okta.lifecycle_user` (deactivates or suspends users).
> - `write`: `gildata.call_tool`, `pkulaw.call_tool`, `investoday_mcp.call_tool`, `finchina.execute_tool`,
>   `sif.call_tool`, `tongdaxin.call_tool`, `fireflies.execute_graphql_query` (its lexical mutation guard can be
>   bypassed with a block-string escape, which is worth fixing upstream), `waffo.run_query`, `wandb.query_wandb`,
>   `turbot_pipes.execute_query`, `vapi.test_code_tool_execution`, `scrapfly.scrape`,
>   `scrapingant.scrape_with_extended_json_output`, `scrapingant.extract_content_as_markdown` and
>   `scrapingant.extract_data_with_ai` (the caller picks any HTTP method and body).
>
> An executor-level gate (an allowlist plus `readOnlyHint === true`, as baizhi, sellerspace and tongdaxin do for
> some tools) could let some of these honestly return to `read` later.
