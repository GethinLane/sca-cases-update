// app/api/transcripts/fetch/route.ts
// Fetches bot conversation transcripts for a single calendar day from the
// "Users ai" base → "Attempts" table. Capped at 300 by default.

import { NextRequest, NextResponse } from 'next/server'
import { getTranscriptsForDate } from '@/lib/airtable'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '300', 10) || 300, 300)

  if (!date) {
    return NextResponse.json({ error: 'Missing "date" query param (YYYY-MM-DD)' }, { status: 400 })
  }

  try {
    const transcripts = await getTranscriptsForDate(date, limit)
    return NextResponse.json({ date, count: transcripts.length, transcripts })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
