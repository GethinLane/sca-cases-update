import { NextResponse } from 'next/server'
import { getAllFeedback, getCaseData } from '@/lib/airtable'

// Process in batches to avoid Airtable rate limits (5 requests/second)
async function batchFetch(items: any[], batchSize = 4, delayMs = 300) {
  const results = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(async (row) => {
        const caseData = row.caseNumber ? await getCaseData(row.caseNumber) : null
        return { feedback: row, caseData }
      })
    )
    results.push(...batchResults)
    // Wait between batches (skip delay after last batch)
    if (i + batchSize < items.length) {
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  return results
}

export async function GET() {
  try {
    const feedback = await getAllFeedback()
    const joined = (await batchFetch(feedback)).sort((a, b) => {
      const numA = parseInt(a.feedback.caseNumber) || 0
      const numB = parseInt(b.feedback.caseNumber) || 0
      return numA - numB
    })
    return NextResponse.json({ items: joined })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
