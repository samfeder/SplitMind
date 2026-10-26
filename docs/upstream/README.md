# Upstream work

SplitMind fixes engine gaps in [OpenConnector](https://github.com/oomol-lab/open-connector), not here. Everything
below is drafted and waiting to be filed from Sam's GitHub account (#37). Nothing has been posted upstream yet.

| Draft | Kind | SplitMind patch | Issues |
|---|---|---|---|
| [HKDF for random Worker keys](hkdf-issue-draft.md) | issue, then PR | `patches/0001-…` | #8 |
| [Configurable MCP OAuth lifetimes](mcp-oauth-issue-drafts.md#draft-1-configurable-mcp-oauth-token-lifetimes-cloudflare) | issue, then PR | `patches/0002-…` | #15 |
| [Restrict MCP OAuth clients](mcp-oauth-issue-drafts.md#draft-2-restrict-which-oauth-clients-can-connect-cloudflare) | issue, then PR | `patches/0002-…` | #17 |
| [Per-connection action policy (read-only)](connection-read-only-issue-draft.md) | issue | none | #31 |
| [Unnamed call returns a misleading auth error](../spikes/notion-provider.md#u1--execute_action-without-connectionname-and-no-default-returns-a-misleading-auth-error) | issue | none | #28 |
| [Require a connection name per provider](../spikes/notion-provider.md#u2--option-to-require-an-explicit-connection-name-for-some-providers) | issue | none | #28 |
| [Gmail attachments on KV/R2 transit](gmail-attachments-issue-draft.md) | issue, then PR | `patches/0003-…` | #56 |
| [Choose read-only access and accounts at MCP consent](mcp-grant-scope-issue-draft.md) | issue, then PR | `patches/0004-…` | #76 |
| ["Use with claude.ai" docs + kv_namespaces fix](claude-ai-docs-pr-draft.md) | docs PR | none | #37 |

## Filing them (Sam)

1. Fork `oomol-lab/open-connector` to `samfeder/open-connector` (GitHub → Fork).
2. File each issue with the draft's title and body, re-checking upstream `main` first as each draft says.
3. For the four patches, push a branch to the fork from the patch and open the PR:

   ```bash
   git clone https://github.com/samfeder/open-connector.git && cd open-connector
   git checkout -b hkdf-raw-keys v1.9.2
   tail -n +5 ../SplitMind/patches/0001-worker-secret-codec-hkdf-for-raw-keys.patch | git am   # skips SplitMind's 4-line header
   git push -u origin hkdf-raw-keys
   ```

4. Paste each link into the patch header (line 2) and the issue table above, and tell Claude. It updates
   `patches/README.md` and closes #37 when every row has a link.
