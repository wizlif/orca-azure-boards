# Azure DevOps Boards for Orca

Adds an **Azure Boards** source to Orca's Tasks list. It shows the work items of
every Azure DevOps project you have configured, most recently changed first,
and opens new ones.

Plain Node ESM — no dependencies, no build step.

## What you need configured

The plugin never sees your credentials. Orca holds them, picks the origin and
signs every request; the plugin only names a path. Two environment variables on
the machine that runs Orca:

| Variable | Value |
| --- | --- |
| `ORCA_AZURE_DEVOPS_API_BASE_URL` | Comma-separated organization base URLs, e.g. `https://dev.azure.com/contoso,https://dev.azure.com/contoso-labs` |
| `ORCA_AZURE_DEVOPS_TOKEN` | A personal access token with **Work Items (Read & write)** and **Project and Team (Read)** |

`ORCA_AZURE_DEVOPS_PAT` works in place of `ORCA_AZURE_DEVOPS_TOKEN`.

One token covers every organization in the list, so all of them must accept the
same token.

When you enable the plugin, Orca asks you to consent to the
`azure-devops:boards` capability. Without it the plugin can reach nothing.

## Installing

Add this directory to Orca's developer plugin paths (Settings → Plugins), or
install it from its git URL.

## What you get

- **Scopes** — one entry per project, across every configured organization,
  named `<organization> / <project>` so two projects with the same name stay
  apart.
- **Items** — with no scope selected, the most recently changed work items of
  every configured organization. With scopes selected, only those projects.
- **State** — the raw Azure state ("Ready for QA", "Design") is shown as-is and
  mapped to Orca's todo / in-progress / done categories using each project's own
  workflow definition, so a customized process maps correctly.
- **Priority** — Azure's `Microsoft.VSTS.Common.Priority` field, shown exactly as
  Azure returns it ("1", "2", ...). Azure's numeric scale isn't uniform across
  processes, so it is never relabeled as High/Medium/Low.
- **Labels** — Azure's `System.Tags`, split on `;` and trimmed. A work item with
  no tags shows no labels.
- **Description** — the work item body, as markdown. A Bug's body is its **Repro
  Steps**, every other type's is its **Description**, and either falls back to
  the other: a Bug opened through the API usually has a Description and no Repro
  Steps.
- **Type** — the work item type name ("Bug", "User Story").
- **Comments** — the discussion, oldest first, at most one page of 200. Bodies
  are converted the same way a description is. New comments can be posted, and
  a reply is a new comment whose body opens with a quote of the original —
  Azure has no comment threading, and neither does this.
- **Links** — each item opens the real work item page in Azure DevOps.
- **Creating** — a new work item in a chosen project, given a type, a title and
  an optional description. The types on offer are the ones a person would
  actually create: a process-withdrawn type (`isDisabled`) is excluded, and so
  is one of Azure's own hidden machinery types (`Test Plan`, `Shared Steps`,
  `Code Review Request`, ...), read from `workitemtypecategories`'
  `Microsoft.HiddenCategory`. The created item comes back in the same shape a
  listed one has.

## Filters and search

`Status` declares three filter presets, rendered as chips:

| Filter | WIQL |
| --- | --- |
| Assigned to me | `[System.AssignedTo] = @Me` |
| All open | `[System.State] NOT IN (<this project's Completed/Removed state names>)` |
| Done | `[System.State] IN (<this project's Completed/Removed state names>)` |

"All open" and "Done" read each project's real workflow states (the same lookup
`State` uses) rather than guessing at names like "Closed" or "Done" — a custom
process's terminal states ("QA Sign-off", "Won't Fix") are picked up correctly.
Picking either one, with no project scope selected, queries every configured
project individually instead of the single organization-wide query used
otherwise, since the state names are per-project.

The search box matches the title: `[System.Title] CONTAINS '<term>'`. A quote in
the search term is escaped (`'` doubles to `''`) before it reaches the query, so
an apostrophe in a title or a search term can't break the WIQL or change what it
matches.

An unrecognized `filterId` fails with `validation` rather than being ignored —
it never falls back to returning every item.

## Bodies are markdown, never HTML

Azure stores a description or a comment as HTML or as markdown and says which.
Orca's task contract has no HTML body format on purpose: the renderer treats a
body as markdown, and handing it a third party's HTML is an injection vector. So
the plugin converts, and what it cannot express in markdown it drops here, where
the decision is visible.

A body Azure already stores as markdown is passed through unchanged, and
`descriptionFormat` says `markdown`. A body that is plain text with no markup at
all is passed through as `text`. Everything else is converted from HTML.

