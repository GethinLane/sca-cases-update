// lib/case-parser.ts
// Parses an SCA case from markdown (either authored .md or mammoth-converted
// .docx) into a list of sections. Each section is one heading + its body,
// optionally split into ordered items that will become rows in Airtable.
//
// Source-order is preserved strictly. The marking-criteria fields
// (Positive/Negative Indicators, Key Issues) carry positional weighting —
// item N MUST go to row N. Do NOT sort or de-duplicate.

export interface ParsedSection {
  heading: string         // Raw heading text from the source.
  parentField?: string    // For "ICE: <X>" only — the field this writes to ("ICE").
  subsection?: string     // For "ICE: <X>" only — "Ideas" / "Concerns" / "Expectations".
  items: string[]         // Ordered list of values. Singleton fields → length 1.
}

// Fields that always span multiple Airtable rows (one item per row). Used to
// decide whether paragraph-separated bodies should split into items or stay
// as a single value with formatting. Prose-style fields (Role Player
// Introduction, Information Divulged Freely, Application, etc.) deliberately
// stay as single values even if the source has multiple paragraphs.
const KNOWN_LIST_FIELDS = new Set<string>([
  'Past Medical History',
  'Medications',
  'Notes Entry Label',
  'Notes Entry Content',
  'Test Results Label',
  'Test Results Content',
  // History / role-player narrative blocks — each paragraph in the source
  // is a separate "fact" that maps to its own Airtable row. Confirmed by
  // user 2026-05: "we need separate paragraphs to go into separate rows
  // for the history section, like the social history, free information,
  // information if divulged…".
  'Information Divulged Freely',
  'Information Divulged Only If Asked',
  'PMH / Medications / Allergies (Role Player Version)',
  'Social History',
  'Family History',
  'Data Gathering: Positive Indicators',
  'Data Gathering: Negative Indicators',
  'Clinical Management: Positive Indicators',
  'Clinical Management: Negative Indicators',
  'Relating to Others: Positive Indicators',
  'Relating to Others: Negative Indicators',
  'Key Issue Titles',
  'Key Issue Relevance',
  'Key Issue Curriculum Mapping',
  'Reference Labels',
  'Reference URLs',
])

// ICE is the only field where a "ParentField: Subsection" heading dictates
// which row the body lands in. Order: Ideas → row 1, Concerns → row 2,
// Expectations → row 3.
export const ICE_SUBSECTION_ROW: Record<string, number> = {
  ideas: 1,
  concerns: 2,
  expectations: 3,
}

