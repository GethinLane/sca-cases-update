// lib/airtable.ts
// Fetches feedback rows from the "Case Issues or Corrections" base
// and case data from the "Cases" base (one table per case).

const FEEDBACK_BASE_ID = process.env.AIRTABLE_FEEDBACK_BASE_ID!
const CASES_BASE_ID = process.env.AIRTABLE_CASES_BASE_ID!
const TRANSCRIPTS_BASE_ID = process.env.AIRTABLE_TRANSCRIPTS_BASE_ID!
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!
// The default AIRTABLE_TOKEN is read-only because it's shared with other tools.
// Writes to the feedback base (e.g. Missing Case Details) need a separate
// write-scoped token. Falls back to AIRTABLE_TOKEN so dev setups still work
// if both happen to be on the same token.
const AIRTABLE_FEEDBACK_WRITE_TOKEN =
  process.env.AIRTABLE_FEEDBACK_WRITE_TOKEN || process.env.AIRTABLE_TOKEN!

const AT_BASE = 'https://api.airtable.com/v0'

async function airtablePatch(url: string, body: unknown, token: string) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Airtable error ${res.status}: ${text}`)
  }
  return res.json()
}

async function airtableFetch(url: string, token: string = AIRTABLE_TOKEN) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 0 },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Airtable error ${res.status}: ${text}`)
  }
  return res.json()
}

async function airtablePost(url: string, body: unknown, token: string = AIRTABLE_TOKEN) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Airtable error ${res.status}: ${text}`)
  }
  return res.json()
}

export interface FeedbackRow {
  id: string
  caseNumber: string
  issueSummary: string
  contactRegardingOutcome: boolean
  contactEmail: string
}

export async function getAllFeedback(): Promise<FeedbackRow[]> {
  // Table is named "User Feedback" in the feedback base
  const encoded = encodeURIComponent('User Feedback')
  const url = `${AT_BASE}/${FEEDBACK_BASE_ID}/${encoded}?filterByFormula=AND(NOT({Issue Summary}=""),OR({Suggestion Status}="Todo",{Suggestion Status}=""))`
  const data = await airtableFetch(url)

  return (data.records || []).map((r: any) => ({
    id: r.id,
    caseNumber: String(r.fields['Case'] ?? '').trim(),
    issueSummary: r.fields['Issue Summary'] ?? '',
    contactRegardingOutcome: r.fields['Contact regarding outcome'] === true || r.fields['Contact regarding outcome'] === 'Yes',
    contactEmail: r.fields['Contact Email'] ?? '',
  }))
}

export interface CaseData {
  caseNumber: string
  fields: Record<string, string>
}

export async function getCaseData(caseNumber: string): Promise<CaseData | null> {
  // Each case is its own table named e.g. "Case 1"
  const tableName = `Case ${caseNumber}`
  const encoded = encodeURIComponent(tableName)
  try {
    const url = `${AT_BASE}/${CASES_BASE_ID}/${encoded}`
    const data = await airtableFetch(url)

    // Flatten all records into a single field map (rows hold different aspects of the case)
    const merged: Record<string, string> = {}
    for (const record of data.records || []) {
      for (const [key, value] of Object.entries(record.fields as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) {
          // Append if field already seen (multiple rows can fill the same field)
          merged[key] = merged[key] ? `${merged[key]}\n\n${value}` : value
        }
      }
    }
    return { caseNumber, fields: merged }
  } catch {
    return null
  }
}

// ─── Structured (row-preserving) case data ─────────────────────────
// Used by the two-stage feedback analysis flow, which needs to write
// back to individual records. getCaseData() merges rows and destroys
// recordId — fine for prose analysis, but not for per-cell PATCH.

export interface CaseRowCell {
  recordId: string
  fieldName: string
  value: string
}

export interface CaseDataStructured {
  caseNumber: string
  tableName: string
  records: Array<{
    recordId: string
    rowIndex: number
    fields: Record<string, string>
  }>
}

const AIRTABLE_CASES_WRITE_TOKEN_ENV = 'AIRTABLE_CASES_WRITE_TOKEN'

function getCasesWriteToken(): string {
  const token = process.env.AIRTABLE_CASES_WRITE_TOKEN
  if (!token) {
    throw new Error(
      `${AIRTABLE_CASES_WRITE_TOKEN_ENV} is not set. ` +
      `Create a write-scoped Airtable personal access token for the Cases base ` +
      `(scopes: data.records:write on Cases base only) at https://airtable.com/create/tokens ` +
      `and add it as ${AIRTABLE_CASES_WRITE_TOKEN_ENV}.`,
    )
  }
  return token
}

