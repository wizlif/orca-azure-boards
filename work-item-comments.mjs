/**
 * Work item comments, in the shape Orca renders them.
 *
 * Azure stores a comment as HTML or as markdown and says which; neither may be
 * handed to the renderer as HTML, so an HTML comment is converted the same way
 * a description is. Orca's comment contract offers only `'text'` and `'html'`
 * for `bodyFormat`, so a converted body is declared `'text'` — the one value
 * that is true of it. Claiming `'html'` would be both false and unsafe.
 */

import { failure } from './boards-api.mjs'
import { decodeHtmlEntities, htmlToMarkdown, isPlainText } from './html-to-markdown.mjs'
import { toIdentity, toIsoDate } from './work-items.mjs'

/** The comments endpoint caps a page here. Older comments beyond one page are
 *  not fetched; the newest are what a panel shows. */
const COMMENT_PAGE_SIZE = 200

const BODY_MAX = 128 * 1024
const COMMENT_ID_MAX = 512

function toBody(comment) {
  const text = typeof comment.text === 'string' ? comment.text : ''
  if (comment.format === 'markdown') {
    return decodeHtmlEntities(text).trim().slice(0, BODY_MAX)
  }
  if (isPlainText(text)) {
    return text.trim().slice(0, BODY_MAX)
  }
  return htmlToMarkdown(text).slice(0, BODY_MAX)
}

/** A comment Orca cannot represent (no id, no author, no timestamp) is left
 *  out rather than filled in with invented values. Azure populates all three. */
function toComment(comment) {
  if (comment === null || typeof comment !== 'object') {
    return null
  }
  const id = comment.id === undefined || comment.id === null ? '' : String(comment.id)
  const author = toIdentity(comment.createdBy)
  const createdAt = toIsoDate(comment.createdDate)
  if (id.length === 0 || author === null || createdAt === null) {
    return null
  }
  return {
    id: id.slice(0, COMMENT_ID_MAX),
    author,
    body: toBody(comment),
    bodyFormat: 'text',
    createdAt
  }
}

/**
 * Reads one page of comments, oldest first.
 *
 * The path must carry the project: the organization-level spelling answers 404
 * "controller not found", which would read as a deleted work item. The
 * resource is preview-only — the host's own -preview retry covers that, so the
 * plugin still never names a version.
 */
export async function fetchComments(api, { organization, projectId, workItemId }) {
  const response = await api.request({
    method: 'GET',
    path: `/${projectId}/_apis/wit/workItems/${workItemId}/comments`,
    organization,
    query: { $top: String(COMMENT_PAGE_SIZE) }
  })
  if (!response.ok) {
    return response
  }
  const comments = response.data.comments
  if (!Array.isArray(comments)) {
    return failure('unavailable', 'Azure DevOps returned a comment list with no comments.')
  }
  // Azure answers newest first; a panel reads a discussion in the order it
  // happened.
  const mapped = comments
    .map(toComment)
    .filter((comment) => comment !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { ok: true, data: mapped }
}
