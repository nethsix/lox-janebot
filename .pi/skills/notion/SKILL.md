---
name: notion
description: Search, read, create, and update Notion pages, databases, and blocks using the Notion API. Use when the user asks about Notion content, wants to create or edit Notion pages, or query Notion databases.
---

# Notion API

All requests use the `NOTION_TOKEN` environment variable for authentication.

## Common Headers

Every `curl` call must include:

```bash
-H "Authorization: Bearer $NOTION_TOKEN" \
-H "Notion-Version: 2022-06-28" \
-H "Content-Type: application/json"
```

## Search

Search across all pages and databases the integration has access to:

```bash
curl -s -X POST 'https://api.notion.com/v1/search' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "SEARCH_TERM", "page_size": 10}'
```

Filter by object type:

```bash
# Pages only
-d '{"query": "SEARCH_TERM", "filter": {"value": "page", "property": "object"}}'

# Databases only
-d '{"query": "SEARCH_TERM", "filter": {"value": "database", "property": "object"}}'
```

## Retrieve a Page

```bash
curl -s 'https://api.notion.com/v1/pages/PAGE_ID' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```

## Retrieve Page Content (Blocks)

```bash
curl -s 'https://api.notion.com/v1/blocks/BLOCK_OR_PAGE_ID/children?page_size=100' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```

For nested blocks, recursively fetch children of any block that `has_children: true`.

## Query a Database

```bash
curl -s -X POST 'https://api.notion.com/v1/databases/DATABASE_ID/query' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"page_size": 10}'
```

With filters:

```bash
-d '{
  "filter": {
    "property": "Status",
    "select": {"equals": "In Progress"}
  },
  "sorts": [{"property": "Created", "direction": "descending"}],
  "page_size": 10
}'
```

Common filter types:
- `"title": {"contains": "text"}` — title property
- `"rich_text": {"contains": "text"}` — text property
- `"select": {"equals": "Option"}` — select property
- `"multi_select": {"contains": "Tag"}` — multi-select
- `"checkbox": {"equals": true}` — checkbox
- `"date": {"after": "2024-01-01"}` — date property

## Retrieve a Database Schema

```bash
curl -s 'https://api.notion.com/v1/databases/DATABASE_ID' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```

## Create a Page

```bash
curl -s -X POST 'https://api.notion.com/v1/pages' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"page_id": "PARENT_PAGE_ID"},
    "properties": {
      "title": [{"text": {"content": "Page Title"}}]
    },
    "children": [
      {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
          "rich_text": [{"type": "text", "text": {"content": "Hello world"}}]
        }
      }
    ]
  }'
```

To create a page in a database, use `"parent": {"database_id": "DB_ID"}` and set the database properties.

## Update Page Properties

```bash
curl -s -X PATCH 'https://api.notion.com/v1/pages/PAGE_ID' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "Status": {"select": {"name": "Done"}}
    }
  }'
```

## Append Blocks to a Page

```bash
curl -s -X PATCH 'https://api.notion.com/v1/blocks/PAGE_OR_BLOCK_ID/children' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "children": [
      {
        "object": "block",
        "type": "heading_2",
        "heading_2": {
          "rich_text": [{"type": "text", "text": {"content": "New Section"}}]
        }
      },
      {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
          "rich_text": [{"type": "text", "text": {"content": "Content here."}}]
        }
      }
    ]
  }'
```

## Block Types

Common block types for `children` arrays:
- `paragraph` — body text
- `heading_1`, `heading_2`, `heading_3` — headings
- `bulleted_list_item`, `numbered_list_item` — list items
- `to_do` — checkbox items (add `"checked": false`)
- `code` — code block (add `"language": "python"`)
- `quote` — blockquote
- `divider` — horizontal rule (`"divider": {}`)
- `toggle` — collapsible block

## List All Users

```bash
curl -s 'https://api.notion.com/v1/users' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```

## Pagination

When a response includes `"has_more": true`, pass `"start_cursor": "NEXT_CURSOR"` in the request body (POST) or as a query param (GET) to fetch the next page.

## Tips

- Page IDs and database IDs are UUIDs (32 hex chars). They can be extracted from Notion URLs: `notion.so/Page-Title-<ID>` where the last 32 chars (ignoring hyphens) are the ID.
- The integration only has access to pages/databases explicitly shared with it in Notion's UI.
- Rate limit: 3 requests/second. Add short delays between bulk operations.
