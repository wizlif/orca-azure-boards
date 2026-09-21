/**
 * One cache of each project's work item types, serving both readers of it:
 * the state category of every state, and the types a new item may be opened as.
 *
 * State names are per-process and customizable ("Ready for QA", "QA Testing"),
 * so a name table alone misreads any process it was not written against. Each
 * project's work item types declare the real metastate of every state, so that
 * is read per project and cached; the name table is the fallback for a project
 * whose types cannot be read.
 */

import { failure } from './boards-api.mjs'

/** Azure's own metastate vocabulary. `Removed` is terminal and out of the
 *  working set, so it reads as done rather than as unclassified. */
const CATEGORY_BY_METASTATE = {
  Proposed: 'todo',
  InProgress: 'in-progress',
  Resolved: 'in-progress',
  Completed: 'done',
  Removed: 'done'
}

const CATEGORY_BY_STATE_NAME = new Map(
  Object.entries({
    new: 'todo',
    'to do': 'todo',
    todo: 'todo',
    proposed: 'todo',
    design: 'todo',
    open: 'todo',
    approved: 'todo',
    backlog: 'todo',
    active: 'in-progress',
    committed: 'in-progress',
    'in progress': 'in-progress',
    doing: 'in-progress',
    resolved: 'in-progress',
    testing: 'in-progress',
    'qa testing': 'in-progress',
    'ready for qa': 'in-progress',
    'in review': 'in-progress',
    'code review': 'in-progress',
    done: 'done',
    closed: 'done',
    completed: 'done',
    removed: 'done',
    cancelled: 'done',
    rejected: 'done'
  })
)

function fromStateName(stateName) {
  return CATEGORY_BY_STATE_NAME.get(String(stateName).trim().toLowerCase()) ?? 'unknown'
}

/** Used only when a project's real state metastates could not be read: a
 *  best-effort guess at terminal state names, in Azure's own casing. */
const FALLBACK_DONE_STATE_NAMES = ['Closed', 'Completed', 'Removed', 'Done', 'Cancelled', 'Rejected']

function indexProject(workItemTypes) {
  const byTypeAndState = new Map()
  const byState = new Map()
  const creatable = []
  for (const type of workItemTypes) {
    // isDisabled marks a type the project's process has withdrawn, so offering
    // it would produce a create Azure then refuses.
    if (typeof type?.name === 'string' && type.isDisabled !== true) {
      // Azure's create route addresses a type by name, not by referenceName,
      // so the name is what a later createItem has to send back.
      creatable.push({ id: type.name, name: type.name })
    }
    for (const state of type?.states ?? []) {
      const category = CATEGORY_BY_METASTATE[state?.category]
      if (!category || typeof state.name !== 'string') {
        continue
      }
      byTypeAndState.set(`${type.name}\u0000${state.name}`, category)
      byState.set(state.name, category)
    }
  }
  return { byTypeAndState, byState, creatable }
}

export function createWorkItemTypeIndex(api) {
  const byScopeId = new Map()

  /** Failures are not cached: they degrade this call, not every later one. */
  async function load(scopeId, organization, projectId) {
    const cached = byScopeId.get(scopeId)
    if (cached) {
      return { ok: true, data: cached }
    }
    const response = await api.request({
      method: 'GET',
      path: `/${projectId}/_apis/wit/workitemtypes`,
      organization
    })
    if (!response.ok) {
      return response
    }
    if (!Array.isArray(response.data.value)) {
      return failure('unavailable', 'Azure DevOps returned a project with no work item type list.')
    }
    const index = indexProject(response.data.value)
    byScopeId.set(scopeId, index)
    return { ok: true, data: index }
  }

  return {
    /** Best-effort: a project whose types cannot be read falls back to the
     *  name table rather than failing the page it was loaded for. */
    async prime(scopeId, organization, projectId) {
      await load(scopeId, organization, projectId)
    },

    /** Unlike `prime`, propagates the failure: an empty type list would read
     *  as "this project offers nothing to create". */
    async creatableTypes(scopeId, organization, projectId) {
      const loaded = await load(scopeId, organization, projectId)
      return loaded.ok ? { ok: true, data: loaded.data.creatable } : loaded
    },

    categoryOf(scopeId, workItemType, stateName) {
      const index = byScopeId.get(scopeId)
      if (!index) {
        return fromStateName(stateName)
      }
      return (
        index.byTypeAndState.get(`${workItemType}\u0000${stateName}`) ??
        index.byState.get(stateName) ??
        fromStateName(stateName)
      )
    },

    /** Real state names, in this project's own vocabulary, whose metastate is
     *  `done` (Completed or Removed). Falls back to a generic guess when the
     *  project's types were not primed or carried no states, so a done/open
     *  filter still narrows the query instead of being dropped silently. */
    doneStateNames(scopeId) {
      const index = byScopeId.get(scopeId)
      if (!index) {
        return FALLBACK_DONE_STATE_NAMES
      }
      const names = [...index.byState.entries()]
        .filter(([, category]) => category === 'done')
        .map(([name]) => name)
      return names.length > 0 ? names : FALLBACK_DONE_STATE_NAMES
    }
  }
}
