/**
 * Reads and opens work items: a WIQL query for the ids in the order the board
 * wants them, then a field batch for their contents, then the shape Orca
 * renders — which a newly created item is mapped through too.
 */

import { failure } from './boards-api.mjs'
import { encodeItemId } from './board-identifiers.mjs'
import { decodeHtmlEntities, htmlToMarkdown, isPlainText } from './html-to-markdown.mjs'

const FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.AssignedTo',
  'System.ChangedDate',
  'System.TeamProject',
  'Microsoft.VSTS.Common.Priority',
  'System.Tags'
].join(',')

/** A create carries a JSON Patch document, which its POST cannot signal on
 *  its own; the host proxy accepts this one media type from a plugin. */
const JSON_PATCH_CONTENT_TYPE = 'application/json-patch+json'

/** The work items batch endpoint refuses more ids than this in one call. */
const BATCH_SIZE = 200

/** A Bug keeps its body in ReproSteps; every other type keeps it in
 *  Description. Neither is guaranteed: a Bug opened through the API usually
 *  has a Description and no ReproSteps, so each falls back to the other. */
const REPRO_STEPS_FIELD = 'Microsoft.VSTS.TCM.ReproSteps'
const DESCRIPTION_FIELD = 'System.Description'

const TITLE_MAX = 1024
const STATE_NAME_MAX = 256
const URL_MAX = 2048
const PRIORITY_MAX = 128
const LABEL_MAX = 128
const LABELS_MAX = 32
const DESCRIPTION_MAX = 128 * 1024
const TYPE_NAME_MAX = 256

/** WIQL has no parameterized query API; a literal embedded in a clause must
 *  double its single quotes or an apostrophe both breaks the query and lets
 *  the rest of the literal escape the string. */