export async function getCaseDataStructured(
  caseNumber: string,
): Promise<CaseDataStructured | null> {
  const tableName = `Case ${caseNumber}`
  const encoded = encodeURIComponent(tableName)

  try {
    const records: CaseDataStructured['records'] = []
    let offset: string | undefined
    let rowIndex = 0

    do {
      const params: string[] = ['pageSize=100']
      if (offset) params.push(`offset=${encodeURIComponent(offset)}`)
      const url = `${AT_BASE}/${CASES_BASE_ID}/${encoded}?${params.join('&')}`
      const data = await airtableFetch(url)

      for (const record of data.records || []) {
        const fields: Record<string, string> = {}
        for (const [key, value] of Object.entries(record.fields as Record<string, unknown>)) {
          if (typeof value === 'string') {
            fields[key] = value
          } else if (value != null) {
            fields[key] = String(value)
          }
        }
        records.push({
          recordId: record.id,
          rowIndex,
          fields,
        })
        rowIndex++
      }

      offset = data.offset
    } while (offset)

    if (records.length === 0) return null

    return { caseNumber, tableName, records }
  } catch {
    return null
  }
}

export async function updateCaseField(
  caseNumber: string,
  recordId: string,
  fieldName: string,
  newValue: string,
): Promise<void> {
  const token = getCasesWriteToken()
  const tableName = `Case ${caseNumber}`
  const encoded = encodeURIComponent(tableName)
  const url = `${AT_BASE}/${CASES_BASE_ID}/${encoded}/${recordId}`
  // typecast: false — surface schema mismatches loudly rather than coercing silently.
  await airtablePatch(url, { fields: { [fieldName]: newValue }, typecast: false }, token)
}

export async function getCaseFieldValue(
  caseNumber: string,
  recordId: string,
  fieldName: string,
): Promise<string | null> {
  const tableName = `Case ${caseNumber}`
  const encoded = encodeURIComponent(tableName)
  const url = `${AT_BASE}/${CASES_BASE_ID}/${encoded}/${recordId}`
  try {
    const data = await airtableFetch(url)
    const raw = (data.fields as Record<string, unknown> | undefined)?.[fieldName]
    if (raw == null) return null
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return null
  }
}

// ─── Cases base — Metadata API + batch create for case uploader ────
// The Metadata API needs the schema.bases:read scope, which the default
// AIRTABLE_TOKEN already has. Used by /upload-case to populate the
// target-table picker and to validate the heading→field mapping.

export interface CaseTableSummary {
  id: string
  name: string         // e.g. "Case 367"
  fieldNames: string[] // ordered list of field names declared on the table
}

export async function listCaseTables(): Promise<CaseTableSummary[]> {
  const url = `${AT_BASE}/meta/bases/${CASES_BASE_ID}/tables`
  const data = await airtableFetch(url)
  const tables = Array.isArray(data.tables) ? data.tables : []
  return tables
    .filter((t: any) => typeof t?.name === 'string' && /^Case\b/i.test(t.name))
    .map((t: any) => ({
      id: String(t.id),
      name: String(t.name),
      fieldNames: Array.isArray(t.fields)
        ? t.fields.map((f: any) => String(f?.name ?? '')).filter(Boolean)
        : [],
    }))
    // Sort by trailing number where possible so "Case 9" < "Case 10".
    .sort((a: CaseTableSummary, b: CaseTableSummary) => {
      const an = parseInt(a.name.replace(/^Case\s*/i, ''), 10)
      const bn = parseInt(b.name.replace(/^Case\s*/i, ''), 10)
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
      return a.name.localeCompare(b.name)
    })
}

