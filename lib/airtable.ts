// lib/airtable.ts
// Fetches feedback rows from the "Case Issues or Corrections" base
// and case data from the "Cases" base (one table per case).

const FEEDBACK_BASE_ID = process.env.AIRTABLE_FEEDBACK_BASE_ID!
const CASES_BASE_ID = process.env.AIRTABLE_CASES_BASE_ID!
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!

const AT_BASE = 'https://api.airtable.com/v0'

async function airtableFetch(url: string) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    next: { revalidate: 0 },
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
