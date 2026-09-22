/**
 * The composable filter dimensions this source offers: what each one is, what
 * options it carries for a set of scopes, and the WIQL they compose into.
 *
 * Combination is AND across facets and OR within a multi-select one. An absent
 * facet is no constraint at all. Only `defaultOptionIds` opens a facet already
 * narrowed, and clearing it stays available, so every assignee is still
 * reachable.
 *
 * Every option id is checked against the options actually resolved for the
 * scope before it reaches a clause, so a value the client invented is refused
 * rather than embedded; the literal is escaped on top of that.
 *
 * A facet may also narrow which scopes the query runs against at all, because
 * an iteration path only exists inside the project that owns it.
 */

import { failure } from './boards-api.mjs'
import { quoteWiql } from './work-items.mjs'

export const FACET_STATE = 'state'
export const FACET_SPRINT = 'sprint'
export const FACET_ASSIGNEE = 'assignee'
export const FACET_TYPE = 'type'

/** Not identities: `@Me` resolves against the token's own account, and an
 *  unassigned item has no identity to name. Neither can collide with the
 *  sign-in addresses the other options are keyed by. */
const ASSIGNEE_ME = '@me'
const ASSIGNEE_UNASSIGNED = '@unassigned'

/** A sprint option id carries the scope that owns the iteration, because the
 *  path alone cannot be resolved back to one: it starts with a project *name*,
 *  and names repeat across organizations while the plugin addresses projects
 *  by GUID. NUL is the separator — no organization name, project GUID or
 *  classification node name may contain one, so no path, however spelled, can
 *  be misread as a scope boundary. */
const SPRINT_SCOPE_SEPARATOR = '\u0000'

function encodeSprintOptionId(scopeId, path) {
  return `${scopeId}${SPRINT_SCOPE_SEPARATOR}${path}`
}

function decodeSprintOptionId(optionId) {
  const separator = optionId.indexOf(SPRINT_SCOPE_SEPARATOR)
  if (separator <= 0) {
    return null
  }
  const path = optionId.slice(separator + 1)
  return path.length > 0 ? { scopeId: optionId.slice(0, separator), path } : null
}

/** Every dimension is `dynamic`: state names, iterations, team members and
 *  work item types are all per-project, so none can be declared up front.
 *
 *  A board holds every team's work, so the useful first screen is the signed-in
 *  user's own. No other dimension has an answer that is right before the user
 *  has said anything, so no other declares a default. */
export const DECLARED_FACETS = [
  { id: FACET_STATE, label: 'State', kind: 'multi', dynamic: true },
  { id: FACET_SPRINT, label: 'Sprint', kind: 'single', dynamic: true },
  {
    id: FACET_ASSIGNEE,
    label: 'Assignee',
    kind: 'multi',
    dynamic: true,
    defaultOptionIds: [ASSIGNEE_ME]
  },
  { id: FACET_TYPE, label: 'Type', kind: 'multi', dynamic: true }
]

const FACET_BY_ID = new Map(DECLARED_FACETS.map((facet) => [facet.id, facet]))

const FIELD_BY_FACET = {
  [FACET_STATE]: '[System.State]',
  [FACET_SPRINT]: '[System.IterationPath]',
  [FACET_ASSIGNEE]: '[System.AssignedTo]',
  [FACET_TYPE]: '[System.WorkItemType]'
}

/** The contract's ceiling on one facet's options and on one selection. */
const OPTIONS_MAX = 200
const OPTION_ID_MAX = 512
const OPTION_LABEL_MAX = 256

/** Iterations nest by team and by release, so the tree is read several levels
 *  deep in the one call rather than walked node by node. */
const ITERATION_TREE_DEPTH = 6
const TEAM_MEMBER_PAGE_SIZE = 500

const CATEGORY_RANK = { todo: 0, 'in-progress': 1, done: 2, unknown: 3 }

function toOption(id, label) {
  return { id: String(id).slice(0, OPTION_ID_MAX), label: String(label).slice(0, OPTION_LABEL_MAX) }
}

/** Keeps the first spelling of a repeated id — the same state name or work
 *  item type appears once per project in the scope. */
function dedupe(options) {
  const byId = new Map()
  for (const option of options) {
    if (!byId.has(option.id)) {
      byId.set(option.id, option)
    }
  }
  return [...byId.values()].slice(0, OPTIONS_MAX)
}

/** A classification node's own `path` carries the '\Iteration' classification
 *  root ('\Proj\Iteration\Sprint 1'), which System.IterationPath does not. The
 *  names along the way spell the field's value instead. Excludes the project
 *  root node, which constrains nothing. */