export function escapeWiqlString(value) {
  return value.replace(/'/g, "''")
}

/** The only way a caller-supplied value may enter a clause. */
export function quoteWiql(value) {
  return `'${escapeWiqlString(value)}'`
}

/** A project-scoped WIQL URL supplies the `@project` macro but does not by
 *  itself restrict the result set, so the clause is what scopes the query. */
function wiqlFor(projectId, extraClauses) {
  const clauses = []
  if (projectId) {
    clauses.push('[System.TeamProject] = @project')
  }
  clauses.push(...extraClauses)
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  return `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`
}

export async function queryWorkItemIds(api, { organization, projectId, limit, extraClauses = [] }) {
  const response = await api.request({
    method: 'POST',
    path: projectId ? `/${projectId}/_apis/wit/wiql` : '/_apis/wit/wiql',
    organization,
    query: { $top: String(limit) },
    body: { query: wiqlFor(projectId, extraClauses) }
  })
  if (!response.ok) {
    return response
  }
  const workItems = response.data.workItems
  if (!Array.isArray(workItems)) {
    return failure('unavailable', 'Azure DevOps returned a WIQL result with no work item list.')
  }
  return {
    ok: true,
    data: workItems
      .map((entry) => String(entry?.id))
      .filter((id) => /^\d+$/.test(id))
  }
}

function chunk(values, size) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

/** Returns raw work items in the order `ids` gave them. The batch endpoint
 *  answers in ascending id order, which is not the board's order. */
export async function fetchWorkItems(api, { organization, ids }) {
  const byId = new Map()
  for (const batch of chunk(ids, BATCH_SIZE)) {
    const response = await api.request({
      method: 'GET',
      path: '/_apis/wit/workitems',
      organization,
      query: {
        ids: batch.join(','),
        fields: FIELDS,
        $expand: 'links',
        // One unreadable work item must not fail the whole page.
        errorPolicy: 'omit'
      }
    })
    if (!response.ok) {
      return response
    }
    for (const workItem of response.data.value ?? []) {
      if (workItem?.id !== undefined && workItem?.id !== null) {
        byId.set(String(workItem.id), workItem)
      }
    }
  }
  return { ok: true, data: ids.map((id) => byId.get(id)).filter(Boolean) }
}

/** Deliberately unfiltered: Azure returns `multilineFieldsFormat` — which
 *  says whether the body is HTML or markdown — only when the response is not
 *  narrowed by `fields`, and reading a markdown body as HTML mangles it. */
export async function fetchWorkItem(api, { organization, workItemId }) {
  const response = await api.request({
    method: 'GET',
    path: `/_apis/wit/workitems/${workItemId}`,
    organization,
    query: { $expand: 'links' }
  })
  if (!response.ok) {
    return response
  }
  return response.data?.id === undefined
    ? failure('not_found', `Azure DevOps returned no work item ${workItemId}.`)
    : { ok: true, data: response.data }
}

/** Azure's create route is POST to the type name prefixed with '$', and its
 *  body is a JSON Patch document rather than the work item. */
export async function createWorkItem(
  api,
  { organization, projectId, typeName, title, description }
) {
  const operations = [{ op: 'add', path: '/fields/System.Title', value: title }]
  if (description) {
    operations.push({ op: 'add', path: '/fields/System.Description', value: description })
  }
  const response = await api.request({
    method: 'POST',
    // The type name is percent-encoded: the proxy refuses any path the URL
    // parser would rewrite, and a raw space in 'User Story' is exactly that.
    path: `/${projectId}/_apis/wit/workitems/$${encodeURIComponent(typeName)}`,
    organization,
    contentType: JSON_PATCH_CONTENT_TYPE,
    body: operations
  })
  if (!response.ok) {
    return response
  }
  return response.data?.id === undefined
    ? failure('unavailable', 'Azure DevOps accepted the request but returned no work item.')
    : { ok: true, data: response.data }
}

/** Azure emits variable sub-second precision; normalize so the value always
 *  satisfies the contract's ISO-8601 shape. */
export function toIsoDate(value) {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function toIdentity(identity) {
  if (identity === null || typeof identity !== 'object') {
    return null
  }
  const id = identity.id ?? identity.uniqueName
  const displayName = identity.displayName ?? identity.uniqueName
  if (typeof id !== 'string' || typeof displayName !== 'string' || displayName.length === 0) {
    return null
  }
  return {
    id: id.slice(0, 512),
    displayName: displayName.slice(0, TITLE_MAX),
    // Azure's avatar URLs (imageUrl / _links.avatar.href) are auth-gated: an
    // unauthenticated GET 302s to sign-in. The renderer holds no credentials
    // (the PAT lives in the main process) and the host deliberately doesn't
    // proxy avatar bytes, so sending one only produces a broken image.
    avatarUrl: null
  }
}

export function projectNameOf(workItem) {
  const name = workItem?.fields?.['System.TeamProject']
  return typeof name === 'string' ? name : null
}

/** Azure's priority is numeric (1-4, lower is more urgent) and the scale
 *  isn't uniform across processes, so it is shown as-is rather than mapped
 *  to a High/Medium/Low label the plugin would be inventing. */
function toPriority(value) {
  if (value === null || value === undefined) {
    return null
  }
  const text = String(value).trim()
  return text.length > 0 ? text.slice(0, PRIORITY_MAX) : null
}

/** System.Tags is one semicolon-separated string ("a; b; c"), not a list. */
function toLabels(tags) {
  if (typeof tags !== 'string') {
    return undefined
  }
  const labels = tags
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, LABELS_MAX)
    .map((tag) => tag.slice(0, LABEL_MAX))
  return labels.length > 0 ? labels : undefined
}

/** The browser URL of a work item, as Azure reports it. */
function htmlUrlOf(workItem) {
  const href = workItem?._links?.html?.href
  return typeof href === 'string' ? href.slice(0, URL_MAX) : null
}

export function toTaskItem(workItem, { organization, scope, category }) {
  const fields = workItem.fields ?? {}
  const workItemId = String(workItem.id)
  const stateName = fields['System.State']

  return {
    id: encodeItemId(organization, scope?.projectId ?? null, workItemId),
    key: workItemId.slice(0, 128),
    title: String(fields['System.Title'] ?? '').slice(0, TITLE_MAX),
    state: {
      name: (typeof stateName === 'string' && stateName.length > 0 ? stateName : 'Unknown').slice(
        0,
        STATE_NAME_MAX
      ),
      category
    },
    priority: toPriority(fields['Microsoft.VSTS.Common.Priority']),
    labels: toLabels(fields['System.Tags']),
    assignee: toIdentity(fields['System.AssignedTo']),
    url: htmlUrlOf(workItem),
    updatedAt: toIsoDate(fields['System.ChangedDate']),
    scopeId: scope?.id ?? null
  }
}

export function workItemTypeOf(workItem) {
  const type = workItem?.fields?.['System.WorkItemType']
  return typeof type === 'string' ? type : ''
}

export function stateNameOf(workItem) {
  const state = workItem?.fields?.['System.State']
  return typeof state === 'string' ? state : ''
}

function bodyFieldsOf(workItem) {
  return workItemTypeOf(workItem) === 'Bug'
    ? [REPRO_STEPS_FIELD, DESCRIPTION_FIELD]
    : [DESCRIPTION_FIELD, REPRO_STEPS_FIELD]
}

/** Orca's contract has no 'html' description format, so a body Azure stores as
 *  HTML is converted here. A field Azure already stores as markdown is passed
 *  through, entity-decoded: Azure escapes `"` and `&` even in a markdown field,
 *  and only the decoded text is what its author typed. */
export function toDescription(workItem) {
  const fields = workItem.fields ?? {}
  const formats = workItem.multilineFieldsFormat ?? {}
  for (const name of bodyFieldsOf(workItem)) {
    const value = fields[name]
    if (typeof value !== 'string' || value.trim().length === 0) {
      continue
    }
    if (formats[name] === 'markdown') {
      return {
        description: decodeHtmlEntities(value).trim().slice(0, DESCRIPTION_MAX),
        descriptionFormat: 'markdown'
      }
    }
    if (isPlainText(value)) {
      return { description: value.trim().slice(0, DESCRIPTION_MAX), descriptionFormat: 'text' }
    }
    const markdown = htmlToMarkdown(value, { imageHref: htmlUrlOf(workItem) })
    // An empty conversion (a body that was only markup, e.g. '<div><br></div>')
    // falls through to the other field rather than reporting a body of nothing.
    if (markdown.length > 0) {
      return { description: markdown.slice(0, DESCRIPTION_MAX), descriptionFormat: 'markdown' }
    }
  }
  return { description: null, descriptionFormat: 'text' }
}

/** getItem's shape: the listed item plus the body and the type name. */
export function toTaskItemDetail(workItem, context) {
  const typeName = workItemTypeOf(workItem)
  return {
    ...toTaskItem(workItem, context),
    ...toDescription(workItem),
    type: typeName.length > 0 ? typeName.slice(0, TYPE_NAME_MAX) : null
  }
}
