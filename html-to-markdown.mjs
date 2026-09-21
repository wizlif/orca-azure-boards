/**
 * Converts the HTML Azure DevOps stores in a work item body to markdown.
 *
 * Orca's task contract has no 'html' format on purpose: the renderer treats a
 * description as markdown, and handing it third-party HTML is an injection
 * vector. So anything this module cannot express in markdown is dropped here,
 * where the decision is visible, rather than passed through.
 *
 * Constructs kept: headings, paragraphs, line breaks, ordered and unordered
 * lists, bold, italic, inline code, code blocks, links, blockquotes, tables
 * and horizontal rules. An image becomes a text placeholder. An unknown
 * element is unwrapped — its text survives, its markup does not. Elements
 * whose content is code, styling or non-image media (script, style, iframe,
 * form controls, ...) are dropped whole.
 */

/** Dropped with their contents: their text is not body text. */
const DISCARDED_ELEMENTS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
  'source',
  'track',
  'picture',
  'map',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'head',
  'link',
  'meta',
  'title',
  'base'
])

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

/** An open tag of one of these implicitly closes an open one of the same kind;
 *  Azure's editor emits well-formed markup, but pasted HTML often does not. */
const SELF_CLOSING_PEERS = {
  li: ['li'],
  p: ['p'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['tr', 'td', 'th'],
  dd: ['dd', 'dt'],
  dt: ['dd', 'dt']
}

// A quoted attribute may contain '>', so the tag body is matched quote-aware.
const TAG =
  /<(?:!--[\s\S]*?--|![^>]*|\/[^>]*|[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*)>/g

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]*))?/g

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // A non-breaking space is decoded to a plain one so runs of whitespace
  // collapse the same way whatever produced them.
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  para: '¶',
  sect: '§',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  larr: '←',
  rarr: '→',
  harr: '↔',
  check: '✓',
  cross: '✗'
}

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

/** Single pass on purpose: `&amp;lt;` decodes to `&lt;`, never to `<`. */
export function decodeHtmlEntities(text) {
  return text.replace(ENTITY, (match, name) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10)
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) {
        return code === 0x0a || code === 0x09 ? String.fromCodePoint(code) : ''
      }
      try {
        return String.fromCodePoint(code)
      } catch {
        return ''
      }
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match
  })
}

/** True when the value carries no markup at all, so it is already plain text. */
export function isPlainText(value) {
  return !/[<&]/.test(value)
}

function parseAttributes(source) {
  const attributes = {}
  ATTRIBUTE.lastIndex = 0
  let match = ATTRIBUTE.exec(source)
  while (match !== null) {
    const raw = match[2] ?? ''
    const value = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(value)
    match = ATTRIBUTE.exec(source)
  }
  return attributes
}

function openTagOf(tag) {
  const body = tag.slice(1, -1)
  const name = /^[a-zA-Z][^\s/>]*/.exec(body)?.[0]?.toLowerCase() ?? ''
  const rest = body.slice(name.length).replace(/\/$/, '')
  return { name, attributes: parseAttributes(rest), selfClosed: /\/\s*$/.test(body) }
}

/** Builds a tree. A stray close tag with no matching ancestor is ignored
 *  rather than unwinding the document. */
