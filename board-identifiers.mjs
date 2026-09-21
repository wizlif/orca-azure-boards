/**
 * Scope and item ids are opaque to Orca, so they carry everything a later
 * call needs to address the same work item again: the organization (the host
 * serves only the ones the user configured) and the project GUID.
 *
 * Organization names and project GUIDs are single URL path segments, so '/'
 * separates them unambiguously.
 */

const PROJECT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const WORK_ITEM_ID_PATTERN = /^\d+$/

export function isProjectId(value) {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
}

export function isWorkItemId(value) {
  return typeof value === 'string' && WORK_ITEM_ID_PATTERN.test(value)
}

export function encodeScopeId(organization, projectId) {
  return `${organization}/${projectId}`
}

export function decodeScopeId(scopeId) {
  if (typeof scopeId !== 'string') {
    return null
  }
  const separator = scopeId.lastIndexOf('/')
  if (separator <= 0) {
    return null
  }
  const organization = scopeId.slice(0, separator)
  const projectId = scopeId.slice(separator + 1)
  return isProjectId(projectId) ? { organization, projectId } : null
}

/** The project segment is omitted when the project is unknown — a work item
 *  is addressable without it, and a fabricated project would be worse. */
export function encodeItemId(organization, projectId, workItemId) {
  return projectId
    ? `${organization}/${projectId}/${workItemId}`
    : `${organization}/${workItemId}`
}

export function decodeItemId(itemId) {
  if (typeof itemId !== 'string') {
    return null
  }
  const parts = itemId.split('/')
  const workItemId = parts.pop()
  const organization = parts.shift()
  if (!organization || !isWorkItemId(workItemId) || parts.length > 1) {
    return null
  }
  const projectId = parts[0]
  return {
    organization,
    projectId: isProjectId(projectId) ? projectId : null,
    workItemId
  }
}
