# Upstream docs PR draft: "Use with claude.ai" and the kv_namespaces fix (2026-10-23)

**Status: draft only, not opened.** Opening it is a public post from Sam's account (#37). Base it on upstream
`main`, re-checking `docs/cloudflare.md` and `wrangler.example.jsonc` first. Fill in the result lines marked TODO
from E3.2/E3.3 (#14, #15) before opening: the PR should only claim what was seen working.

---

**Title:** `docs(cloudflare): connect claude.ai, and keep both KV bindings in one array`

**Body:**

> Two documentation changes for the Cloudflare deployment.
>
> **1. `wrangler.example.jsonc`: one `kv_namespaces` array.** The example shows `OAUTH_KV` and the KV transit
> backend as two separate commented `"kv_namespaces"` blocks. Uncommenting both gives a duplicate JSON key; the last
> one wins and the other binding is silently dropped (OAuth stays off, or transit files break). This PR shows a
> single array with both entries, each commented on its own line.
>
> **2. `docs/cloudflare.md`: "Use with claude.ai".** The OAuth section documents ChatGPT. claude.ai custom
> connectors work with the same endpoints; this adds the steps:
>
> 1. Customize → Connectors → **Add custom connector**. URL: `<origin>/mcp` exactly (no trailing slash: claude.ai
>    requires the protected-resource metadata's `resource` to equal the entered URL).
> 2. **Sign in now**, OAuth client **Use Claude's published identity**. claude.ai then uses a Client ID Metadata
>    Document, which the gateway advertises (`client_id_metadata_document_supported`), so the consent page shows
>    `Client domain: claude.ai`.
> 3. Approve with the administrator token. Each approval creates an `MCP OAuth • Claude` API key.
> 4. Result: TODO (E3.2): tools listed in web, desktop and mobile.
> 5. Token refresh: TODO (E3.3): whether tool calls kept working past 1 h and 24 h, and which refresh pattern
>    appeared in the logs.
>
> Claude Code can instead use a runtime token with a header:
> `claude mcp add --transport http <name> <origin>/mcp --header "Authorization: Bearer <token>"` (tested with
> Claude Code 2.1.309 against a local Worker).
