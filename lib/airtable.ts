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