function flattenIterations(root) {
  const flattened = []
  const walk = (node, trail) => {
    if (typeof node?.name !== 'string') {
      return
    }
    const names = [...trail, node.name]
    if (trail.length > 0) {
      flattened.push({
        path: names.join('\\'),
        startDate: Date.parse(node.attributes?.startDate ?? ''),
        finishDate: Date.parse(node.attributes?.finishDate ?? '')
      })
    }
    for (const child of node.children ?? []) {
      walk(child, names)
    }
  }
  walk(root, [])
  return flattened
}

/** Most recent first, by the date the iteration ends. An undated iteration
 *  sorts last rather than first, where it would push real sprints off the
 *  list. */
function iterationRank(iteration) {
  const end = Number.isNaN(iteration.finishDate) ? iteration.startDate : iteration.finishDate
  return Number.isNaN(end) ? Number.NEGATIVE_INFINITY : end
}

export function createWorkItemFacets({ api, workItemTypes }) {
  const iterationsByScopeId = new Map()
  const membersByScopeId = new Map()

  async function iterationOptions(scope) {
    const cached = iterationsByScopeId.get(scope.id)
    if (cached) {
      return { ok: true, data: cached }
    }
    const response = await api.request({
      method: 'GET',
      path: `/${scope.projectId}/_apis/wit/classificationnodes/Iterations`,
      organization: scope.organization,
      query: { $depth: String(ITERATION_TREE_DEPTH) }
    })
    if (!response.ok) {
      return response
    }
    const options = flattenIterations(response.data)
      .sort((a, b) => iterationRank(b) - iterationRank(a) || a.path.localeCompare(b.path))
      .map((iteration) => toOption(encodeSprintOptionId(scope.id, iteration.path), iteration.path))
    iterationsByScopeId.set(scope.id, options)
    return { ok: true, data: options }
  }

  /** The default team, because it is the only one a project always has. A
   *  member of some other team is not offered; they remain reachable by
   *  clearing the facet. */
  async function memberOptions(scope) {
    const cached = membersByScopeId.get(scope.id)
    if (cached) {
      return { ok: true, data: cached }
    }
    const project = await api.request({
      method: 'GET',
      path: `/_apis/projects/${scope.projectId}`,
      organization: scope.organization
    })
    if (!project.ok) {
      return project
    }
    const teamId = project.data?.defaultTeam?.id
    if (typeof teamId !== 'string' || teamId.length === 0) {
      return failure(
        'unavailable',
        `Azure DevOps returned no default team for project ${scope.projectName ?? scope.projectId}.`
      )
    }
    const members = await api.request({
      method: 'GET',
      path: `/_apis/projects/${scope.projectId}/teams/${teamId}/members`,
      organization: scope.organization,
      query: { $top: String(TEAM_MEMBER_PAGE_SIZE) }
    })
    if (!members.ok) {
      return members
    }
    const options = []
    for (const member of members.data.value ?? []) {
      const identity = member?.identity
      // WIQL matches System.AssignedTo on the sign-in address, not the GUID.
      const uniqueName = identity?.uniqueName
      if (typeof uniqueName !== 'string' || uniqueName.length === 0) {
        continue
      }
      const displayName =
        typeof identity.displayName === 'string' && identity.displayName.length > 0
          ? identity.displayName
          : uniqueName
      options.push(toOption(uniqueName, displayName))
    }
    options.sort((a, b) => a.label.localeCompare(b.label))
    membersByScopeId.set(scope.id, options)
    return { ok: true, data: options }
  }

  async function stateOptions(scope) {
    const states = await workItemTypes.states(scope.id, scope.organization, scope.projectId)
    if (!states.ok) {
      return states
    }
    const options = [...states.data]
      .sort(
        (a, b) =>
          (CATEGORY_RANK[a.category] ?? CATEGORY_RANK.unknown) -
            (CATEGORY_RANK[b.category] ?? CATEGORY_RANK.unknown) || a.name.localeCompare(b.name)
      )
      .map((state) => toOption(state.name, state.name))
    return { ok: true, data: options }
  }

  async function typeOptions(scope) {
    const types = await workItemTypes.creatableTypes(scope.id, scope.organization, scope.projectId)
    if (!types.ok) {
      return types
    }
    return { ok: true, data: types.data.map((type) => toOption(type.id, type.name)) }
  }

  const OPTIONS_BY_FACET = {
    [FACET_STATE]: stateOptions,
    [FACET_SPRINT]: iterationOptions,
    [FACET_ASSIGNEE]: memberOptions,
    [FACET_TYPE]: typeOptions
  }

  /** Every scope's options, or the first scope's failure: a facet that lists
   *  only the projects it could read would silently hide the rest. */
  async function listOptions(facetId, scopes) {
    if (!FACET_BY_ID.has(facetId)) {
      return failure(
        'validation',
        `Unknown facet "${facetId}". Known facets: ${[...FACET_BY_ID.keys()].join(', ')}.`
      )
    }
    const results = await Promise.all(scopes.map((scope) => OPTIONS_BY_FACET[facetId](scope)))
    const firstFailure = results.find((result) => !result.ok)
    if (firstFailure) {
      return firstFailure
    }
    const options = dedupe(results.flatMap((result) => result.data))
    return {
      ok: true,
      data:
        facetId === FACET_ASSIGNEE
          ? dedupe([toOption(ASSIGNEE_ME, 'Me'), toOption(ASSIGNEE_UNASSIGNED, 'Unassigned'), ...options])
          : options
    }
  }

  function assigneeTerm(optionId) {
    if (optionId === ASSIGNEE_ME) {
      return `${FIELD_BY_FACET[FACET_ASSIGNEE]} = @Me`
    }
    if (optionId === ASSIGNEE_UNASSIGNED) {
      return `${FIELD_BY_FACET[FACET_ASSIGNEE]} = ''`
    }
    return `${FIELD_BY_FACET[FACET_ASSIGNEE]} = ${quoteWiql(optionId)}`
  }

  function clauseFor(facet, optionIds) {
    const field = FIELD_BY_FACET[facet.id]
    if (facet.id === FACET_ASSIGNEE) {
      const terms = optionIds.map(assigneeTerm)
      return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`
    }
    // Exact, not UNDER: the user picked one iteration, not its subtree.
    if (facet.kind === 'single') {
      return `${field} = ${quoteWiql(optionIds[0])}`
    }
    return `${field} IN (${optionIds.map(quoteWiql).join(', ')})`
  }

  return {
    listOptions,

    /** The WIQL for one listing: a clause per selected facet, to be ANDed
     *  together, and the scopes it may run against.
     *
     *  `scopes` is null when nothing narrows the fan-out. A selected sprint
     *  narrows it to the project that owns the iteration; an empty array means
     *  that project is outside this listing, so nothing can match and nothing
     *  is queried.
     *
     *  The query schema cannot hold a `single` facet to one option — it never
     *  sees the declaration that names the kind — so that is enforced here. */
    async buildQuery(facetSelections, scopes) {
      if (facetSelections === undefined || facetSelections === null) {
        return { ok: true, data: { clauses: [], scopes: null } }
      }
      if (typeof facetSelections !== 'object' || Array.isArray(facetSelections)) {
        return failure('validation', 'facetSelections must be an object keyed by facet id.')
      }
      const clauses = []
      let narrowedScopes = null
      for (const [facetId, optionIds] of Object.entries(facetSelections)) {
        const facet = FACET_BY_ID.get(facetId)
        if (!facet) {
          return failure(
            'validation',
            `Unknown facet "${facetId}". Known facets: ${[...FACET_BY_ID.keys()].join(', ')}.`
          )
        }
        if (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== 'string')) {
          return failure('validation', `Facet "${facetId}" expects an array of option ids.`)
        }
        if (optionIds.length === 0) {
          continue
        }
        if (facet.kind === 'single' && optionIds.length > 1) {
          return failure(
            'validation',
            `Facet "${facetId}" accepts one option, not ${optionIds.length}.`
          )
        }
        if (facetId === FACET_SPRINT) {
          const sprint = decodeSprintOptionId(optionIds[0])
          // An id saved before sprint ids carried a scope names no project, so
          // it is no constraint at all until the renderer retires it against
          // the options now offered. Standing in for it with an empty board
          // would be a worse lie than showing one sprint too many.
          if (!sprint) {
            continue
          }
          const owner = scopes.find((scope) => scope.id === sprint.scopeId)
          // The owning project is outside this listing, so nothing in it can
          // match. Saying so by querying nothing, rather than by sending the
          // path somewhere it does not exist.
          if (!owner) {
            narrowedScopes = []
            continue
          }
          const iterations = await iterationOptions(owner)
          if (!iterations.ok) {
            return iterations
          }
          if (!iterations.data.some((option) => option.id === optionIds[0])) {
            return failure(
              'validation',
              `Facet "sprint" has no option "${sprint.path}" in ${owner.name ?? owner.id}.`
            )
          }
          narrowedScopes = [owner]
          // The path, not the option id: the clause names what Azure stores.
          clauses.push(clauseFor(facet, [sprint.path]))
          continue
        }
        const options = await listOptions(facetId, scopes)
        if (!options.ok) {
          return options
        }
        const known = new Set(options.data.map((option) => option.id))
        const unknown = optionIds.find((id) => !known.has(id))
        if (unknown !== undefined) {
          return failure(
            'validation',
            `Facet "${facetId}" has no option "${unknown}" in the selected scope.`
          )
        }
        clauses.push(clauseFor(facet, optionIds))
      }
      return { ok: true, data: { clauses, scopes: narrowedScopes } }
    }
  }
}