export function parseMarkdownToSections(markdown: string): ParsedSection[] {
  const normalised = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalised.split('\n')
  const sections: ParsedSection[] = []
  let currentHeading: string | null = null
  let currentBody: string[] = []

  const flush = () => {
    if (currentHeading === null) return
    const body = normaliseBodyText(currentBody.join('\n').trim())
    const section = buildSection(currentHeading, body)
    if (section) sections.push(section)
  }

  for (const line of lines) {
    // Case 1: any markdown heading "#", "##", "###" — we don't care which
    // level mammoth chose for SCA fields. Strip wrapping bold/italic that
    // mammoth puts inside the heading and canonicalise via wording match.
    const m = line.match(/^#+\s+(.+?)\s*$/)
    if (m) {
      flush()
      currentHeading = cleanHeadingText(m[1])
      currentBody = []
      continue
    }
    // Case 2: standalone line whose wording matches a canonical SCA heading
    // (e.g. mammoth couldn't recognise the paragraph as a Heading 2 because
    // the style name was lowercased, so it emits the heading as just bold
    // body text). Matching purely on wording means we recover the section
    // regardless of how it was formatted in the docx.
    const canonicalHit = canonicaliseHeading(cleanHeadingText(line))
    if (canonicalHit) {
      flush()
      currentHeading = canonicalHit
      currentBody = []
      continue
    }
    if (currentHeading !== null) currentBody.push(line)
  }
  flush()

  return sections
}

// Strip wrapping bold/italic markers and unescape mammoth's backslash
// escaping. Then, if the cleaned text matches a canonical SCA heading via
// tolerant normalisation, return the canonical spelling — that way the
// downstream code (KNOWN_LIST_FIELDS lookup, missing-section warning, UI
// auto-mapping) all sees the same canonical name regardless of how the
// docx author wrote it.
function cleanHeadingText(s: string): string {
  const stripped = unescapeMammothBackslashes(
    s.trim()
      .replace(/^(?:\*\*|__|\*|_)+/, '')
      .replace(/(?:\*\*|__|\*|_)+$/, '')
      .trim(),
  )
  return canonicaliseHeading(stripped) ?? stripped
}

// Mammoth's markdown writer escapes special-character punctuation with a
// leading backslash to prevent accidental markdown formatting in the output
// (e.g. "e.g." → "e\.g\.", "(text)" → "\(text\)", "self-management" →
// "self\-management"). These escapes are visual noise when the text is
// going into an Airtable cell, so we undo them. The replacement is
// conservative: only un-escape characters mammoth is known to escape.
function unescapeMammothBackslashes(s: string): string {
  return s.replace(/\\([\\`*_{}\[\]()#+\-.!|<>])/g, '$1')
}

// Mammoth emits bold runs as "__text__" and (sometimes) italic as "_text_".
// Airtable's rich-text rendering recognises the asterisk variants
// ("**bold**" / "*italic*") but not the underscore variants — so the
// Assessment / Management long-text cells were landing in Airtable with
// literal "__Definition.__" instead of rendering as bold. Convert to the
// asterisk syntax so the markdown actually renders.
//
// Only convert pairs that look unambiguously like emphasis:
// - "__…__" with no underscores in the run → bold
// - "_word_" surrounded by non-word characters → italic
// Single underscores inside words (snake_case, file_names) are left alone.
function convertUnderscoreEmphasisToAsterisk(s: string): string {
  let out = s.replace(/__([^_\n]+?)__/g, '**$1**')
  out = out.replace(/(^|[^\w_])_([^_\n]+?)_(?=[^\w_]|$)/g, '$1*$2*')
  return out
}

// One-stop normaliser for body text coming out of mammoth: undo defensive
// escaping, then convert underscore-emphasis to asterisk-emphasis. Applied
// to every section body and to each split item so the Airtable cells end
// up with clean, renderable markdown.
function normaliseBodyText(s: string): string {
  return convertUnderscoreEmphasisToAsterisk(unescapeMammothBackslashes(s))
}

function buildSection(rawHeading: string, body: string): ParsedSection | null {
  const heading = rawHeading.trim()

  // Skip placeholder "(blank)" headings that mark empty rows in the source.
  if (/^\(blank\)$/i.test(heading)) return null
  // Empty body — keep the section ONLY if its heading is canonical, so the
  // section still surfaces in the UI (with an empty row) and the user knows
  // it's there. Drops empty non-canonical sections (almost always conversion
  // noise — random bolded paragraphs, blank Word styles, etc.).
  if (!body) {
    const isCanonical = CANONICAL_SCA_HEADINGS.some(
      h => normaliseForMatch(h) === normaliseForMatch(heading),
    )
    if (!isCanonical) return null
  }

  // ICE: <Subsection> — pin to a specific row of the ICE field.
  const iceMatch = heading.match(/^ICE\s*:\s*(.+)$/i)
  if (iceMatch) {
    return {
      heading,
      parentField: 'ICE',
      subsection: iceMatch[1].trim(),
      items: [body],
    }
  }

  const isListField = KNOWN_LIST_FIELDS.has(heading)
  const items = isListField ? splitIntoItems(body) : [body]
  return { heading, items }
}

// Split a body into ordered items. Order of attempts:
//   1. numbered list ("1. foo\n2. bar")
//   2. bullet list ("- foo\n- bar" or "* foo\n* bar") — Word "bulleted list"
//      style ends up here after mammoth conversion. Key Issue Curriculum
//      Mapping in real cases is authored this way.
//   3. blank-line-separated paragraphs.
// Returns at least one item.
function splitIntoItems(body: string): string[] {
  const lines = body.split('\n')

  // 1. Numbered list. We treat even a single numbered item as a numbered
  // list so the leading "1. " gets stripped consistently.
  const numberedStarts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\d+\.\s+/.test(lines[i])) numberedStarts.push(i)
  }
  if (numberedStarts.length >= 1) {
    const items: string[] = []
    for (let j = 0; j < numberedStarts.length; j++) {
      const start = numberedStarts[j]
      const end = j + 1 < numberedStarts.length ? numberedStarts[j + 1] : lines.length
      const raw = lines.slice(start, end).join('\n')
      const stripped = raw.replace(/^\s*\d+\.\s+/, '').trim()
      if (stripped) items.push(stripped)
    }
    if (items.length > 0) return items
  }

  // 2. Bullet list — "- item" or "* item". Bare "*" needs care because it
  // could be the start of a bold marker "**text**" — require a single * /
  // - followed by whitespace, not "**".
  const bulletStarts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[-*](?!\*)\s+/.test(lines[i])) bulletStarts.push(i)
  }
  if (bulletStarts.length >= 1) {
    const items: string[] = []
    for (let j = 0; j < bulletStarts.length; j++) {
      const start = bulletStarts[j]
      const end = j + 1 < bulletStarts.length ? bulletStarts[j + 1] : lines.length
      const raw = lines.slice(start, end).join('\n')
      const stripped = raw.replace(/^\s*[-*]\s+/, '').trim()
      if (stripped) items.push(stripped)
    }
    if (items.length > 0) return items
  }

  // 3. Paragraphs separated by one-or-more blank lines.
  const paragraphs = body
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
  if (paragraphs.length > 0) return paragraphs

  return [body.trim()]
}

// Take parsed sections and project them onto Airtable rows. Row N is
// { fieldName → value } for fields that have a value at index N-1 in their
// items array. Singleton fields populate row 1 only. ICE subsection headings
// populate the row given by ICE_SUBSECTION_ROW.
export interface RowProjection {
  rowIndex: number      // 1-based row number for human-readable display.
  fields: Record<string, string>
}

// Hard cap on rows we'll project per case. The user's stated norm is 8, but
// some cases ship 12 indicators in Relating-to-Others (seen in real uploads),
// and Airtable doesn't enforce row counts. 16 keeps us defensive against
// runaway parses while accommodating the cases we've actually seen.
export const MAX_CASE_ROWS = 16
// Soft warning threshold — anything beyond this triggers a UI warning so the
// user can confirm their target Case table has enough rows.
export const SOFT_ROW_WARN = 8

// Canonical headings we expect on a well-formed SCA case. Used by the
// uploader to surface "this document is missing X" warnings.
export const CANONICAL_SCA_HEADINGS: readonly string[] = [
  'Patient Name',
  'Age',
  'Past Medical History',
  'Medications',
  'Notes Entry Label',
  'Notes Entry Content',
  'Test Results Label',
  'Test Results Content',
  'Role Player Introduction',
  'Opening Sentence',
  'Information Divulged Freely',
  'Information Divulged Only If Asked',
  'PMH / Medications / Allergies (Role Player Version)',
  'Social History',
  'Family History',
  'ICE: Ideas',
  'ICE: Concerns',
  'ICE: Expectations',
  'Data Gathering: Positive Indicators',
  'Data Gathering: Negative Indicators',
  'Clinical Management: Positive Indicators',
  'Clinical Management: Negative Indicators',
  'Relating to Others: Positive Indicators',
  'Relating to Others: Negative Indicators',
  'Key Issue Titles',
  'Key Issue Relevance',
  'Key Issue Curriculum Mapping',
  'Explanation',
  'Assessment',
  'Management',
  'Application',
  'Reference Labels',
  'Reference URLs',
  'Creation Date',
]

// Returns the canonical headings the parser DIDN'T find in the source.
// Compared via the same forgiving normalisation we use for matching so that
// "Explanation:" / "**Explanation**" / "Explanation " all count as present.
export function findMissingCanonicalHeadings(sections: ParsedSection[]): string[] {
  const present = new Set(sections.map(s => normaliseForMatch(s.heading)))
  return CANONICAL_SCA_HEADINGS.filter(h => !present.has(normaliseForMatch(h)))
}

// Normalise a string for tolerant heading matching: lowercase, drop every
// non-alphanumeric character, collapse spaces. This lets "Explanation",
// "Explanation:", "**Explanation**", "  Explanation  ", and "Explanation."
// all hash to the same key — which is what we want for both the canonical
// heading lookup and the auto-mapping step against the Airtable field
// names.
export function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// Look up an arbitrary heading string against the canonical SCA heading
// list using tolerant normalisation. Returns the canonical spelling
// ("Explanation") for any reasonable variant the source might have used.
function canonicaliseHeading(s: string): string | null {
  const key = normaliseForMatch(s)
  if (!key) return null
  for (const canonical of CANONICAL_SCA_HEADINGS) {
    if (normaliseForMatch(canonical) === key) return canonical
  }
  return null
}

// Promote text lines that visually look like SCA headings (because the
// author bold/large-formatted them by hand instead of using Word's
// "Heading 2" style) into actual markdown ## headings. mammoth only
// recognises Word's built-in heading styles, so anything hand-formatted
// comes out as plain text and gets vacuumed up into the previous section.
//
// We only promote lines whose text EXACTLY matches a canonical SCA heading
// (case-insensitive, after stripping any bold/italic markdown emphasis
// mammoth wraps around them). That avoids false positives — random body
// prose won't accidentally match a 30+ character heading like
// "Data Gathering: Positive Indicators".
//
// Returns the new markdown and the list of headings that were promoted so
// the UI can surface "we recovered N headings that weren't properly styled".
export function promoteCanonicalHeadings(markdown: string): {
  markdown: string
  promotedHeadings: string[]
} {
  const canonicalByLower = new Map(
    CANONICAL_SCA_HEADINGS.map(h => [h.toLowerCase(), h]),
  )
  const lines = markdown.split('\n')
  const promoted: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#+\s/.test(line.trim())) continue        // already a markdown heading
    const stripped = cleanHeadingText(line)
    if (!stripped) continue
    const hit = canonicalByLower.get(stripped.toLowerCase())
    if (hit) {
      lines[i] = `## ${hit}`
      promoted.push(hit)
    }
  }
  return { markdown: lines.join('\n'), promotedHeadings: promoted }
}

export function projectSectionsToRows(
  sections: ParsedSection[],
  headingToField: Record<string, string>,  // heading → real Airtable field name
): RowProjection[] {
  // rows[0] = row 1, rows[7] = row 8.
  const rows: Record<string, string>[] = Array.from({ length: MAX_CASE_ROWS }, () => ({}))

  for (const section of sections) {
    // ICE — pinned to specific row by subsection.
    if (section.parentField === 'ICE' && section.subsection) {
      const targetField = headingToField['ICE'] ?? 'ICE'
      const row = ICE_SUBSECTION_ROW[section.subsection.toLowerCase()]
      if (row && row >= 1 && row <= MAX_CASE_ROWS) {
        rows[row - 1][targetField] = section.items[0] ?? ''
      }
      continue
    }

    const targetField = headingToField[section.heading]
    if (!targetField) continue   // Unmapped — caller will surface as a warning.

    section.items.forEach((value, i) => {
      if (i >= MAX_CASE_ROWS) return
      if (!value.trim()) return
      rows[i][targetField] = value
    })
  }

  return rows
    .map((fields, i) => ({ rowIndex: i + 1, fields }))
    .filter(r => Object.keys(r.fields).length > 0)
}

// Best-effort initial mapping from parsed heading → real Airtable field name.
// Exact match first, then case-insensitive, then a small synonym map for the
// few common shorthand renames. Anything else returns undefined and the UI
// asks the user to map it.
export function autoMapHeadings(
  headings: string[],
  realFields: string[],
): Record<string, string | undefined> {
  const exact = new Set(realFields)
  const lc = new Map<string, string>(realFields.map(f => [f.toLowerCase(), f]))
  const result: Record<string, string | undefined> = {}

  for (const heading of headings) {
    // ICE: X subsection headings all map to the ICE field.
    if (/^ICE\s*:/i.test(heading)) {
      result[heading] = exact.has('ICE') ? 'ICE' : lc.get('ice')
      continue
    }
    if (exact.has(heading)) {
      result[heading] = heading
      continue
    }
    const lcHit = lc.get(heading.toLowerCase())
    if (lcHit) {
      result[heading] = lcHit
      continue
    }
    const synonym = HEADING_SYNONYMS[heading.toLowerCase()]
    if (synonym && exact.has(synonym)) {
      result[heading] = synonym
      continue
    }
    result[heading] = undefined
  }

  return result
}

// Conservative synonym list. Only add a synonym here if you've confirmed the
// real Airtable field name differs from what authors tend to write.
const HEADING_SYNONYMS: Record<string, string> = {
  'pmh': 'Past Medical History',
  'past medical hx': 'Past Medical History',
  'meds': 'Medications',
  'social hx': 'Social History',
  'family hx': 'Family History',
}
