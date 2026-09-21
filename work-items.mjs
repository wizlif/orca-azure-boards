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
  'System.TeamProject'
].join(',')

/** The work items batch endpoint refuses more ids than this in one call. */
const BATCH_SIZE = 200

const TITLE_MAX = 1024
const STATE_NAME_MAX = 256
const URL_MAX = 2048

/** A project-scoped WIQL URL supplies the `@project` macro but does not by
 *  itself restrict the result set, so the clause is what scopes the query. */
function wiqlFor(projectId) {
  const where = projectId ? ' WHERE [System.TeamProject] = @project' : ''
  return `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`
}

export async function queryWorkItemIds(api, { organization, projectId, limit }) {
  const response = await api.request({
    method: 'POST',
    path: projectId ? `/${projectId}/_apis/wit/wiql` : '/_apis/wit/wiql',
    organization,
    query: { $top: String(limit) },
    body: { query: wiqlFor(projectId) }
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
  const avatarUrl = identity.imageUrl ?? identity._links?.avatar?.href ?? null
  return {
    id: id.slice(0, 512),
    displayName: displayName.slice(0, TITLE_MAX),
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl.slice(0, URL_MAX) : null
  }
}

export function projectNameOf(workItem) {
  const name = workItem?.fields?.['System.TeamProject']
  return typeof name === 'string' ? name : null
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