function parseHtml(html) {
  const root = { name: '#root', attributes: {}, children: [] }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  const pushText = (text) => {
    if (text.length > 0) {
      top().children.push({ text })
    }
  }

  TAG.lastIndex = 0
  let cursor = 0
  let match = TAG.exec(html)
  while (match !== null) {
    pushText(html.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const tag = match[0]
    if (!tag.startsWith('<!')) {
      if (tag.startsWith('</')) {
        const name = tag.slice(2, -1).trim().toLowerCase()
        const depth = stack.findIndex((node) => node.name === name)
        if (depth > 0) {
          stack.length = depth
        }
      } else {
        const { name, attributes, selfClosed } = openTagOf(tag)
        const peers = SELF_CLOSING_PEERS[name] ?? []
        if (peers.includes(top().name)) {
          stack.pop()
        }
        const node = { name, attributes, children: [] }
        top().children.push(node)
        if (!selfClosed && !VOID_ELEMENTS.has(name)) {
          stack.push(node)
        }
      }
    }
    match = TAG.exec(html)
  }
  pushText(html.slice(cursor))
  return root
}

const IMAGE_LABEL_MAX = 200

/** An Azure attachment URL carries the uploaded file name, which for a pasted
 *  screenshot is the only description of it that survives. */
function attachmentFileName(src) {
  const match = /[?&]fileName=([^&]*)/i.exec(src)
  if (match === null) {
    return ''
  }
  try {
    return collapseWhitespace(decodeURIComponent(match[1].replace(/\+/g, ' '))).trim()
  } catch {
    return ''
  }
}

/** Azure's editor writes alt="Image" on every pasted screenshot, so that value
 *  describes no more than a missing alt does. */
function imageLabel(attributes) {
  const alt = collapseWhitespace(attributes.alt ?? '').trim()
  const generic = alt.length === 0 || alt.toLowerCase() === 'image'
  const description = generic ? attachmentFileName(attributes.src ?? '') : alt
  return description.length === 0 ? 'Image' : `Image: ${description.slice(0, IMAGE_LABEL_MAX)}`
}

/** The label re-enters the pipeline as a text node, which decodes entities
 *  again, so `&` is re-encoded to survive that pass unchanged. */
function imagePlaceholder(attributes, href) {
  const children = [{ text: imageLabel(attributes).replace(/&/g, '&amp;') }]
  return href === null
    ? { name: 'span', attributes: {}, children }
    : { name: 'a', attributes: { href }, children }
}

/**
 * Turns every `<img>` into a placeholder the reader can see and follow.
 *
 * The image itself cannot be shown: an Azure attachment URL is auth-gated, the
 * renderer holds no credential, and Orca does not proxy one. Dropping the
 * element instead made an image-only comment arrive empty, which reads as a
 * named person saying nothing. The `src` is never the link target — it would
 * answer a sign-in page at best, and a `data:` src is a payload — so the
 * placeholder points at the work item, which the reader can actually open.
 * Inside an existing link it stays bare text, because nested markdown links
 * do not render.
 */
function replaceImages(node, itemHref, insideLink) {
  node.children = node.children.map((child) => {
    if (child.text !== undefined) {
      return child
    }
    if (child.name === 'img') {
      return imagePlaceholder(child.attributes, insideLink ? null : itemHref)
    }
    replaceImages(child, itemHref, insideLink || child.name === 'a')
    return child
  })
}

/** Escapes what would otherwise read as markup. `<` and `&` are escaped only
 *  when they would start a tag or an entity, so ordinary prose stays legible. */
function escapeMarkdown(text) {
  return text
    .replace(/[\\`*_[\]#>|~]/g, (char) => `\\${char}`)
    .replace(/<(?=[a-zA-Z!/])/g, '\\<')
    .replace(/&(?=[a-zA-Z#][a-zA-Z0-9]*;)/g, '\\&')
}

/** A block's first line must not accidentally start a list. */
function escapeLeadingListMarker(text) {
  return text.replace(/^(\s*)([-+]|\d{1,9}[.)])(\s)/, (_match, indent, marker, space) => {
    return `${indent}${marker.slice(0, -1)}\\${marker.slice(-1)}${space}`
  })
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ')
}

function fenceFor(text, minimum) {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length)
  }
  return '`'.repeat(Math.max(minimum, longest + 1))
}

function inlineCode(text) {
  const body = collapseWhitespace(text).trim()
  if (body.length === 0) {
    return ''
  }
  const fence = fenceFor(body, 1)
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${body}${pad}${fence}`
}

/** Markdown link destinations close at the first `)`, and only http(s) is
 *  worth linking: a `javascript:` or `data:` href becomes plain text. */
function linkDestination(href) {
  if (!/^https?:\/\//i.test(href)) {
    return null
  }
  const encoded = href.replace(/[()<>[\]\s"'`\\]/g, (char) =>
    Array.from(new TextEncoder().encode(char), (byte) => `%${byte.toString(16).toUpperCase()}`).join(
      ''
    )
  )
  return encoded.length > 0 ? encoded : null
}

function rawText(node) {
  if (node.text !== undefined) {
    return decodeHtmlEntities(node.text)
  }
  if (DISCARDED_ELEMENTS.has(node.name)) {
    return ''
  }
  if (node.name === 'br') {
    return '\n'
  }
  return node.children.map(rawText).join('')
}

