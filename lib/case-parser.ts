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
    const body = currentBody.join('\n').trim()
    const section = buildSection(currentHeading, body)
    if (section) sections.push(section)
  }

  for (const line of lines) {
    // Match "## Heading text" (two hashes only — single-hash is the doc title).
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) {
      flush()
      currentHeading = m[1]
      currentBody = []
    } else if (currentHeading !== null) {
      currentBody.push(line)
    }
  }
  flush()

  return sections
}

function buildSection(rawHeading: string, body: string): ParsedSection | null {
  const heading = rawHeading.trim()

  // Skip placeholder "(blank)" headings that mark empty rows in the source.
  if (/^\(blank\)$/i.test(heading)) return null
  // Skip empty bodies entirely.
  if (!body) return null

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

// Split a body into ordered items. Tries numbered-list format first
// ("1. foo\n2. bar"), then falls back to blank-line-separated paragraphs.
// Returns at least one item. We treat a single numbered item ("1. foo") as
// a numbered list too so the leading "1. " gets stripped consistently.
function splitIntoItems(body: string): string[] {
  const lines = body.split('\n')
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

  // Paragraphs separated by one-or-more blank lines.
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
// Compared case-insensitively against parsed heading text. Exact-form is
// preferred for the warning message so the user knows what's expected.
export function findMissingCanonicalHeadings(sections: ParsedSection[]): string[] {
  const present = new Set(sections.map(s => s.heading.toLowerCase()))
  return CANONICAL_SCA_HEADINGS.filter(h => !present.has(h.toLowerCase()))
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
