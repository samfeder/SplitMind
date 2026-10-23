# Upstream issue draft: per-connection action policy (2026-10-23)

**Status: draft only, not filed.** Filing is a public post from Sam's account (#37). Once filed, link it from
[docs/guardrails.md](../guardrails.md) section 5 and close E6.4 (#31). Written against OpenConnector `v1.9.2`.

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
> A refused call returns `action_blocked` with a policy check whose `source` is `connection`, and the run log
> records it like the other layers. `list_connections` exposes the restriction so agents can pick the right
> account.
>
> ### Workarounds we document meanwhile
>
> Least privilege at the provider (read-only Notion capabilities or Slack scopes per workspace), or a runtime token
> limited to read action ids.
