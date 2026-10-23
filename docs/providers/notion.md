# Notion

SplitMind reaches each Notion workspace through its own **internal integration**, stored in OpenConnector as a **named connection** of the `notion` provider. Claude picks the workspace by passing the connection's name.

> Every value in `<angle brackets>` is a placeholder. Never commit real workspace names, integration secrets, page ids or your Worker URL.

## Before you start

- SplitMind is deployed and the Web Console opens (see the Cloudflare setup guide).
- The action allowlist includes Notion: `OOMOL_CONNECT_ALLOWED_ACTIONS` contains `notion.*`.
- You are a **Workspace Owner** in each workspace. Notion only lets owners create internal integrations. If you aren't an owner, ask one to do step 1 for you, or see [Using OAuth instead](#using-oauth-instead).

## 1. Create an internal integration (once per workspace)

1. Open Notion's integrations dashboard (Developer portal) and create a new **internal** connection in `<workspace>`.
2. Name it, e.g. `SplitMind`.
3. Under **Configuration → Capabilities**, tick:
   - Read content
   - Update content
   - Insert content
   - Read comments
   - Insert comments

   Comment access is off by default. Without it, `notion.list_comments` and `notion.create_comment` fail.
4. Copy the **Internal Integration Secret**. Don't paste it anywhere except the Web Console field in step 3.

## 2. Share pages with the integration

The integration sees nothing until you share pages with it. Sharing a page also shares its children.

- In Notion, open a page, then **•••** → **Connections** → **+ Add connection** → choose the integration.
- For v0.1, share only the test page you designated (review point R3), not your whole workspace.

## 3. Add the named connection

1. In the SplitMind Web Console, open **Providers → Notion**.
2. Choose **Internal Integration Secret** and paste the secret.
3. **Replace the pre-filled connection name `default`** with a short alias, such as `<alias-a>`.
   - SplitMind never uses a default Notion connection, so every write has to name its account.
   - Aliases use letters, digits, `_` and `-`, start with a letter or digit, and are at most 64 characters.
   - Pick something you'll recognise in chat, but don't use an identifying workspace name if you share screenshots.
4. Save, then repeat steps 1–3 for the second workspace with `<alias-b>`.

## 4. Check it

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

- **Rotate:** create a new secret for the integration in Notion, then update the connection with the same alias in the Web Console.
- **Remove:** delete the connection in the Web Console, and delete or disconnect the integration in Notion.

## Using OAuth instead

The `notion` provider also supports Notion public OAuth (`oauth2`). It needs:

- a public Notion connection with redirect URI `<origin>/oauth/callback`;
- its client id and secret configured in OpenConnector;
- each workspace authorized through Notion's page picker.

It's more setup and adds token refresh. Use it only for a workspace where you can't create an internal integration.

Don't confuse it with the separate `notion_mcp` provider (Notion's hosted MCP, beta). SplitMind doesn't use `notion_mcp`, and `notion.*` doesn't allow it.
