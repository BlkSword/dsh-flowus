---
name: flowus
description: "Use when work touches the user's FlowUs workspace: searching or reading pages, blocks, databases or mind maps; editing page content; creating pages, databases or views; or uploading files. Routes to the right flowus_* tool and states the help-first and one-call-at-a-time rules the FlowUs MCP server enforces."
whenToUse: "The user names FlowUs, or asks to search, read, edit, create, move or organize pages, databases, mind maps or files in their workspace."
---

# FlowUs workspace

FlowUs is the user's workspace: pages form a tree, databases hold records with
typed properties, and mind maps are separate documents. Every operation goes
through a `flowus_*` tool. A host may prefix those names with a server name
(`mcp__flowus__flowus_get_page`); the `flowus_*` suffix is the stable part.

## Rules that always hold

**Look up a tool's arguments before calling it.** `flowus_help` takes `query` as
an array of 1-20 names, even for one tool:

```
flowus_help(query=["flowus_create_page"], detail="input")
```

Use `detail="input"` for arguments, `detail="output"` for a result shape, and
`detail="full"` when the task involves relation, formula or rollup properties —
it carries callable example calls. An argument shape looked up once is reusable
for the rest of the session; do not rediscover it per call. Never guess a shape
and retry on error, and never ask the user to paste content out of FlowUs — read
it with the tools.

**Issue FlowUs calls one at a time.** The server accepts a single in-flight call
per session and answers a parallel second call with JSON-RPC `-32002`. Run them
serially; if a call still returns `-32002`, retry that call once with a short
backoff instead of reordering the workflow.

**Bind every ID from something you read.** IDs come from a read result or a
creation result. A placeholder or remembered ID left in a write request is the
most common cause of a failed write, and a plausible-looking wrong ID is worse
than a failure.

**Say what you are about to change, and confirm anything destructive.** Updating
a block, overwriting a property value, replacing a view's filter or `page_sort`,
moving a page, and every file upload all change or discard user content. State
the target and the effect first. Prefer adding to what exists over rewriting it.

## Find the target

| The user wants | Tool |
|---|---|
| "What's in my space / sidebar?" or any full directory listing | `flowus_list_workspace_directory` |
| Something matching keywords | `flowus_search_text` |
| Something conceptually similar | `flowus_search_semantic` |
| Children of a known page | `flowus_list_pages` (requires `parent_id`) |
| Favorites, private, shared or team pages | `flowus_list_favorite_pages`, `flowus_list_private_pages`, `flowus_list_share_pages`, `flowus_list_team_pages` |
| Identity and workspace facts | `flowus_get_current_user`, `flowus_get_space`, `flowus_list_users`, `flowus_get_user` |

When the user supplies a **link**, pass it to `flowus_fetch`: it detects whether
the target is a page, folder, mind map, database or block, and returns page
bodies as Markdown. Do not guess the type first.

`flowus_list_pages` serves a known parent only — it is not how the space root is
listed — and a node reporting `has_children: true` is worth descending into.

## Read

- `flowus_fetch` — any link or ID; the default way to open something.
- `flowus_get_page_markdown` — one page's body as Markdown. Read this before editing its text.
- `flowus_get_page` / `flowus_get_page_property` — metadata and property values; these also work for database records.
- `flowus_get_block` / `flowus_get_block_children` — block-level structure. Both paginate: keep passing the returned cursor until it is exhausted.

## Write pages

`flowus_create_page` takes the parent, the title and any initial content in one
`body`. Then `flowus_append_block_children`, `flowus_update_block`,
`flowus_update_page` (icon, cover and properties), `flowus_move_page`,
`flowus_duplicate_page`.

`flowus_duplicate_page` is synchronous: the copy is complete when it returns, so
do not poll. If it reports success but the rename failed, update the new page ID
named in the error — never duplicate again to fix a rename.

**`flowus_edit_page_text` is the cheap path for changing a word or a sentence,
and it is deliberately narrow.** It replaces text only inside a single text
block's single format segment. It refuses subpages, databases, mind maps,
tables, sync blocks, templates, files and columns, because rewriting those as
literals would rename or sever the object; it refuses a match spanning format
segments, because merging them would drop bold, italic, code or colour; and it
refuses an ambiguous match unless `replace_all` is set. Read the page first,
copy `old_str` verbatim from what you read, and keep it long enough to be
unique. Anything structural belongs in `flowus_update_block`.

## Databases

`flowus_create_database` defines a new database — parent, title and properties,
relation, formula and rollup included — and `flowus_get_database` returns the
schema and the **property IDs**. Then `flowus_query_database` for records,
`flowus_mutate_database` to change records and property definitions in one
transaction, and `flowus_update_database` for a single schema change. A record
is itself a page, so its property values are written with `flowus_update_page`
or `flowus_mutate_database`.

- Paging arguments sit at the top level of `flowus_query_database`; complex filters and sorts go in the body. Follow the returned cursor while `has_more` is true. Formula filters and sorts are unsupported.
- Formula and rollup values are **read-only**. Read `formula.type` and `formula.value`, and report `formula.error` rather than writing a value.
- `flowus_mutate_database` cannot delete records; a request carrying `delete_records` is rejected. Only submit the parts that change: rename a property by ID, update a record by `record_id`, and reuse one idempotency key when retrying.

Views — `flowus_list_database_views`, `flowus_get_database_view`,
`flowus_create_database_view`, `flowus_update_database_view`:

- A view's `type` is fixed at creation (`table`, `board`, `gallery`, `list`, `calendar`, `timeline`, `form`). A `board` needs a single-select property to group by, and `calendar` and `timeline` need date properties, so create the property first.
- Filters and sorts address a property by **ID**, and every `value` is a string. Formula and rollup properties cannot appear in a filter, `isEmpty` and `mode` included.
- On update, each field you pass **replaces that field entirely**, and `page_sort` replaces the whole manual order, so it must list every record ID. Read the view first, then send each field back complete.
- These tools cannot delete a view.

## Relation, formula and rollup properties

The demanding path, and the one most often done wrong:

1. Request `flowus_help` with `detail="full"` for the database and page tools.
2. Read the databases involved with `flowus_get_database`. A relation property declares its target database, and you need the real property IDs from both sides.
3. Create or bind the records, then write the relation with `flowus_mutate_database`, using only IDs you actually read.
4. **Read back both sides** — the relation on the source record, and `formula.type` / `formula.value` or `error` on the dependent one. An unverified write is not a completed write.

## Files, media and mind maps

`flowus_create_file_upload` returns a one-shot upload transaction. Upload the
bytes to the returned address, then attach the block with
`flowus_append_hosted_file` using the `oss_name` and `size` **from that same
response**. Requesting a second upload address produces a different object key,
and mixing results from two calls attaches the wrong file. Do not write the
upload URL or its headers into logs or into your reply.

`flowus_append_external_media` accepts only publicly reachable image, audio or
video HTTP(S) URLs. PDFs, Office documents and archives must use the upload
path, because external links of those types are not supported.

Mind maps: `flowus_create_mind_map` takes a nested node tree. Before calling
`flowus_edit_mind_map`, call `flowus_get_mind_map` immediately and use only the
node IDs from that result — the earlier ones are stale.
