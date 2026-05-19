// app/api/apply-edit/route.ts
// Stage 3 of the two-stage feedback flow.
// PATCHes a single Airtable cell with the user-approved rewrite. Refuses the
// write with HTTP 409 if the live Airtable value no longer matches the
// currentText that Stage 2 saw — protects against silent overwrites.

import { NextRequest, NextResponse } from 'next/server'
import {
  getCaseFieldValue,
  updateCaseField,
} from '@/lib/airtable'
import {
  getRewrites,
  markRewriteApplied,
  getTriage,
} from '@/lib/feedback-analysis-store'

export const maxDuration = 300

interface RequestBody {
  feedbackId?: string
  recordId?: string
  fieldName?: string
  newValue?: string
}

export async function POST(req: NextRequest) {
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { feedbackId, recordId, fieldName, newValue } = body
  if (!feedbackId || !recordId || !fieldName || newValue == null) {
    return NextResponse.json(
      { error: 'Missing one of: feedbackId, recordId, fieldName, newValue' },
      { status: 400 },
    )
  }

  try {
    const rewrites = await getRewrites(feedbackId)
    if (!rewrites) {
      return NextResponse.json(
        { error: 'No rewrites cached for this feedback. Run /api/draft-rewrites first.' },
        { status: 404 },
      )
    }

    const entry = rewrites.rewrites.find(
      r => r.recordId === recordId && r.fieldName === fieldName,
    )
    if (!entry) {
      return NextResponse.json(
        { error: `No cached rewrite for (recordId=${recordId}, fieldName=${fieldName}).` },
        { status: 404 },
      )
    }

    const triage = await getTriage(feedbackId)
    const caseNumber = triage?.caseNumber
    if (!caseNumber) {
      return NextResponse.json(
        { error: 'Cannot determine caseNumber — Stage 1 triage missing. Re-run triage.' },
        { status: 404 },
      )
    }

    // Conflict detection — refuse if Airtable has changed since Stage 2.
    const liveValue = await getCaseFieldValue(caseNumber, recordId, fieldName)
    const expected = entry.currentText
    const actual = liveValue ?? ''
    if (normalise(actual) !== normalise(expected)) {
      return NextResponse.json(
        {
          conflict: true,
          expected,
          actual: liveValue,
          message:
            'The current Airtable value differs from what Stage 2 was rewriting. ' +
            'Refusing to overwrite. Re-run "Generate rewrites" to pick up the live content, ' +
            'or apply the change manually in Airtable.',
        },
        { status: 409 },
      )
    }

    await updateCaseField(caseNumber, recordId, fieldName, newValue)
    await markRewriteApplied(feedbackId, recordId, fieldName)

    const appliedAt = new Date().toISOString()
    return NextResponse.json({ applied: true, appliedAt })
  } catch (err: any) {
    console.error('apply-edit error:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}

// Normalise whitespace-only differences to avoid spurious 409s from invisible
// Airtable trailing-newline behaviour or copy-paste artifacts.
function normalise(s: string): string {
  return s.replace(/\r\n/g, '\n').trim()
}