function renderInline(node) {
  if (node.text !== undefined) {
    return escapeMarkdown(collapseWhitespace(decodeHtmlEntities(node.text)))
  }
  if (DISCARDED_ELEMENTS.has(node.name)) {
    return ''
  }
  if (node.name === 'br') {
    return '\n'
  }
  if (node.name === 'code' || node.name === 'kbd' || node.name === 'samp') {
    return inlineCode(rawText(node))
  }
  const inner = inlineOf(node)
  if (inner.trim().length === 0) {
    return inner
  }
  if (node.name === 'strong' || node.name === 'b') {
    return `**${inner.trim()}**`
  }
  if (node.name === 'em' || node.name === 'i') {
    return `*${inner.trim()}*`
  }
  if (node.name === 'a') {
    const destination = linkDestination(node.attributes.href ?? '')
    return destination === null ? inner : `[${inner.trim()}](${destination})`
  }
  return inner
}

function inlineOf(node) {
  return node.children.map((child) => renderInline(child)).join('')
}

function headingLevel(name) {
  return Math.min(Math.max(Number.parseInt(name.slice(1), 10) || 1, 1), 6)
}

function prefixLines(text, first, rest) {
  return text
    .split('\n')
    .map((line, index) => `${index === 0 ? first : rest}${line}`.trimEnd())
    .join('\n')
}

/** A nested list stays glued to its parent item: a blank line between them
 *  would end the item and start a second list. */
function renderListItem(node, marker) {
  const blocks = renderBlocks(node)
  if (blocks.length === 0) {
    return ''
  }
  const indent = ' '.repeat(marker.length)
  const lines = []
  blocks.forEach((block, index) => {
    if (index > 0 && block.kind !== 'list') {
      lines.push('')
    }
    const prefixed = prefixLines(block.text, index === 0 ? marker : indent, indent)
    lines.push(...prefixed.split('\n'))
  })
  return lines.join('\n')
}

function renderList(node, ordered) {
  const start = ordered ? Math.max(Number.parseInt(node.attributes.start ?? '1', 10) || 1, 1) : 1
  const items = []
  let index = 0
  for (const child of node.children) {
    if (child.text !== undefined || child.name !== 'li') {
      continue
    }
    const rendered = renderListItem(child, ordered ? `${start + index}. ` : '- ')
    index += 1
    if (rendered.length > 0) {
      items.push(rendered)
    }
  }
  return items.join('\n')
}

function renderCodeBlock(node) {
  const body = rawText(node).replace(/^\n+/, '').replace(/\s+$/, '')
  if (body.length === 0) {
    return ''
  }
  const fence = fenceFor(body, 3)
  return `${fence}\n${body}\n${fence}`
}

function cellsOf(node) {
  return node.children.filter(
    (child) => child.text === undefined && (child.name === 'td' || child.name === 'th')
  )
}

/** A row lives on one line, so a cell's blocks are flattened. Text nodes are
 *  already pipe-escaped; a pipe from inline code is not, and an unescaped one
 *  would end the cell early. */
function renderCell(node) {
  return collapseWhitespace(renderChildren(node))
    .trim()
    .replace(/\\?\|/g, (match) => (match === '|' ? '\\|' : match))
}

/** A stray `<tr>` outside any table: its cells are kept as one line so the
 *  text survives even though there is no grid to put it in. */
function renderRow(node) {
  return cellsOf(node)
    .map((cell) => renderCell(cell))
    .filter((cell) => cell.length > 0)
    .join(' | ')
}

/** Collects a table's cell rows in document order. A `<table>` reached from
 *  here belongs to a cell, not to this grid, so it is not descended into. */
function tableRowsOf(node, rows) {
  for (const child of node.children) {
    if (child.text !== undefined || child.name === 'table' || DISCARDED_ELEMENTS.has(child.name)) {
      continue
    }
    if (child.name === 'tr') {
      rows.push(cellsOf(child))
      continue
    }
    tableRowsOf(child, rows)
  }
}

function containsTable(node) {
  if (node.text !== undefined) {
    return false
  }
  return node.name === 'table' || node.children.some(containsTable)
}

function gfmRow(cells, width) {
  const padded = Array.from({ length: width }, (_unused, column) => cells[column] ?? '')
  return `| ${padded.join(' | ')} |`
}

/** A grid the supported subset cannot hold: the cells keep their text, one
 *  line per row, stripped of markdown so an inner grid's own pipes and rules
 *  cannot break this one. */
