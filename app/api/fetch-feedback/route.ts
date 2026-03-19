// app/api/fetch-feedback/route.ts
import { NextResponse } from 'next/server'
import { getAllFeedback, getCaseData } from '@/lib/airtable'

export async function GET() {
  try {
    const feedback = await getAllFeedback()

    // Join each feedback row with its case data
    const joined = await Promise.all(
      feedback.map(async (row) => {
        const caseData = row.caseNumber ? await getCaseData(row.caseNumber) : null
        return { feedback: row, caseData }
      })
    )

    return NextResponse.json({ items: joined })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
