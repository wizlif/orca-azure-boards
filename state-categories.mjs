/**
 * Maps an Azure DevOps workflow state onto the four categories Orca renders.
 *
 * State names are per-process and customizable ("Ready for QA", "QA Testing"),
 * so a name table alone misreads any process it was not written against. Each
 * project's work item types declare the real metastate of every state, so that
 * is read per project and cached; the name table is the fallback for a project
 * whose types cannot be read.
 */

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

function indexProjectStates(workItemTypes) {
  const byTypeAndState = new Map()
  const byState = new Map()
  for (const type of workItemTypes) {
    for (const state of type?.states ?? []) {
      const category = CATEGORY_BY_METASTATE[state?.category]
      if (!category || typeof state.name !== 'string') {
        continue
      }
      byTypeAndState.set(`${type.name}\u0000${state.name}`, category)
      byState.set(state.name, category)
    }
  }
  return { byTypeAndState, byState }
}

export function createStateCategoryIndex(api) {
  const byScopeId = new Map()

  return {
    /** Loads one project's state metastates. Failures are not cached: they
     *  degrade this call to the name table, not every later one. */
    async prime(scopeId, organization, projectId) {
      if (byScopeId.has(scopeId)) {
        return
      }
      const response = await api.request({
        method: 'GET',
        path: `/${projectId}/_apis/wit/workitemtypes`,
        organization
      })
      if (!response.ok || !Array.isArray(response.data.value)) {
        return
      }
      byScopeId.set(scopeId, indexProjectStates(response.data.value))
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
    }
  }
}