function renderFlattenedRows(rows) {
  return rows
    .map((cells) =>
      cells
        .map((cell) => escapeMarkdown(collapseWhitespace(rawText(cell))).trim())
        .filter((cell) => cell.length > 0)
        .join(' | ')
    )
    .filter((row) => row.length > 0)
    .join('\n')
}

/**
 * Renders a table as GFM, header rule included.
 *
 * Without the rule a GFM reader runs the rows together as prose, so the grid
 * is worth the work. Ragged rows are padded to the widest one. A table with no
 * `<th>` row gets an empty header, which GFM requires and which keeps every
 * row that carries data in the body. A nested table has no GFM spelling at
 * all, so such a table is flattened instead.
 */
function renderTable(node) {
  const rows = []
  tableRowsOf(node, rows)
  if (rows.some((cells) => cells.some(containsTable))) {
    return renderFlattenedRows(rows)
  }
  const rendered = rows
    .map((cells) => ({
      cells: cells.map((cell) => renderCell(cell)),
      header: cells.length > 0 && cells.every((cell) => cell.name === 'th')
    }))
    .filter((row) => row.cells.some((cell) => cell.length > 0))
  if (rendered.length === 0) {
    return ''
  }
  const width = rendered.reduce((widest, row) => Math.max(widest, row.cells.length), 0)
  const head = rendered[0].header ? rendered[0].cells : []
  const body = rendered[0].header ? rendered.slice(1) : rendered
  const lines = [gfmRow(head, width), gfmRow(Array.from({ length: width }, () => '---'), width)]
  for (const row of body) {
    lines.push(gfmRow(row.cells, width))
  }
  return lines.join('\n')
}

function renderBlock(node) {
  const name = node.name
  if (name === 'hr') {
    return '---'
  }
  if (/^h[1-6]$/.test(name)) {
    const text = collapseWhitespace(inlineOf(node)).trim()
    return text.length === 0 ? '' : `${'#'.repeat(headingLevel(name))} ${text}`
  }
  if (name === 'ul' || name === 'ol') {
    return renderList(node, name === 'ol')
  }
  if (name === 'li') {
    return renderListItem(node, '- ')
  }
  if (name === 'pre') {
    return renderCodeBlock(node)
  }
  if (name === 'blockquote') {
    const body = renderChildren(node)
    return body.length === 0 ? '' : prefixLines(body, '> ', '> ')
  }
  if (name === 'table') {
    return renderTable(node)
  }
  if (name === 'tr') {
    return renderRow(node)
  }
  return renderChildren(node)
}

function blockKind(name) {
  if (name === 'ul' || name === 'ol' || name === 'li') {
    return 'list'
  }
  return name === 'tr' ? 'row' : 'block'
}

/** Inline runs between block children become blocks of their own, so text
 *  loose inside a `<div>` is not glued to the block that follows it. */
function renderBlocks(node) {
  const blocks = []
  let inline = ''
  const flush = () => {
    const text = inline.replace(/[ \t]+\n/g, '\n').trim()
    if (text.length > 0) {
      blocks.push({ kind: 'block', text: escapeLeadingListMarker(text) })
    }
    inline = ''
  }
  for (const child of node.children) {
    if (child.text === undefined && DISCARDED_ELEMENTS.has(child.name)) {
      continue
    }
    if (child.text === undefined && BLOCK_ELEMENTS.has(child.name)) {
      flush()
      const text = renderBlock(child)
      if (text.length > 0) {
        blocks.push({ kind: blockKind(child.name), text })
      }
      continue
    }
    inline += renderInline(child)
  }
  flush()
  return blocks
}

/** Table rows keep single newlines between them; everything else is a
 *  paragraph apart. */
function joinBlocks(blocks) {
  return blocks
    .map((block, index) => {
      if (index === 0) {
        return block.text
      }
      const tight = blocks[index - 1].kind === 'row' && block.kind === 'row'
      return `${tight ? '\n' : '\n\n'}${block.text}`
    })
    .join('')
}

function renderChildren(node) {
  return joinBlocks(renderBlocks(node))
}

/** `imageHref` is where an image placeholder points — the work item's own
 *  browser URL. Without one the placeholder is plain text. */
export function htmlToMarkdown(html, { imageHref = null } = {}) {
  if (typeof html !== 'string' || html.length === 0) {
    return ''
  }
  const root = parseHtml(html)
  replaceImages(root, typeof imageHref === 'string' && imageHref.length > 0 ? imageHref : null, false)
  return renderChildren(root)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
