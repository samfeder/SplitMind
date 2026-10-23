# Spike: Notion provider (E4.1, #19)

Read against OpenConnector **v1.9.2** (`2748be7758ad388b4eb59a33696285a8444a3c81`), the commit `vendor/open-connector` is pinned to. Source links point at that tag; re-check them when the pin moves (see [upgrading-openconnector.md](../upgrading-openconnector.md)).
All references are paths in that tree. No workspace was connected and no secret was used.

## TL;DR

- **Provider id is `notion`**, so the decision 7 allowlist entry `notion.*` is right. It does *not* match the separate `notion_mcp` provider (prefix match on `notion.`, [`src/core/action-policy.ts:331-333`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/core/action-policy.ts#L331-L333)).
- **Recommendation: one internal integration per workspace (`api_key`)**, connected as two named connections. Reasoning below.
- **Decision 8 holds today:** with two named connections and no `default`, an unnamed `execute_action` write is refused before any HTTP request leaves the Worker. Proven by a probe (evidence below).
- **Two footguns**, both with a guardrail: the Web Console pre-fills the name `default` for a provider's first connection, and the refusal message for an unnamed call is misleading ("Configure notion credentials first", code `authorization_failed`).
- **Coverage gaps: none that block E4.** Every action E4 needs exists. Comments need two extra capabilities ticked on the integration.

## Known vs. assumed

| Claim | Status |
|---|---|
| Auth types `oauth2` + `api_key` | Known: [`src/providers/notion/definition.ts:20-40`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/definition.ts#L20-L40) |
| Omitted alias resolves to the connection literally named `default` | Known: [`src/connection-service.ts:27`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/connection-service.ts#L27), [`src/connection-service.ts:1150-1151`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/connection-service.ts#L1150-L1151) |
| Unnamed write with no `default` makes no HTTP call | Known: probe run below |
| Internal integrations need a Workspace Owner to create | Known, Notion docs ([Internal connections](https://developers.notion.com/guides/get-started/internal-connections)) |
| The operator is a Workspace Owner in each workspace | **Assumed.** If not, an owner must create the integration, or use OAuth (below) |
| Behavior on the deployed Worker matches the in-process probe | Assumed until E6.1 runs against the real `/mcp` |

## 1. Auth types

[`src/providers/notion/definition.ts`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/definition.ts):

- `oauth2` (lines 22-32): Notion public OAuth, `owner: user`, scopes `read_content, insert_content, update_content, read_comments, insert_comments` ([`src/providers/notion/scopes.ts`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/scopes.ts)). Needs an OAuth client (client id/secret) configured in OpenConnector.
- `api_key` (lines 33-39): "Internal Integration Secret", sent as `Authorization: Bearer`.

There is also a second provider, **`notion_mcp`** ([`src/providers/notion_mcp/definition.ts`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion_mcp/definition.ts)): OAuth against Notion's hosted MCP server, acting as the signed-in user, set up by hand via DCR. It's marked beta upstream ("tool names and result shapes can change without notice"). It has 8 actions (`get_self, search, fetch_page, list_comments, tool_access, create_pages, update_page, create_comment`) and **no query-database or archive action**. Not recommended for v0.1.

### Recommendation (decision 5): `api_key`, one internal integration per workspace

| | Internal integration (`api_key`) | Public OAuth (`oauth2`) |
|---|---|---|
| Setup per workspace | Create integration, tick capabilities, copy secret, share the test page with it | Once: create a public connection (redirect URI `<origin>/oauth/callback`, installation scope picked at creation and permanent). Per workspace: authorize + page picker |
| Extra OpenConnector config | None | OAuth client config, and a client secret the operator has to enter |
| Independence of the two connections | Total: two different bots, two different secrets | One app, two grants. Revoking the app hits both |
| Token lifecycle | Static, never expires | Access + refresh rotation (`authorization.md`: "Refreshing ... will generate a new access token and a new refresh token"), one more thing to break |
| Acts as | Its own bot. Access survives people leaving | The authorizing user |
| Blast radius | Only pages explicitly shared with it | Only pages picked |
| Limitation | Needs Workspace Owner | Public connection reaches "Submitted for review" before the Authorization URL appears (per Notion docs). Unclear if review blocks own use |

Internal integrations win on least setup and strongest independence, and they keep the Notion side clear of OAuth while E3 is busy proving claude.ai OAuth. Fall back to `oauth2` only for a workspace where the operator isn't an owner.

Capabilities to tick on each integration: Read content, Update content, Insert content, **Read comments, Insert comments** (comments are off by default and not implied by content capabilities: [`src/providers/notion/scopes.ts:8-11`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/scopes.ts#L8-L11)). "Read user information" is optional and only matters for `list_users` / `retrieve_user`.

**Display name:** the credential validator labels the connection with `bot.workspace_name` ([`src/providers/notion/executors.ts:371`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/executors.ts#L371)), so `list_connections` shows each workspace's name for E4.2 with no extra setup.

## 2. Action coverage (provider `notion`, 32 actions, Notion API version `2026-03-11`, [`src/providers/notion/executors.ts:34`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/executors.ts#L34))

| Need (E4.1) | Action id(s) | Type |
|---|---|---|
| Search | `notion.search` | read |
| Read page | `notion.get_page` (page + first-level blocks), `notion.retrieve_page_markdown`, `notion.retrieve_page`, `notion.list_block_children` | read |
| Query database | `notion.query_data_source` (+ `retrieve_database`, `retrieve_data_source`). Notion now queries *data sources*, not databases; get the data source id from `retrieve_database` | read |
| Create page | `notion.create_page` (`parentId` + `title`, or `markdown`) | write |
| Update / append | `notion.update_page`, `notion.update_page_markdown`, `notion.append_block`, `notion.append_block_children`, `notion.update_block` | write / destructive |
| Archive (E4.3) | `notion.update_page` with `in_trash: true` ([`src/providers/notion/actions.ts:486`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/actions.ts#L486)) | destructive |
| Comments | `notion.list_comments`, `notion.create_comment` | read / write |
| Who am I | `notion.get_current_user`: workspace + owner from stored metadata, no API call | read |

Others: `move_page`, `delete_block`, `create_database`, `update_database`, `create_data_source`, `update_data_source`, `list_data_source_templates`, `list_views`, `retrieve_view`, `update_view`, `retrieve_page_property`, `list_users`, `retrieve_user`, `retrieve_block`. Plus one trigger, `on_database_page_event`.

Upstream tests pass at this tag:

```
$ npx vitest run src/providers/notion src/providers/notion_mcp src/connection-service.test.ts src/mcp.test.ts
 Test Files  6 passed (6)
      Tests  148 passed (148)
```

## 3. Named connections and decision 8

How a connection is picked:
- `execute_action` takes an optional `connectionName` ("Omit it to use the default connection.", [`src/mcp.ts:49-54`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/mcp.ts#L49-L54)).
- The name is normalized with `value?.trim() || "default"` ([`src/connection-service.ts:1150-1151`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/connection-service.ts#L1150-L1151)), so **"default" is just a connection literally named `default`**. Nothing else promotes a connection to default (`default: stored.connectionName === defaultConnectionName`, line 570).
- Unknown explicit name → `connection_not_found` (lines 355-357).
- No name and nothing stored as `default` → credential `undefined`. The Notion executor throws `ProviderRequestError(401, "Configure notion credentials first.")` while building the request ([`src/providers/notion/executors.ts:278-284`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/providers/notion/executors.ts#L278-L284)), before any fetch.
- If a runtime token has `allowedConnections`, an unnamed call is refused even earlier with `connection_not_allowed` ([`src/core/action-policy.ts:226-245`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/core/action-policy.ts#L226-L245)).

**Probe evidence.** The snippet in [Appendix: probe](#appendix-probe) was appended to upstream [`src/mcp.test.ts`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/mcp.test.ts) and using upstream helpers. It uses the real `notion` provider and executors, with two stored connections `notion_a` / `notion_b`, no `default`, and `fetch` stubbed to record calls (fake keys, no network):

```
$ npx vitest run src/e4-1-probe.test.ts -t "SplitMind E4.1 probe" --silent=false
### list_connections notion
{"ok":true,"data":[{"id":"c-a","service":"notion","connectionName":"notion_a","authType":"api_key","default":false,"profile":{"accountId":"bot-A","displayName":"Workspace A","grantedScopes":[]}},{"id":"c-b","service":"notion","connectionName":"notion_b","authType":"api_key","default":false,"profile":{"accountId":"bot-B","displayName":"Workspace B","grantedScopes":[]}}]}
### create_page, no connectionName
{"ok":false,"error":{"code":"authorization_failed","message":"Configure notion credentials first.","details":{"status":401}},"executionId":"d9862357-…","auditPersisted":true}
HTTP calls so far: []
### create_page, connectionName=default
{"ok":false,"error":{"code":"connection_not_found","message":"notion connection not found: default."}}
HTTP calls so far: []
### create_page, connectionName=notion_b
{"ok":true,"data":{"object":"page","id":"p1","properties":{}},"executionId":"f158ffca-…","auditPersisted":true,"connection":{"id":"c-b","service":"notion","connectionName":"notion_b","authType":"api_key","default":false,"profile":{"accountId":"bot-B","displayName":"Workspace B","grantedScopes":[]}}}
HTTP calls so far: ["POST https://api.notion.com/v1/pages auth=Bearer probe-B"]
 Test Files  1 passed (1)
```

So: the unnamed write is refused with zero HTTP calls, and the named write goes only to the named account's key. A successful result also carries `connection.profile`, which is useful evidence for E6.2.

This is an in-process spike probe, not SplitMind's test. SplitMind's rules put behavior tests at the deployed Worker's `/mcp`, so E6.1 (#28) should repeat these three calls there, with independent literal expectations: `ok:false` with no alias, `ok:false` / `connection_not_found` for `default`, and no `default:true` row in `list_connections`.

### Footguns

1. **Web Console pre-fills `default`** as the name of a provider's first connection: `useState(props.connections.length === 0 ? defaultConnectionName : "")` ([`web/src/providers-page.tsx:1073-1074`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/web/src/providers-page.tsx#L1073-L1074)). The API path does the same if `connectionName` is left off (`PUT /api/connections/:service` → `readConnectionName` → undefined → `default`). **Operator step in E4.2 (#20): overwrite that field.** Guardrail: the E6.1 test fails if any `notion` or `slack` connection reports `default: true`.
2. **Misleading refusal.** An unnamed call looks like a broken credential (`authorization_failed`, 401) instead of "pick an account". Claude may retry or report a bad token. Upstream issue drafted (U1).

## 4. Gaps

| # | Gap | Matters for v0.1? | Action |
|---|---|---|---|
| U1 | No-alias call with no default returns `authorization_failed` / 401 rather than a "connection required" error listing aliases | Yes (UX for Claude, E6.1 clarity) | Draft upstream issue (below) |
| U2 | No way to forbid a default connection per provider; it's procedural only (footgun 1) | Yes (decision 8 is enforced by naming discipline) | Draft upstream issue; meanwhile, SplitMind test + docs |
| U3 | Per-connection read-only isn't a thing; policy is per action, and `allowedConnections` is per token | E6.4 | Not Notion-specific; E6.4 owns it. Workaround: a runtime token with a read-only action allowlist |
| — | `notion_mcp` lacks query-database and archive | No (not using it) | None |
| — | Upstream `package-lock.json` has one `registry.npmmirror.com` URL (`@cloudflare/workers-oauth-provider`); `npm ci` got 403 here until it was rewritten to registry.npmjs.org | Maybe, for `bootstrap.sh` in CI and on fresh machines | Possible small upstream PR; `scripts/bootstrap.sh` runs `npm ci` in the submodule |

Nothing in this spike contradicts the pinned decisions or license, so no tripwire.

## 5. Draft upstream issues (not filed yet; filing waits for the maintainer's OK)

### U1 — `execute_action` without `connectionName` and no default returns a misleading auth error

> **What happens.** For a credentialed provider with only named connections (no `default`), `execute_action` / `POST /v1/actions/...` with no `connectionName` returns `{"code":"authorization_failed","message":"Configure notion credentials first.","details":{"status":401}}`. Seen with `notion` at v1.9.2. The cause is that `ConnectionService.resolveForExecution` returns an undefined credential instead of throwing ([`src/connection-service.ts:343-375`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/connection-service.ts#L343-L375)), so the executor's own "configure credentials" error fires.
>
> **Expected.** A connection error before the executor runs, e.g. `connection_required: notion has no default connection; pass connectionName (available: a, b)`, consistent with `connection_not_found` for an explicit unknown name. MCP clients (Claude, ChatGPT) can then recover by calling `list_connections` instead of reporting a bad token.
>
> **Proposal.** In `resolveForExecution` / `getConnectionSummary`, when the provider doesn't support `no_auth`, no name is given, nothing is stored as `default`, and no marketplace connection applies, throw `ConnectionError("connection_required", …)`. Happy to send a PR with a test in [`src/mcp.test.ts`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/src/mcp.test.ts).

### U2 — Option to require an explicit connection name for some providers

> **Use case.** Multi-account deployments where a write must never land on an implicit account. Today the only defence is never creating a connection named `default`, but the Web Console pre-fills `default` for a provider's first connection ([`web/src/providers-page.tsx:1073-1074`](https://github.com/oomol-lab/open-connector/blob/v1.9.2/web/src/providers-page.tsx#L1073-L1074)).
>
> **Proposal.** `OOMOL_CONNECT_REQUIRE_CONNECTION_NAME="notion,slack"` (or `*`). For listed services: (a) reject creating a connection named `default`, (b) the console doesn't pre-fill `default`, (c) a call with no `connectionName` gets `connection_required` (U1). This fits next to the existing `ALLOWED_*` / `BLOCKED_*` policy variables.

## 6. Policy notes for E2.3

- `OOMOL_CONNECT_ALLOWED_ACTIONS="notion.*,slack.*"` (the Slack spike, #23, confirms `slack`). `notion.*` includes destructive actions (`update_page`, `delete_block`, `update_database`, …). That's fine for v0.1, since E4.3 needs `update_page` to archive.
- The `notion` provider has a trigger (`on_database_page_event`). Triggers have their own allow/block variables; consider `OOMOL_CONNECT_BLOCKED_TRIGGERS="*"` for v0.1 (decided in E2.3, #10).

## Appendix: probe

Appended to upstream `src/mcp.test.ts` at v1.9.2, which supplies `MemoryConnectionStore`, `MemoryRunLogStore`, `policySnapshotFor` and the imports. It is spike evidence only, not a SplitMind test. The keys are fake and `fetch` is stubbed, so no request leaves the process.

```ts
// ---- SplitMind E4.1 probe: Notion with two named connections and no default ----
import { provider as notionProvider } from "./providers/notion/definition.ts";
import { ProviderLoader } from "./providers/provider-loader.ts";

const notionCredential = (label: string): ResolvedCredential => ({
  authType: "api_key",
  apiKey: `probe-${label}`,
  values: { apiKey: `probe-${label}` },
  profile: { accountId: `bot-${label}`, displayName: `Workspace ${label}`, grantedScopes: [] },
  metadata: {},
});

async function withNotionNoDefault(run: (client: Client, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const auth = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined)).get("authorization");
    calls.push(`${init?.method ?? "GET"} ${target} auth=${auth}`);
    return new Response(JSON.stringify({ object: "page", id: "p1", properties: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const catalog = createCatalogStore([notionProvider], {
    executableActionIds: notionProvider.actions.map((a) => a.id),
  });
  const providerLoader = new ProviderLoader({ notion: () => import("./providers/notion/executors.ts") } as never);
  const connections = new ConnectionService({
    catalog,
    providerLoader,
    store: new MemoryConnectionStore([
      { id: "c-a", revision: "r-a", service: "notion", connectionName: "notion_a", credential: notionCredential("A") },
      { id: "c-b", revision: "r-b", service: "notion", connectionName: "notion_b", credential: notionCredential("B") },
    ]),
  });
  const actions = new ActionRunner({ catalog, providerLoader, connections, runs: new MemoryRunLogStore() });
  const server = createMcpServer({ catalog, connections, actions, getPolicySnapshot: policySnapshotFor({}) });
  const client = new Client({ name: "probe", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    await run(client, calls);
  } finally {
    await client.close();
    vi.unstubAllGlobals();
  }
}

describe("SplitMind E4.1 probe", () => {
  it("prints behaviour", async () => {
    await withNotionNoDefault(async (client, calls) => {
      const show = async (label: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name: "execute_action", arguments: args });
        console.log(`\n### ${label}\n${JSON.stringify(r.structuredContent)}\nHTTP calls so far: ${JSON.stringify(calls)}`);
      };
      const lc = await client.callTool({ name: "list_connections", arguments: { service: "notion" } });
      console.log(`\n### list_connections notion\n${JSON.stringify(lc.structuredContent)}`);
      await show("create_page, no connectionName", {
        actionId: "notion.create_page",
        input: { parentId: "parent-1", title: "probe" },
      });
      await show("create_page, connectionName=default", {
        actionId: "notion.create_page",
        input: { parentId: "parent-1", title: "probe" },
        connectionName: "default",
      });
      await show("create_page, connectionName=notion_b", {
        actionId: "notion.create_page",
        input: { parentId: "parent-1", title: "probe" },
        connectionName: "notion_b",
      });
    });
  });
});
```
