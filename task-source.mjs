/**
 * The read-only Azure Boards task source.
 *
 * Every method answers the task source envelope. The central rule: an empty
 * `items` array means the board is empty, and may never stand in for an
 * expired token, a revoked capability or an unreachable organization. So a
 * call that cannot see all of what it was asked for fails with a code instead
 * of returning the part it could see.
 */

import { createBoardsApi, failure } from './boards-api.mjs'
import { createStateCategoryIndex } from './state-categories.mjs'
import { decodeItemId, encodeScopeId, isProjectId } from './board-identifiers.mjs'
import {
  escapeWiqlString,
  fetchWorkItem,
  fetchWorkItems,
  projectNameOf,
  queryWorkItemIds,
  stateNameOf,
  toTaskItem,
  workItemTypeOf
} from './work-items.mjs'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const PROJECT_PAGE_SIZE = 500
const ACCOUNT_LABEL_MAX = 1024
const MESSAGE_MAX = 4096

const SUPPORTS_READ_ONLY = {
  comment: false,
  transition: false,
  assign: false,
  editTitle: false,
  editDescription: false
}

const NOT_CONFIGURED =
  'No Azure DevOps organization is configured. Set ORCA_AZURE_DEVOPS_API_BASE_URL to a comma-separated list of organization base URLs, plus ORCA_AZURE_DEVOPS_TOKEN.'

const FILTER_ASSIGNED_TO_ME = 'assigned-to-me'
const FILTER_ALL_OPEN = 'all-open'
const FILTER_DONE = 'done'

/** Rendered as chips. `all-open`/`done` need a project's real state
 *  vocabulary (state-categories.mjs), so applying either forces the query
 *  down to concrete projects instead of the organization-wide shortcut. */
const DECLARED_FILTERS = [
  { id: FILTER_ASSIGNED_TO_ME, label: 'Assigned to me' },
  { id: FILTER_ALL_OPEN, label: 'All open' },
  { id: FILTER_DONE, label: 'Done' }
]
const DECLARED_FILTER_IDS = new Set(DECLARED_FILTERS.map((filter) => filter.id))

function quoteWiql(value) {
  return `'${escapeWiqlString(value)}'`
}

