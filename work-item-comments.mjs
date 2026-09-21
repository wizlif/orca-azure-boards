/**
 * Work item comments, in the shape Orca renders them.
 *
 * Azure stores a comment as HTML or as markdown and says which; neither may be
 * handed to the renderer as HTML, so an HTML comment is converted the same way
 * a description is, and `bodyFormat` says `'markdown'`. Only a body that was
 * already plain when it arrived is declared `'text'`.
 */

import { failure } from './boards-api.mjs'
import { decodeHtmlEntities, htmlToMarkdown, isPlainText } from './html-to-markdown.mjs'
import { toIdentity, toIsoDate } from './work-items.mjs'

/** The comments endpoint caps a page here. Older comments beyond one page are
 *  not fetched; the newest are what a panel shows. */
const COMMENT_PAGE_SIZE = 200

const BODY_MAX = 128 * 1024
const COMMENT_ID_MAX = 512

/** A comment carries no browser URL, but its own API URL names the work item
 *  it belongs to on the origin Azure answered from, which is where an image
 *  placeholder can point. Assembling that origin here instead would duplicate
 *  what the host owns. */
function workItemHrefOf(comment) {
  const url = typeof comment.url === 'string' ? comment.url : ''
  const match = /^(https?:\/\/[^/]+\/\S*?)\/_apis\/wit\/workitems\/(\d+)\/comments\//i.exec(url)
  return match === null ? null : `${match[1]}/_workitems/edit/${match[2]}`
}

function toBody(comment) {
  const text = typeof comment.text === 'string' ? comment.text : ''
  if (comment.format === 'markdown') {
    return { body: decodeHtmlEntities(text).trim().slice(0, BODY_MAX), bodyFormat: 'markdown' }
  }
  if (isPlainText(text)) {
    return { body: text.trim().slice(0, BODY_MAX), bodyFormat: 'text' }
  }
  const markdown = htmlToMarkdown(text, { imageHref: workItemHrefOf(comment) })
  return { body: markdown.slice(0, BODY_MAX), bodyFormat: 'markdown' }
}

/** A comment Orca cannot represent (no id, no author, no timestamp) is left
 *  out rather than filled in with invented values. Azure populates all three. */
export function toComment(comment) {
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
    ...toBody(comment),
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

/** What a caller may post. Azure stores comments as HTML; nothing this
 *  plugin sends is ever raw user text. */
const BODY_INPUT_MAX = 128 * 1024

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The one inline construct the reply composer emits (`**Name wrote:**`).
 *  Escaping first and only wrapping the escaped runs means a literal `<` or
 *  `&` inside or outside a bold span can never be read back as markup. */
function renderInline(line) {
  let out = ''
  let rest = line
  const marker = /\*\*(.+?)\*\*/
  let match
  while ((match = marker.exec(rest)) !== null) {
    out += escapeHtml(rest.slice(0, match.index))
    out += `<strong>${escapeHtml(match[1])}</strong>`
    rest = rest.slice(match.index + match[0].length)
  }
  return out + escapeHtml(rest)
}

/** A line starting with Markdown's `>` is a quoted line; Orca's own reply
 *  composer (comment-reply-draft.ts) is the only thing that puts one there,
 *  quoting the comment being replied to before the new text. Azure has no
 *  comment threading, so nothing here claims one — it only renders what the
 *  composer already wrote as an actual `<blockquote>`, the same way Azure's
 *  own web UI "Reply" shows a quoted original, instead of leaving '>'
 *  characters visible as literal punctuation. */
function isQuoteLine(line) {
  return line.startsWith('>')
}

function unquote(line) {
  return line.replace(/^>[ \t]?/, '')
}

/** Groups lines into runs of quoted vs. plain text, in order, so an
 *  interleaved draft (plain text, a quote block, more plain text) becomes a
 *  matching sequence of paragraphs and blockquotes rather than one flattened
 *  block. */
function groupLines(lines) {
  const groups = []
  for (const line of lines) {
    const quoted = isQuoteLine(line)
    const last = groups[groups.length - 1]
    if (last && last.quoted === quoted) {
      last.lines.push(quoted ? unquote(line) : line)
    } else {
      groups.push({ quoted, lines: [quoted ? unquote(line) : line] })
    }
  }
  return groups
}

/** A paragraph per blank-line-separated block, a `<br>` per line inside one —
 *  the same paragraph/line-break shape `htmlToMarkdown` reads back out, so a
 *  posted comment round-trips through `listComments` unchanged. */
function renderParagraphs(lines) {
  return lines
    .join('\n')
    // A run of quoted lines is its own group (see `groupLines`), so the plain
    // text immediately after one always starts with the blank line the
    // composer put between the quote and the new text; trimming here drops
    // it instead of rendering it as a leading blank line in the comment.
    .trim()
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph) => `<div>${paragraph.split('\n').map(renderInline).join('<br>')}</div>`)
    .join('')
}

/** Recurses so a quote-of-a-quote (replying to a reply) nests correctly. */
function renderMarkdownishHtml(text) {
  return groupLines(text.split('\n'))
    .map((group) =>
      group.quoted
        ? `<blockquote>${renderMarkdownishHtml(group.lines.join('\n'))}</blockquote>`
        : renderParagraphs(group.lines)
    )
    .join('')
}

/**
 * Posts a comment and returns it mapped through the same `toComment` a
 * fetched comment goes through, so the two are shaped identically.
 *
 * Azure work item comments have no parent/child threading. Orca's reply UI
 * (comment-reply-draft.ts) composes a reply by prefilling the draft with a
 * Markdown blockquote naming the original author, ahead of the new text —
 * the same shape the Boards web UI's own "Reply" produces as a new top-level
 * comment. This function only renders whatever Markdown-ish text (paragraphs,
 * line breaks, `>` quotes, `**bold**`) the caller sends as HTML; it does not
 * itself know which comment, if any, is being replied to.
 */
export async function postComment(api, { organization, projectId, workItemId, body }) {
  // A textarea's `.value` is already '\n'-only in every browser, but a
  // caller isn't required to be one; normalizing here keeps a stray '\r'
  // from surviving into the stored HTML as an invisible character.
  const trimmed = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trim() : ''
  if (trimmed.length === 0) {
    return failure('validation', 'A comment needs a body.')
  }
  if (trimmed.length > BODY_INPUT_MAX) {
    return failure('validation', `A comment body must be at most ${BODY_INPUT_MAX} characters.`)
  }

  const response = await api.request({
    method: 'POST',
    path: `/${projectId}/_apis/wit/workItems/${workItemId}/comments`,
    organization,
    body: { text: renderMarkdownishHtml(trimmed) }
  })
  if (!response.ok) {
    return response
  }
  const comment = toComment(response.data)
  return comment === null
    ? failure('unavailable', 'Azure DevOps accepted the comment but returned a malformed response.')
    : { ok: true, data: comment }
}
