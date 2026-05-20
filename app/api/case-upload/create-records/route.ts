// app/api/case-upload/create-records/route.ts
// Creates rows in a chosen "Case N" table from the parsed-and-mapped case
// upload. Caller has already done heading→field mapping client-side so this
// endpoint just batches the writes.

import { NextRequest, NextResponse } from 'next/server'
import { createCaseRecords } from '@/lib/airtable'

export const runtime = 'nodejs'
export const maxDuration = 60

interface RequestBody {
  tableName?: string
  rows?: Array<Record<string, string>>
}

const MAX_ROWS = 16  // Defensive; real cases use up to 8.

export async function POST(req: NextRequest) {
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const tableName = body.tableName?.trim()
  if (!tableName) {
    return NextResponse.json({ error: 'Missing tableName' }, { status: 400 })
  }
  if (!/^Case\b/i.test(tableName)) {
    return NextResponse.json(
      { error: `Refusing to write to table "${tableName}" — expected a "Case …" table.` },
      { status: 400 },
    )
  }

  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No rows to create' }, { status: 400 })
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `Refusing to create ${rows.length} rows (max ${MAX_ROWS})` },
      { status: 413 },
    )
  }

  // Strip empty values so we don't send blank strings to Airtable.
  const cleaned: Array<Record<string, string>> = rows.map(row => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  }).filter(r => Object.keys(r).length > 0)

  if (cleaned.length === 0) {
    return NextResponse.json({ error: 'All rows were empty after stripping blanks' }, { status: 400 })
  }

  try {
    const result = await createCaseRecords(tableName, cleaned)
    // Hard refusal — target rows have data. No override; user must
    // clear those rows in Airtable before retrying.
    if (result.refusedOverwrite) {
      return NextResponse.json(
        {
          refusedOverwrite: true,
          tableName,
          nonEmptyRowCount: result.refusedOverwrite.nonEmptyRowCount,
          samplePreviews: result.refusedOverwrite.samplePreviews,
        },
        { status: 409 },
      )
    }
    if (result.errors.length > 0 && result.created === 0 && result.updated === 0) {
      return NextResponse.json(
        {
          error: result.errors.join('; '),
          created: 0,
          updated: 0,
          errors: result.errors,
        },
        { status: 502 },
      )
    }
    return NextResponse.json({
      tableName,
      created: result.created,
      updated: result.updated,
      recordIds: result.recordIds,
      errors: result.errors,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'Failed to create records' },
      { status: 500 },
    )
  }
}
