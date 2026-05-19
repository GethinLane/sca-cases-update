// app/api/mark-feedback-done/route.ts
// Marks a User Feedback row as Done so it drops off the dashboard.
// Uses AIRTABLE_FEEDBACK_WRITE_TOKEN (already provisioned for the
// Missing Case Details flow — same Feedback base, write scope).

import { NextRequest, NextResponse } from 'next/server'
import { updateFeedbackStatus } from '@/lib/airtable'

export const maxDuration = 60

interface RequestBody {
  feedbackId?: string
  status?: 'Todo' | 'Done' | 'In progress'
}

export async function POST(req: NextRequest) {
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const feedbackId = body.feedbackId
  if (!feedbackId) {
    return NextResponse.json({ error: 'Missing feedbackId' }, { status: 400 })
  }

  const status = body.status ?? 'Done'

  try {
    await updateFeedbackStatus(feedbackId, status)
    return NextResponse.json({ ok: true, feedbackId, status, markedAt: new Date().toISOString() })
  } catch (err: any) {
    console.error('mark-feedback-done error:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}
