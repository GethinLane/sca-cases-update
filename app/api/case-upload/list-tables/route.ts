// app/api/case-upload/list-tables/route.ts
// Lists "Case N" tables in the Cases base via the Metadata API so the
// uploader UI can populate the target-table picker and use the real field
// names as the source of truth for heading→field mapping.

import { NextResponse } from 'next/server'
import { listCaseTables } from '@/lib/airtable'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const tables = await listCaseTables()
    return NextResponse.json({ tables })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'Failed to list case tables' },
      { status: 500 },
    )
  }
}
