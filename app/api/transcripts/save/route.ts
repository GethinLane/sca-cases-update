// app/api/transcripts/save/route.ts
// Writes user-approved findings into the "Missing Case Details" table in the
// feedback base.

import { NextRequest, NextResponse } from 'next/server'
import { saveMissingCaseDetails, MissingDetailRecord } from '@/lib/airtable'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const { findings } = (await req.json()) as { findings?: MissingDetailRecord[] }

  if (!Array.isArray(findings) || findings.length === 0) {
    return NextResponse.json({ error: 'Provide a non-empty "findings" array' }, { status: 400 })
  }

  try {
    const result = await saveMissingCaseDetails(findings)
    if (result.errors.length > 0) {
      return NextResponse.json({
        created: result.created,
        errors: result.errors,
      }, { status: 207 })
    }
    return NextResponse.json({ created: result.created })
  } catch (err: any) {
    console.error('transcripts/save error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
