# Azure DevOps Boards for Orca

Adds an **Azure Boards** source to Orca's Tasks list. It shows the work items of
every Azure DevOps project you have configured, most recently changed first.

Read-only. Plain Node ESM — no dependencies, no build step.

## What you need configured

The plugin never sees your credentials. Orca holds them, picks the origin and
signs every request; the plugin only names a path. Two environment variables on
the machine that runs Orca:

| Variable | Value |
| --- | --- |
| `ORCA_AZURE_DEVOPS_API_BASE_URL` | Comma-separated organization base URLs, e.g. `https://dev.azure.com/contoso,https://dev.azure.com/contoso-labs` |
| `ORCA_AZURE_DEVOPS_TOKEN` | A personal access token with **Work Items (Read)** and **Project and Team (Read)** |

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
- **Links** — each item opens the real work item page in Azure DevOps.

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

## Current limits

- **Read-only.** No commenting, no state transitions, no assignment, no editing.
  Orca hides those controls rather than offering a dead button.
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
| `task-source.mjs` | The four methods: `status`, `listScopes`, `listItems`, `getItem` |
| `boards-api.mjs` | The host proxy call, and the rules for reading its reply |
| `work-items.mjs` | WIQL (including the search clause), the field batch, and the mapping to Orca's item shape |
| `state-categories.mjs` | Azure workflow states to Orca's four categories, and the done/open state name lists the filters query on |
| `board-identifiers.mjs` | Encoding an organization and project into a scope or item id |
