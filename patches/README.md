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
| `0002-mcp-oauth-configurable-lifetimes-and-redirect-allowlist.patch` | Optional `OOMOL_CONNECT_MCP_OAUTH_*` settings for access-token and grant lifetimes and a redirect-URI allowlist. Unset, behaviour is unchanged. | Not filed yet; drafts in [docs/upstream/mcp-oauth-issue-drafts.md](../docs/upstream/mcp-oauth-issue-drafts.md) | #15, #17 |

`0001` is reserved for the key-derivation patch planned under #8.
