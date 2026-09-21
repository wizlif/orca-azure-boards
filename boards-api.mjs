/**
 * The only way this plugin reaches Azure DevOps: the host's capability-gated
 * Boards proxy. The host owns the origin, the credential and the api-version,
 * and classifies every HTTP status into the task source error vocabulary.
 */

const MAX_MESSAGE_LENGTH = 4096

/** Host call rejections that are a permission or a contract problem rather
 *  than a transport one. Anything unlisted degrades to `unavailable`. */
const CODE_BY_HOST_CALL_CODE = {
  consent_required: 'forbidden',
  capability_denied: 'forbidden',
  panel_forbidden: 'forbidden',
  invalid_params: 'validation',
  invalid_request: 'validation',
  unknown_method: 'unavailable'
}

export function failure(code, message) {
  return { ok: false, code, message: String(message).slice(0, MAX_MESSAGE_LENGTH) }
}

function describeHostCallError(error) {
  const code = CODE_BY_HOST_CALL_CODE[error?.code] ?? 'unavailable'
  const detail = error instanceof Error ? error.message : String(error)
  return failure(code, `Orca could not reach the Azure Boards proxy: ${detail}`)
}

/** Azure DevOps answers an unauthenticated request with 203 and a sign-in
 *  page, which is a 2xx and therefore classified as success. Reading that
 *  body as data is exactly how an expired token becomes an empty board. */
function readSuccessBody(body) {
  if (body !== null && typeof body === 'object') {
    return { ok: true, data: body }
  }
  return failure(
    'unauthorized',
    'Azure DevOps returned a sign-in page instead of data. The personal access token is missing, expired, or lacks Work Items (Read) scope.'
  )
}

function describeErrorBody(body, status) {
  if (body !== null && typeof body === 'object' && typeof body.message === 'string') {
    return body.message
  }
  return `Azure DevOps request failed with HTTP ${status}.`
}

export function createBoardsApi(host) {
  return {
    async organizations() {
      let response
      try {
        response = await host.call('azureDevOps.boardsOrganizations', {})
      } catch (error) {
        return describeHostCallError(error)
      }
      const organizations = response?.organizations
      if (!Array.isArray(organizations)) {
        return failure('unavailable', 'The Azure Boards proxy returned no organization list.')
      }
      return { ok: true, data: organizations }
    },

    /** Resolves `{ ok: true, data }` only for a 2xx carrying a JSON object. */
    async request({ method, path, organization, query, body }) {
      let response
      try {
        response = await host.call('azureDevOps.boardsRequest', {
          method,
          path,
          ...(organization === undefined ? {} : { organization }),
          ...(query === undefined ? {} : { query }),
          ...(body === undefined ? {} : { body })
        })
      } catch (error) {
        return describeHostCallError(error)
      }
      if (response?.code) {
        return failure(response.code, describeErrorBody(response.body, response.status))
      }
      return readSuccessBody(response?.body ?? null)
    }
  }
}
