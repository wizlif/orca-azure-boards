# Azure Boards plugin — screenshots

Captured from the Orca dev build in dark mode via Playwright over CDP.

| File | Shows |
| --- | --- |
| `01-source-bar.png` | The contributed tab (Azure mark) beside the built-in GitHub and Jira tabs, icon-only. |
| `02-list-and-facets.png` | The work item list with the facet bar — State / Sprint / Assignee / Type — the project scope picker, search, and grouping by state. |
| `03-facet-open.png` | The State facet open, showing per-project states fetched from the board. |
| `04-detail-panel.png` | The detail panel: description, comments, quoted replies, and the comment composer. |
| `05-start-workspace.png` | Start workspace, with the work item carried into the composer as a linked source (note the Azure mark on the pill). |

## Content is substituted, not real

The UI is genuine and live against Azure DevOps. The content shown is not.

Before each capture, the page is rewritten in place:

- Work item titles are replaced from a fixed pool of plausible engineering tickets.
- Assignee and comment-author names are replaced with invented people, consistently — the same real person always maps to the same fake one, and avatar initials are regenerated to match.
- Tag chips are replaced with generic labels (`api`, `frontend`, `payments`, …).
- The account usage readout in the status bar is cleared.

Work item numbers, states, priorities and timestamps are left alone; they carry no meaning outside the organisation.

Item **2488** keeps its real title and body throughout: it is a throwaway item created by the plugin's own smoke test, so its content is already synthetic. That is the item shown in `04` and `05`.