// Write parsed case rows into a Case table. SCA case tables ship with 8
// pre-existing template rows (numbered by an "Order" column), so we need
// to UPDATE those existing rows in order rather than creating new ones
// below them. Logic:
//   1. List the table's existing rows (paginated).
//   2. Sort by "Order" if present, otherwise by createdTime.
//   3. Refuse outright if any row we'd overwrite has data in any non-
//      template column. No prompt, no override — caller must clear the
//      rows in Airtable before retrying. User explicitly asked for this
//      hard guard: too easy to clobber a populated case by picking the
//      wrong table from the dropdown.
//   4. PATCH the first N existing rows with the N parsed rows.
//   5. POST any extras (if parsed rows > existing rows).
// Airtable caps both PATCH and POST at 10 records per request, so we chunk
// and add a small inter-batch delay to stay under the 5 req/sec limit.
export interface CreateCaseRecordsResult {
  created: number
  updated: number
  recordIds: string[]
  errors: string[]
  // Populated only when the call was refused because target rows have
  // existing user-authored content. No override available — caller has
  // to clear those rows in Airtable and try again.
  refusedOverwrite?: {
    nonEmptyRowCount: number
    samplePreviews: string[]
  }
}

export async function createCaseRecords(
  tableName: string,
  rows: Array<Record<string, string>>,
): Promise<CreateCaseRecordsResult> {
  const token = getCasesWriteToken()
  const encoded = encodeURIComponent(tableName)
  const baseUrl = `${AT_BASE}/${CASES_BASE_ID}/${encoded}`

  // 1. List existing records. SCA case tables are small (≤8 rows in
  // practice) but page defensively in case someone has extended one.
  // Keep the full fields map for each row so we can check non-emptiness
  // before overwriting.
  type ExistingRow = {
    id: string
    createdTime: string
    order?: number
    fields: Record<string, unknown>
  }
  const existing: ExistingRow[] = []
  let offset: string | undefined
  do {
    const params: string[] = ['pageSize=100']
    if (offset) params.push(`offset=${encodeURIComponent(offset)}`)
    const data = await airtableFetch(`${baseUrl}?${params.join('&')}`)
    for (const r of (data.records || []) as any[]) {
      const fields = (r?.fields ?? {}) as Record<string, unknown>
      const orderRaw = fields.Order
      const order = typeof orderRaw === 'number' ? orderRaw : Number(orderRaw)
      existing.push({
        id: String(r.id),
        createdTime: String(r.createdTime ?? ''),
        order: Number.isFinite(order) ? order : undefined,
        fields,
      })
    }
    offset = data.offset
  } while (offset)

  // 2. Sort by Order if every existing row has one; otherwise by
  // createdTime so we still get a stable mapping.
  const allHaveOrder = existing.length > 0 && existing.every(r => r.order !== undefined)
  existing.sort((a, b) => {
    if (allHaveOrder) return (a.order ?? Infinity) - (b.order ?? Infinity)
    return a.createdTime.localeCompare(b.createdTime)
  })

  // 3. Hard refusal. Look at every existing row we'd overwrite (index <
  // rows.length) and check whether any has user-authored content beyond
  // the template-set Order column. If so, abort — no force flag, no
  // override. Safer to make the user explicitly clear the table in
  // Airtable than to risk silently losing a populated case.
  const overwritten = existing.slice(0, rows.length)
  const nonEmpty = overwritten.filter(r => hasUserContent(r.fields))
  if (nonEmpty.length > 0) {
    return {
      created: 0,
      updated: 0,
      recordIds: [],
      errors: [],
      refusedOverwrite: {
        nonEmptyRowCount: nonEmpty.length,
        samplePreviews: nonEmpty.slice(0, 5).map(r => describeRow(r.fields)),
      },
    }
  }

  // 4. Split incoming rows into updates (against existing) and creates.
  const updates: Array<{ id: string; fields: Record<string, string> }> = []
  const creates: Array<{ fields: Record<string, string> }> = []
  for (let i = 0; i < rows.length; i++) {
    if (i < existing.length) {
      updates.push({ id: existing[i].id, fields: rows[i] })
    } else {
      creates.push({ fields: rows[i] })
    }
  }

  const errors: string[] = []
  const recordIds: string[] = []
  let updated = 0
  let created = 0

  // Batched PATCH for updates.
  for (let i = 0; i < updates.length; i += 10) {
    const chunk = updates.slice(i, i + 10)
    try {
      const res = await airtablePatch(baseUrl, { records: chunk, typecast: true }, token)
      const out = Array.isArray(res.records) ? res.records : []
      updated += out.length
      for (const r of out) if (r?.id) recordIds.push(String(r.id))
    } catch (err: any) {
      errors.push(err?.message ?? String(err))
    }
    if (i + 10 < updates.length) await new Promise(r => setTimeout(r, 300))
  }

  // Batched POST for creates (anything beyond the existing row count).
  for (let i = 0; i < creates.length; i += 10) {
    const chunk = creates.slice(i, i + 10)
    try {
      const res = await airtablePost(baseUrl, { records: chunk, typecast: true }, token)
      const out = Array.isArray(res.records) ? res.records : []
      created += out.length
      for (const r of out) if (r?.id) recordIds.push(String(r.id))
    } catch (err: any) {
      errors.push(err?.message ?? String(err))
    }
    if (i + 10 < creates.length) await new Promise(r => setTimeout(r, 300))
  }

  return { created, updated, recordIds, errors }
}

