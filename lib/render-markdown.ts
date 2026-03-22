// lib/render-markdown.ts
// Lightweight Airtable-flavour markdown → HTML renderer.
// No external dependencies. Handles the subset of markdown that
// Airtable rich text fields support.
//
// Supported:
//   ## H2, ### H3
//   #### kept as a styled sub-heading (Airtable renders it as literal text, used as visual convention)
//   **bold**, *italic*, ~~strikethrough~~
//   `inline code`, ``` code blocks ```
//   - bullet lists (with nesting via indentation)
//   1. numbered lists
//   > blockquotes
//   [text](url) links
//   Blank lines → paragraph breaks

export function renderMarkdown(md: string): string {
  if (!md) return ''

  // Normalise line endings
  const input = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // First pass: extract code blocks so they aren't processed
  const codeBlocks: string[] = []
  let processed = input.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length
    const code = match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
    codeBlocks.push(code)
    return `%%CODEBLOCK_${idx}%%`
  })

  const lines = processed.split('\n')
  const html: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code block placeholder
    const cbMatch = line.match(/^%%CODEBLOCK_(\d+)%%$/)
    if (cbMatch) {
      const code = codeBlocks[parseInt(cbMatch[1])]
      html.push(`<pre class="md-code-block"><code>${escapeHtml(code)}</code></pre>`)
      i++
      continue
    }

    // Blank line — skip (paragraph breaks handled by grouping)
    if (line.trim() === '') {
      i++
      continue
    }

    // Headings
    if (line.startsWith('#### ')) {
      html.push(`<div class="md-h4">${inline(line.slice(5))}</div>`)
      i++
      continue
    }
    if (line.startsWith('### ')) {
      html.push(`<h3 class="md-h3">${inline(line.slice(4))}</h3>`)
      i++
      continue
    }
    if (line.startsWith('## ')) {
      html.push(`<h2 class="md-h2">${inline(line.slice(3))}</h2>`)
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2))
        i++
      }
      html.push(`<blockquote class="md-blockquote">${quoteLines.map(l => inline(l)).join('<br>')}</blockquote>`)
      continue
    }

    // Unordered list (- item)
    if (/^(\s*)- /.test(line)) {
      const listHtml = parseUnorderedList(lines, i)
      html.push(listHtml.html)
      i = listHtml.nextIndex
      continue
    }

    // Ordered list (1. item)
    if (/^\d+\.\s/.test(line)) {
      const olLines: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        olLines.push(lines[i].replace(/^\d+\.\s/, ''))
        i++
      }
      html.push(`<ol class="md-ol">${olLines.map(l => `<li>${inline(l)}</li>`).join('')}</ol>`)
      continue
    }

    // Regular paragraph — collect consecutive non-special lines
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('## ') &&
      !lines[i].startsWith('### ') &&
      !lines[i].startsWith('#### ') &&
      !lines[i].startsWith('> ') &&
      !/^(\s*)- /.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !lines[i].match(/^%%CODEBLOCK_\d+%%$/)
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      html.push(`<p class="md-p">${paraLines.map(l => inline(l)).join('<br>')}</p>`)
    }
  }

  return html.join('')
}

// Parse nested unordered lists based on indentation
function parseUnorderedList(lines: string[], startIndex: number): { html: string; nextIndex: number } {
  const items: string[] = []
  let i = startIndex

  while (i < lines.length) {
    const match = lines[i].match(/^(\s*)- (.*)/)
    if (!match) break
    items.push(inline(match[2]))
    i++
  }

  const html = `<ul class="md-ul">${items.map(item => `<li>${item}</li>`).join('')}</ul>`
  return { html, nextIndex: i }
}

// Inline formatting
function inline(text: string): string {
  let result = escapeHtml(text)

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  // Inline code `code`
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')

  // Bold **text**
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  // Italic *text* (but not inside bold)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')

  // Strikethrough ~~text~~
  result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
