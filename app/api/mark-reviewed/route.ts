// app/api/mark-reviewed/route.ts
// Marks a case as manually reviewed by setting a reviewedAt timestamp.

import { NextRequest, NextResponse } from 'next/server'
import { getTriageResult, saveTriageResult } from '@/lib/triage-store'

export async function POST(req: NextRequest) {
  try {
    const { caseNumber } = await req.json()

    if (!caseNumber) {
      return NextResponse.json({ error: 'Missing caseNumber' }, { status: 400 })
    }

    const existing = await getTriageResult(String(caseNumber))
    if (!existing) {
      return NextResponse.json({ error: 'Case not found in triage store' }, { status: 404 })
    }

    existing.reviewedAt = new Date().toISOString()
    await saveTriageResult(existing)

    return NextResponse.json({ ok: true, reviewedAt: existing.reviewedAt })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
