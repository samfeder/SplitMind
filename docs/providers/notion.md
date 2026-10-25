# Notion

SplitMind reaches each Notion workspace through **one public Notion connection** (Notion's OAuth app) that you
create once. Each workspace you authorize becomes a **named connection** of the `notion` provider, and Claude picks
the workspace by passing the connection's name.

> Every value in `<angle brackets>` is a placeholder. Never commit real workspace names, client secrets, page ids or
> your Worker URL.

## Before you start

- SplitMind is deployed and `<origin>/setup/` opens (see the [setup page guide](../setup/connect-accounts.md)).
- The action allowlist includes Notion: `OOMOL_CONNECT_ALLOWED_ACTIONS` contains `notion.*`.

## 1. Create the public connection (once)

1. In Notion's developer portal (**Settings → Connections → Develop or manage integrations**), open **Public
   connections → Create new connection**.
2. Name it `SplitMind`. Pick any of your workspaces as the development workspace.
3. **Installation scope:** **Selected workspaces only**, and tick every workspace you want to connect. This can't be
   changed later, and it keeps the connection private to you (it can't be listed in Notion's Marketplace).
4. **Capabilities:** Read content, Update content, Insert content, Read comments, Insert comments. Without the comment
   capabilities, `notion.list_comments` and `notion.create_comment` fail.
5. **Redirect URI:** `<origin>/oauth/callback`, exactly, with no trailing slash. The setup page shows it with a copy
   button.
6. Create it, then copy the **OAuth client ID** and **OAuth client secret** from the **Configuration** tab into the
   Notion card on `<origin>/setup/` and click **Save**.

## 2. Connect each workspace

1. On `<origin>/setup/`, type a nickname for the workspace, such as `<alias-a>`, and click **Connect a workspace**.
   - SplitMind never uses a default Notion connection, so every write has to name its account. The page refuses
     `default` and blank names.
   - Nicknames use letters, digits, `_` and `-`, start with a letter or digit, and are at most 64 characters.
2. On Notion's screen, pick the workspace, then **select the pages** SplitMind may see. Sharing a page also shares its
   children. For v0.1, share only the test page you designated (review point R3).
3. Repeat for the second workspace with `<alias-b>`.

To share more pages later, open the page in Notion, then **•••** → **Connections** → add `SplitMind`.

## 3. Check it

Ask Claude: "List my Notion connections." It calls `list_connections`. You should see two entries:

```json
{"connectionName":"<alias-a>","default":false,"profile":{"displayName":"<workspace A name>"}}
{"connectionName":"<alias-b>","default":false,"profile":{"displayName":"<workspace B name>"}}
```

If either entry shows `"default": true`, delete it and add it again under an alias.

## Using it from Claude

Name the account in your request ("search `<alias-a>` for …"). Claude passes it as `connectionName`.

| To | Action |
|---|---|
| Search | `notion.search` |
| Read a page | `notion.get_page` or `notion.retrieve_page_markdown` |
| Query a database | `notion.retrieve_database` (to get its data source id), then `notion.query_data_source` |
| Create a page | `notion.create_page` |
| Edit or append | `notion.update_page_markdown`, `notion.append_block`, `notion.append_block_children` |
| Archive a page | `notion.update_page` with `in_trash: true` |
| Comments | `notion.list_comments`, `notion.create_comment` |

A call with no account name is refused. At OpenConnector v1.9.2 the error reads "Configure notion credentials first." That means "name an account", not a bad secret.

## Rotating or removing a workspace

- **Reconnect:** click **Reconnect** next to the workspace on `<origin>/setup/`.
- **Remove:** click **Disconnect** on `<origin>/setup/`. To cut access from Notion's side too, remove `SplitMind`
  under the workspace's **Settings → Connections**.

## Using an internal integration instead

The `notion` provider also accepts an **internal integration secret** (`api_key`). Use it for a workspace that the
public connection can't be installed in, for example one whose owner blocks members from adding connections.

1. As a **Workspace Owner**, create an **internal** connection in Notion's developer portal, with the same
   capabilities as above, and copy its **Internal Integration Secret**.
2. Share pages with it: open a page, then **•••** → **Connections** → add the integration.
3. In the Web Console, open **Providers → Notion**, choose **Internal Integration Secret**, paste the secret and
   **replace the pre-filled connection name `default`** with an alias. Save.

To rotate it, create a new secret in Notion and save it again under the same alias.

Don't confuse either with the separate `notion_mcp` provider (Notion's hosted MCP, beta). SplitMind doesn't use
`notion_mcp`, and `notion.*` doesn't allow it.