// Does this row have any user-authored data beyond the template-set
// row-number / Airtable computed columns? Used to decide whether
// overwriting would destroy real content. Matching is case-insensitive
// so "Order" / "order" / "ORDER" all count as the template column.
function isTemplateOrComputedField(name: string): boolean {
  const lc = name.toLowerCase().trim()
  return (
    lc === 'order' ||
    lc === 'row' ||
    lc === 'row order' ||
    lc === '#' ||
    lc === 'autonumber' ||
    lc === 'created time' ||
    lc === 'last modified time' ||
    lc === 'created at' ||
    lc === 'modified at'
  )
}

function hasUserContent(fields: Record<string, unknown>): boolean {
  for (const k of Object.keys(fields)) {
    if (isTemplateOrComputedField(k)) continue
    const v = fields[k]
    if (v == null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    return true
  }
  return false
}

// Best-effort human-readable description of an existing row, used in the
// overwrite-refusal message so the user can recognise what they're about
// to clobber. Prefers Name/Patient Name fields; falls back to the first
// populated text field, skipping the template/computed columns.
function describeRow(fields: Record<string, unknown>): string {
  const PREFERRED = ['Patient Name', 'Name', 'Notes Entry Label']
  for (const k of PREFERRED) {
    const v = fields[k]
    if (typeof v === 'string' && v.trim()) return `${k}: ${v.slice(0, 60)}`
  }
  for (const k of Object.keys(fields)) {
    if (isTemplateOrComputedField(k)) continue
    const v = fields[k]
    if (typeof v === 'string' && v.trim()) return `${k}: ${v.slice(0, 60)}`
    if (typeof v === 'number') return `${k}: ${v}`
  }
  return '(non-empty row)'
}

export async function getFeedbackById(feedbackId: string): Promise<FeedbackRow | null> {
  const encoded = encodeURIComponent('User Feedback')
  const url = `${AT_BASE}/${FEEDBACK_BASE_ID}/${encoded}/${feedbackId}`
  try {
    const r = await airtableFetch(url)
    return {
      id: r.id,
      caseNumber: String(r.fields['Case'] ?? '').trim(),
      issueSummary: r.fields['Issue Summary'] ?? '',
      contactRegardingOutcome:
        r.fields['Contact regarding outcome'] === true ||
        r.fields['Contact regarding outcome'] === 'Yes',
      contactEmail: r.fields['Contact Email'] ?? '',
    }
  } catch {
    return null
  }
}

// Update the Suggestion Status of a User Feedback row.
// Used by the "Mark as done" button so reviewed rows drop out of the
// dashboard (which filters to Todo / empty status).
export async function updateFeedbackStatus(
  feedbackId: string,
  status: 'Todo' | 'Done' | 'In progress',
): Promise<void> {
  const encoded = encodeURIComponent('User Feedback')
  const url = `${AT_BASE}/${FEEDBACK_BASE_ID}/${encoded}/${feedbackId}`
  await airtablePatch(
    url,
    { fields: { 'Suggestion Status': status }, typecast: true },
    AIRTABLE_FEEDBACK_WRITE_TOKEN,
  )
}

// ─── Transcripts (Users ai base → Attempts table) ─────────────────

export interface TranscriptRow {
  id: string
  caseId: string
  transcript: string
  createdAt: string
}

/**
 * Fetch transcripts for a given calendar day (YYYY-MM-DD, interpreted in UTC
 * because Airtable's CREATED_TIME() and ISO strings are UTC). Pages through
 * results until `limit` records are collected or Airtable runs out.
 */
export async function getTranscriptsForDate(
  date: string,
  limit = 300,
): Promise<TranscriptRow[]> {
  if (!TRANSCRIPTS_BASE_ID) {
    throw new Error('AIRTABLE_TRANSCRIPTS_BASE_ID is not set')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date format "${date}" — expected YYYY-MM-DD`)
  }

  const tableName = 'Attempts'
  const encodedTable = encodeURIComponent(tableName)
  const formula = `IS_SAME({CreatedAt}, '${date}', 'day')`
  const encodedFormula = encodeURIComponent(formula)

  const rows: TranscriptRow[] = []
  let offset: string | undefined

  do {
    const pageSize = Math.min(100, limit - rows.length)
    if (pageSize <= 0) break

    const params = [
      `filterByFormula=${encodedFormula}`,
      `pageSize=${pageSize}`,
      `sort%5B0%5D%5Bfield%5D=CreatedAt`,
      `sort%5B0%5D%5Bdirection%5D=asc`,
    ]
    if (offset) params.push(`offset=${encodeURIComponent(offset)}`)

    const url = `${AT_BASE}/${TRANSCRIPTS_BASE_ID}/${encodedTable}?${params.join('&')}`
    const data = await airtableFetch(url)

    for (const r of data.records || []) {
      rows.push({
        id: r.id,
        caseId: String(r.fields['CaseID'] ?? '').trim(),
        transcript: String(r.fields['Transcript'] ?? ''),
        createdAt: String(r.fields['CreatedAt'] ?? ''),
      })
      if (rows.length >= limit) break
    }

    offset = data.offset
  } while (offset && rows.length < limit)

  return rows
}

// ─── Missing Case Details (Feedback base) ──────────────────────────

export interface MissingDetailRecord {
  caseId: string
  question: string
  frequency: number
  clinicallyRelevant: 'Yes' | 'No'
  relevanceReason: string
  suggestedAddition: string
  exampleQuotes: string
  botResponse: string
  deflectionType: 'patient_should_have_known' | 'meta_relevance'
  analysedDate: string
}

/**
 * Write findings to the "Missing Case Details" table in the feedback base.
 * Airtable caps each create call at 10 records, so we chunk and respect the
 * 5 req/sec rate limit with a small inter-batch delay.
 */
export async function saveMissingCaseDetails(
  records: MissingDetailRecord[],
): Promise<{ created: number; errors: string[] }> {
  if (!FEEDBACK_BASE_ID) {
    throw new Error('AIRTABLE_FEEDBACK_BASE_ID is not set')
  }
  const tableName = 'Missing Case Details'
  const encodedTable = encodeURIComponent(tableName)
  const url = `${AT_BASE}/${FEEDBACK_BASE_ID}/${encodedTable}`

  const errors: string[] = []
  let created = 0

  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10).map(r => ({
      fields: {
        CaseID: r.caseId,
        Question: r.question,
        Frequency: r.frequency,
        'Clinically Relevant': r.clinicallyRelevant,
        'Relevance Reason': r.relevanceReason,
        'Suggested Addition': r.suggestedAddition,
        'Example Quotes': r.exampleQuotes,
        'Bot Response': r.botResponse,
        'Deflection Type':
          r.deflectionType === 'patient_should_have_known'
            ? 'Patient should have known'
            : 'Meta / relevance challenge',
        'Analysed Date': r.analysedDate,
      },
    }))

    try {
      const res = await airtablePost(
        url,
        { records: chunk, typecast: true },
        AIRTABLE_FEEDBACK_WRITE_TOKEN,
      )
      created += (res.records || []).length
    } catch (err: any) {
      errors.push(err.message ?? String(err))
    }

    if (i + 10 < records.length) {
      await new Promise(r => setTimeout(r, 300))
    }
  }

  return { created, errors }
}