function clampLimit(limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

/** Azure emits variable sub-second precision, so the raw strings do not
 *  compare correctly as text. An undated item sorts last rather than first. */
function changedAtOf(workItem) {
  const parsed = Date.parse(workItem?.fields?.['System.ChangedDate'] ?? '')
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

export function createAzureBoardsTaskSource(host) {
  const api = createBoardsApi(host)
  const stateCategories = createStateCategoryIndex(api)

  async function configuredOrganizations() {
    const organizations = await api.organizations()
    if (!organizations.ok) {
      return organizations
    }
    if (organizations.data.length === 0) {
      return failure('not_configured', NOT_CONFIGURED)
    }
    return organizations
  }

  /** One scope per project across every configured organization. A project is
   *  addressed by GUID because the proxy's path policy rejects a display name
   *  containing a space. */
  async function loadScopes() {
    const organizations = await configuredOrganizations()
    if (!organizations.ok) {
      return organizations
    }
    const responses = await Promise.all(
      organizations.data.map((organization) =>
        api.request({
          method: 'GET',
          path: '/_apis/projects',
          organization,
          query: { $top: String(PROJECT_PAGE_SIZE) }
        })
      )
    )
    const scopes = []
    for (const [index, response] of responses.entries()) {
      const organization = organizations.data[index]
      if (!response.ok) {
        return failure(response.code, `Azure DevOps ${organization}: ${response.message}`)
      }
      for (const project of response.data.value ?? []) {
        if (!isProjectId(project?.id) || typeof project?.name !== 'string') {
          continue
        }
        scopes.push({
          id: encodeScopeId(organization, project.id),
          name: `${organization} / ${project.name}`,
          organization,
          projectId: project.id,
          projectName: project.name
        })
      }
    }
    return { ok: true, data: scopes }
  }

  /** With no scope selected, one organization-wide query stands in for every
   *  project in it — far fewer requests than one query per project.
   *  `expandToProjects` forces one plan per project instead: a `done`/
   *  `all-open` filter clause needs each project's own state names, which
   *  only exist once a plan names a project. */
  function plansFor(scopes, scopeIds, expandToProjects) {
    if (scopeIds.length === 0) {
      if (expandToProjects) {
        return scopes.map((scope) => ({ organization: scope.organization, projectId: scope.projectId }))
      }
      const organizations = [...new Set(scopes.map((scope) => scope.organization))]
      return organizations.map((organization) => ({ organization, projectId: null }))
    }
    const plans = []
    for (const scopeId of scopeIds) {
      const scope = scopes.find((candidate) => candidate.id === scopeId)
      if (scope) {
        plans.push({ organization: scope.organization, projectId: scope.projectId })
      }
    }
    return plans
  }

  /** Builds the WIQL clauses for `search` and `filterId` on top of the plan's
   *  own project scoping. `all-open`/`done` prime the plan's project state
   *  vocabulary first, since the clause names real state values. */
  async function extraClausesFor(plan, { search, filterId }) {
    const clauses = []
    if (search) {
      clauses.push(`[System.Title] CONTAINS ${quoteWiql(search)}`)
    }
    if (filterId === FILTER_ASSIGNED_TO_ME) {
      clauses.push('[System.AssignedTo] = @Me')
    } else if (filterId === FILTER_ALL_OPEN || filterId === FILTER_DONE) {
      const scopeId = encodeScopeId(plan.organization, plan.projectId)
      await stateCategories.prime(scopeId, plan.organization, plan.projectId)
      const doneNames = stateCategories.doneStateNames(scopeId).map(quoteWiql).join(',')
      clauses.push(
        filterId === FILTER_DONE
          ? `[System.State] IN (${doneNames})`
          : `[System.State] NOT IN (${doneNames})`
      )
    }
    return clauses
  }

  async function collectWorkItems(plan, limit, query) {
    const extraClauses = await extraClausesFor(plan, query)
    const ids = await queryWorkItemIds(api, { ...plan, limit, extraClauses })
    if (!ids.ok) {
      return ids
    }
    if (ids.data.length === 0) {
      return { ok: true, data: [] }
    }
    const workItems = await fetchWorkItems(api, {
      organization: plan.organization,
      ids: ids.data
    })
    if (!workItems.ok) {
      return workItems
    }
    return {
      ok: true,
      data: workItems.data.map((workItem) => ({ workItem, organization: plan.organization }))
    }
  }

  /** Resolves the state metastates of only the projects actually on the page,
   *  so the fan-out is bounded by what the user is about to see. */
  async function primeStateCategories(entries, scopeByKey) {
    const scopes = new Map()
    for (const entry of entries) {
      const scope = scopeByKey.get(`${entry.organization}\u0000${projectNameOf(entry.workItem)}`)
      if (scope) {
        scopes.set(scope.id, scope)
      }
    }
    await Promise.all(
      [...scopes.values()].map((scope) =>
        stateCategories.prime(scope.id, scope.organization, scope.projectId)
      )
    )
  }

  return {
    async status() {
      const organizations = await configuredOrganizations()
      if (!organizations.ok) {
        return organizations
      }
      const probes = await Promise.all(
        organizations.data.map((organization) =>
          api.request({
            method: 'GET',
            path: '/_apis/projects',
            organization,
            query: { $top: '1' }
          })
        )
      )
      const unreachable = probes
        .map((probe, index) => ({ probe, organization: organizations.data[index] }))
        .filter((entry) => !entry.probe.ok)

      if (unreachable.length === probes.length) {
        const first = unreachable[0]
        return failure(first.probe.code, `Azure DevOps ${first.organization}: ${first.probe.message}`)
      }
      return {
        ok: true,
        data: {
          connected: true,
          accountLabel: organizations.data.join(', ').slice(0, ACCOUNT_LABEL_MAX),
          notice:
            unreachable.length === 0
              ? null
              : {
                  code: unreachable[0].probe.code,
                  message: `Not reachable: ${unreachable
                    .map((entry) => entry.organization)
                    .join(', ')}. ${unreachable[0].probe.message}`.slice(0, MESSAGE_MAX)
                },
          supports: SUPPORTS_READ_ONLY,
          filters: DECLARED_FILTERS
        }
      }
    },

    async listScopes() {
      const scopes = await loadScopes()
      if (!scopes.ok) {
        return scopes
      }
      return {
        ok: true,
        data: scopes.data.map((scope) => ({ id: scope.id, name: scope.name }))
      }
    },

    async listItems(params) {
      const limit = clampLimit(params?.limit)
      const scopeIds = Array.isArray(params?.scopeIds) ? params.scopeIds : []
      const filterId = params?.filterId ?? null
      if (filterId !== null && !DECLARED_FILTER_IDS.has(filterId)) {
        return failure(
          'validation',
          `Unknown filter "${filterId}". Known filters: ${[...DECLARED_FILTER_IDS].join(', ')}.`
        )
      }
      const search = typeof params?.search === 'string' && params.search.trim().length > 0
        ? params.search.trim()
        : null
      const scopes = await loadScopes()
      if (!scopes.ok) {
        return scopes
      }
      const unknown = scopeIds.filter((scopeId) =>
        scopes.data.every((scope) => scope.id !== scopeId)
      )
      if (unknown.length > 0) {
        return failure('not_found', `No Azure Boards project matches scope ${unknown[0]}.`)
      }

      const expandToProjects = filterId === FILTER_ALL_OPEN || filterId === FILTER_DONE
      const results = await Promise.all(
        plansFor(scopes.data, scopeIds, expandToProjects).map((plan) =>
          collectWorkItems(plan, limit, { search, filterId })
        )
      )
      const firstFailure = results.find((result) => !result.ok)
      if (firstFailure) {
        return firstFailure
      }

      const scopeByKey = new Map(
        scopes.data.map((scope) => [`${scope.organization}\u0000${scope.projectName}`, scope])
      )
      // Truncate before resolving state categories: the trailing items are
      // dropped, and their projects need no lookup.
      const page = results
        .flatMap((result) => result.data)
        .sort((a, b) => changedAtOf(b.workItem) - changedAtOf(a.workItem))
        .slice(0, limit)

      await primeStateCategories(page, scopeByKey)

      const items = page.map((entry) => {
        const scope = scopeByKey.get(
          `${entry.organization}\u0000${projectNameOf(entry.workItem)}`
        )
        return toTaskItem(entry.workItem, {
          organization: entry.organization,
          scope: scope ?? null,
          category: stateCategories.categoryOf(
            scope?.id ?? '',
            workItemTypeOf(entry.workItem),
            stateNameOf(entry.workItem)
          )
        })
      })

      return { ok: true, data: { items, nextCursor: null } }
    },

    async getItem(params) {
      const reference = decodeItemId(params?.id)
      if (!reference) {
        return failure(
          'validation',
          'Expected an Azure Boards item id of the form <organization>/<projectId>/<workItemId>.'
        )
      }
      const organizations = await configuredOrganizations()
      if (!organizations.ok) {
        return organizations
      }
      if (
        !organizations.data.some(
          (organization) => organization.toLowerCase() === reference.organization.toLowerCase()
        )
      ) {
        return failure(
          'not_configured',
          `Azure DevOps organization ${reference.organization} is not configured on this host.`
        )
      }

      const workItem = await fetchWorkItem(api, {
        organization: reference.organization,
        workItemId: reference.workItemId
      })
      if (!workItem.ok) {
        return workItem
      }

      const scopes = await loadScopes()
      const scope = scopes.ok
        ? scopes.data.find(
            (candidate) =>
              candidate.organization === reference.organization &&
              candidate.projectName === projectNameOf(workItem.data)
          ) ?? null
        : null
      if (scope) {
        await stateCategories.prime(scope.id, scope.organization, scope.projectId)
      }

      return {
        ok: true,
        data: toTaskItem(workItem.data, {
          organization: reference.organization,
          scope,
          category: stateCategories.categoryOf(
            scope?.id ?? '',
            workItemTypeOf(workItem.data),
            stateNameOf(workItem.data)
          )
        })
      }
    }
  }
}
