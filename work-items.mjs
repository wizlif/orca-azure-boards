/**
 * Reads work items: a WIQL query for the ids in the order the board wants
 * them, then a field batch for their contents, then the shape Orca renders.
 */

import { failure } from './boards-api.mjs'
import { encodeItemId } from './board-identifiers.mjs'

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

/** The work items batch endpoint refuses more ids than this in one call. */
const BATCH_SIZE = 200

const TITLE_MAX = 1024
const STATE_NAME_MAX = 256
const URL_MAX = 2048
const PRIORITY_MAX = 128
const LABEL_MAX = 128
const LABELS_MAX = 32

/** WIQL has no parameterized query API; a literal embedded in a clause must
 *  double its single quotes or an apostrophe both breaks the query and lets
 *  the rest of the literal escape the string. */
export function escapeWiqlString(value) {
  return value.replace(/'/g, "''")
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

export async function fetchWorkItem(api, { organization, workItemId }) {
  const response = await api.request({
    method: 'GET',
    path: `/_apis/wit/workitems/${workItemId}`,
    organization,
    query: { fields: FIELDS, $expand: 'links' }
  })
  if (!response.ok) {
    return response
  }
  return response.data?.id === undefined
    ? failure('not_found', `Azure DevOps returned no work item ${workItemId}.`)
    : { ok: true, data: response.data }
}

/** Azure emits variable sub-second precision; normalize so the value always
 *  satisfies the contract's ISO-8601 shape. */
function toIsoDate(value) {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function toAssignee(identity) {
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

export function toTaskItem(workItem, { organization, scope, category }) {
  const fields = workItem.fields ?? {}
  const workItemId = String(workItem.id)
  const stateName = fields['System.State']
  const htmlUrl = workItem._links?.html?.href

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
    assignee: toAssignee(fields['System.AssignedTo']),
    url: typeof htmlUrl === 'string' ? htmlUrl.slice(0, URL_MAX) : null,
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
