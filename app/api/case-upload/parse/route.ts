// app/api/case-upload/parse/route.ts
// Accepts a .md or .docx upload, returns ParsedSection[]. For .docx, mammoth
// converts to markdown server-side first; both formats then go through the
// same case-parser.

import { NextRequest, NextResponse } from 'next/server'
import {
  parseMarkdownToSections,
  findMissingCanonicalHeadings,
  promoteCanonicalHeadings,
  type ParsedSection,
} from '@/lib/case-parser'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_BYTES = 5 * 1024 * 1024  // 5 MB — defensive cap, real cases are ~30 KB

// Mammoth's default style map matches paragraphs by style NAME ("Heading 2"
// with a capital H). Real .docx files in the wild often store the style
// name with different casing (we've seen "heading 2" lowercase), even when
// the style ID is the canonical "Heading2". When that happens mammoth's
// default rules don't fire and every heading paragraph comes through as
// plain prose, which is a disaster for our parser. Match by style-id too so
// we catch both spellings. NormalWeb (a common style on text pasted from a
// web page) is mapped to a plain paragraph so it doesn't trigger a noisy
// "Unrecognised paragraph style" warning.
const MAMMOTH_STYLE_MAP = [
  "p[style-id='Heading1'] => h1:fresh",
  "p[style-id='Heading2'] => h2:fresh",
  "p[style-id='Heading3'] => h3:fresh",
  "p[style-id='Heading4'] => h4:fresh",
  "p[style-id='Heading5'] => h5:fresh",
  "p[style-id='Heading6'] => h6:fresh",
  "p[style-id='Title'] => h1:fresh",
  // Lowercase style-name variants in case style ID isn't canonical either.
  "p[style-name='heading 1'] => h1:fresh",
  "p[style-name='heading 2'] => h2:fresh",
  "p[style-name='heading 3'] => h3:fresh",
  "p[style-name='heading 4'] => h4:fresh",
  "p[style-name='heading 5'] => h5:fresh",
  "p[style-name='heading 6'] => h6:fresh",
  // Don't warn on web-paste paragraphs — just treat them as normal prose.
  "p[style-id='NormalWeb'] => p:fresh",
  "p[style-name='Normal (Web)'] => p:fresh",
].join('\n')

export async function POST(req: NextRequest) {
  let form: FormData
  try {
    form = await req.formData()
  } catch (err: any) {
    return NextResponse.json(
      { error: `Could not read multipart upload: ${err?.message ?? err}` },
      { status: 400 },
    )
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" upload' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${file.size} bytes). Max ${MAX_BYTES}.` },
      { status: 413 },
    )
  }

  const name = (file.name || '').toLowerCase()
  let markdown: string
  let conversionWarnings: string[] = []
  let promotedHeadings: string[] = []

  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
    markdown = await file.text()
  } else if (name.endsWith('.docx')) {
    try {
      // Lazy-import mammoth so the markdown-only path doesn't pay the cost.
      // esModuleInterop is on, so the namespace import gives us the named
      // convertToMarkdown function directly.
      const mammoth: any = await import('mammoth')
      const convertToMarkdown = mammoth.convertToMarkdown ?? mammoth.default?.convertToMarkdown
      if (typeof convertToMarkdown !== 'function') {
        throw new Error('mammoth.convertToMarkdown not available — is the package installed?')
      }
      const buffer = Buffer.from(await file.arrayBuffer())
      const result = await convertToMarkdown(
        { buffer },
        { styleMap: MAMMOTH_STYLE_MAP },
      )
      markdown = typeof result?.value === 'string' ? result.value : ''
      if (Array.isArray(result?.messages)) {
        conversionWarnings = result.messages
          .map((m: any) => (typeof m?.message === 'string' ? m.message : ''))
          .filter(Boolean)
          .slice(0, 20)
      }
      // Recover canonical headings that were hand-formatted (bold + large
      // font) rather than tagged with Word's "Heading 2" style. mammoth
      // can't see those as headings, so they'd otherwise get absorbed into
      // the previous section.
      const promotion = promoteCanonicalHeadings(markdown)
      markdown = promotion.markdown
      promotedHeadings = promotion.promotedHeadings
    } catch (err: any) {
      return NextResponse.json(
        { error: `docx → markdown conversion failed: ${err?.message ?? err}` },
        { status: 500 },
      )
    }
  } else {
    return NextResponse.json(
      { error: `Unsupported file type "${file.name}". Use .md or .docx.` },
      { status: 415 },
    )
  }

  if (!markdown.trim()) {
    return NextResponse.json(
      { error: 'Uploaded file appears to be empty or could not be read as text.' },
      { status: 400 },
    )
  }

  const sections: ParsedSection[] = parseMarkdownToSections(markdown)

  if (sections.length === 0) {
    return NextResponse.json(
      {
        error:
          'No "## Heading" sections found in the document. The parser expects ' +
          'each field to be a level-2 heading (## Patient Name, etc.) — or a Word ' +
          '"Heading 2" style if uploading a .docx.',
        conversionWarnings,
      },
      { status: 422 },
    )
  }

  const missingCanonicalHeadings = findMissingCanonicalHeadings(sections)

  return NextResponse.json({
    sections,
    conversionWarnings,
    missingCanonicalHeadings,
    promotedHeadings,
    sourceMarkdownLength: markdown.length,
  })
}