**Kept:** headings, paragraphs, line breaks, ordered and unordered lists
(including nesting), bold, italic, inline code, code blocks, `http(s)` links,
blockquotes, horizontal rules, and HTML entities (`&quot;` becomes `"`). An
unrecognized element is unwrapped — its text survives, its markup does not.

**Dropped, silently:**

| Construct | What the reader sees |
| --- | --- |
| **Images** (`<img>`, including pasted screenshots) | Nothing. Azure's attachment URLs are auth-gated, so a link would render as a broken image. A comment that is only a screenshot comes back with an **empty body**. About a third of the work item bodies in these organizations carry at least one image. |
| **Tables** | One line per row, cells joined by ` \| `, with no header rule — so a markdown renderer shows the rows as running text, not a grid. |
| Underline, strikethrough, text and highlight colours, font sizes | The text, unstyled. |
| Checkbox state in a checklist | A plain list item; ticked and unticked look the same. |
| `<dl>` definition lists | Term and definition as separate paragraphs. |
| `javascript:` and `data:` links | The link text, unlinked. |
| `<script>`, `<style>`, `<iframe>`, form controls, media | Nothing, contents included. |

A user `@`-mention written in an HTML body converts to the person's name. One
written in a markdown body stays as Azure stores it — `@<GUID>` — because
resolving it needs an identity lookup outside the Boards proxy.

Because Orca's comment contract offers only `text` and `html` for a comment
body, a converted comment is declared `text`: the one value that is true of it.
Claiming `html` would be both false and unsafe.

## Posting a comment

The plugin's `addComment` converts the caller's Markdown-ish text (paragraphs,
line breaks, `**bold**`, and `>` blockquotes) into HTML, escaping everything
else, and posts it. It never accepts raw HTML from the caller.

Azure work item comments have no parent/child threading — there is no reply
API. A "reply" is Orca's own comment composer prefilling the draft with a
Markdown blockquote naming the original author and quoting their comment,
ahead of the new text, the same way the Boards web UI's own "Reply" quotes
into a new top-level comment. `addComment` doesn't know a reply is happening;
it just renders the `>` lines it's given as a real `<blockquote>` so Azure
shows it as one.

## Current limits

- **Read, and post.** No state transitions, no assignment, no editing, no
  comment threading (Azure has none). Orca hides those controls rather than
  offering a dead button.
- **One page of comments.** At most 200, newest-first from Azure and re-sorted
  oldest-first. An older comment beyond that page is not fetched.
- **Comment author avatars are not sent.** Azure's are auth-gated and the
  renderer holds no credentials, so one would only ever be a broken image.
- **Only creatable types are offered.** A type withdrawn by a process
  (`isDisabled`) and a type in Azure's own hidden category
  (`Microsoft.HiddenCategory`, from `workitemtypecategories`) are both
  excluded. If the categories call fails, the list degrades to the
  `isDisabled`-only filter rather than failing outright.
- **A new item carries a title and a description only.** Not an assignee, not an
  area or iteration path, not a parent link.
- **No pagination.** One page of at most 200 items, whatever Orca asks for.
- **Projects are not paged.** An organization with more than 500 projects is
  listed only as far as its first 500.
- **All or nothing.** If one configured organization cannot be read, listing
  scopes or items fails with the reason instead of quietly returning the other
  organization's data. `Status` is the exception: it reports the reachable
  organizations as connected and carries the unreachable ones as a notice.

## Why a failure is never an empty list

An empty result means the board is empty. It never means an expired token or an
unreachable organization — those return an error code Orca renders as such.

This matters more than it sounds. Azure DevOps answers an unauthenticated
request with **HTTP 203 and an HTML sign-in page**, not a 401. That is a 2xx, so
anything that trusts the status code reads an expired token as a successful,
empty response. This plugin treats a success whose body is not JSON as
`unauthorized`.

## Layout

| File | Holds |
| --- | --- |
| `main.mjs` | `activate` — registers the task source |
| `task-source.mjs` | The contract methods: `status`, `listScopes`, `listItemTypes`, `listItems`, `getItem`, `listComments`, `createItem` |
| `boards-api.mjs` | The host proxy call, and the rules for reading its reply |
| `work-items.mjs` | WIQL (including the search clause), the field batch, the JSON Patch create, and the mapping to Orca's item and detail shapes |
| `work-item-comments.mjs` | One page of comments, in the shape Orca renders them |
| `html-to-markdown.mjs` | The HTML-to-markdown conversion every body goes through |
| `work-item-types.mjs` | One cache of each project's work item types: Azure workflow states to Orca's four categories, the done/open state name lists the filters query on, and the types a new item may be opened as |
| `board-identifiers.mjs` | Encoding an organization and project into a scope or item id |
