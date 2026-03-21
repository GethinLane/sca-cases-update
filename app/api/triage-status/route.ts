// app/api/triage-status/route.ts
// Returns all triage results and scan metadata for the audit dashboard.

import { NextResponse } from 'next/server'
import { getAllTriageResults, getTriageMetadata } from '@/lib/triage-store'
import { getTriageProvider } from '@/lib/ai-provider'

export async function GET() {
  try {
    const [results, metadata] = await Promise.all([
      getAllTriageResults(),
      getTriageMetadata(),
    ])

    // Compute summary stats
    const stats = {
      total: results.length,
      upToDate: results.filter(r => r.status === 'up-to-date').length,
      reviewNeeded: results.filter(r => r.status === 'review-needed').length,
      outdated: results.filter(r => r.status === 'outdated').length,
      errors: results.filter(r => r.status === 'error').length,
      pending: results.filter(r => r.status === 'pending').length,
      reviewed: results.filter(r => !!r.reviewedAt).length,
      totalSearches: results.reduce((sum, r) => sum + (r.searchCount ?? 0), 0),
    }

    return NextResponse.json({
      results,
      metadata,
      stats,
      provider: getTriageProvider(),
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
