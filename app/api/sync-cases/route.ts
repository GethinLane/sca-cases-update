// app/api/sync-cases/route.ts
// Fetches all case Assessment + Management fields from Airtable and stores in KV.
// This is called before a triage scan, or can be triggered independently.

import { NextResponse } from 'next/server'
import { getCaseData } from '@/lib/airtable'
import { saveTriageResult, getTriageResult, saveTriageMetadata, getTriageMetadata } from '@/lib/triage-store'

export const maxDuration = 60 // Vercel Pro: up to 300s

export async function POST() {
  try {
    // Determine how many cases to sync — configurable via env
    const totalCases = parseInt(process.env.TOTAL_CASE_COUNT ?? '355')
    const meta = await getTriageMetadata()

    // Fetch each case and store Assessment + Management fields
    let synced = 0
    const errors: string[] = []

    // Process in small batches to respect Airtable rate limits (5 req/s)
    const batchSize = 4
    const delayMs = 1000

    for (let i = 1; i <= totalCases; i += batchSize) {
      const batch = []
      for (let j = i; j < i + batchSize && j <= totalCases; j++) {
        batch.push(j)
      }

      await Promise.all(
        batch.map(async (caseNum) => {
          try {
            const data = await getCaseData(String(caseNum))
            if (!data || !data.fields) {
              // Don't overwrite existing triage if case not found
              return
            }

            // Find assessment and management fields (case-insensitive search)
            const fields = data.fields
            let assessmentText = ''
            let managementText = ''

            for (const [key, value] of Object.entries(fields)) {
              const lower = key.toLowerCase()
              if (lower.includes('assessment') && !lower.includes('self')) {
                assessmentText += (assessmentText ? '\n\n' : '') + value
              }
              if (lower.includes('management') || lower.includes('plan')) {
                managementText += (managementText ? '\n\n' : '') + value
              }
            }

            // Check if we already have a triage result — only update the snippets
            const existing = await getTriageResult(String(caseNum))
            if (existing) {
              existing.assessmentSnippet = assessmentText.slice(0, 200)
              existing.managementSnippet = managementText.slice(0, 200)
              await saveTriageResult(existing)
            } else {
              // Create a "pending" entry
              await saveTriageResult({
                caseNumber: String(caseNum),
                status: 'pending',
                summary: 'Not yet scanned',
                searchCount: 0,
                citedUrls: [],
                provider: '',
                model: '',
                timestamp: new Date().toISOString(),
                assessmentSnippet: assessmentText.slice(0, 200),
                managementSnippet: managementText.slice(0, 200),
              })
            }
            synced++
          } catch (err: any) {
            errors.push(`Case ${caseNum}: ${err.message}`)
          }
        })
      )

      // Rate limit pause between batches
      if (i + batchSize <= totalCases) {
        await new Promise(r => setTimeout(r, delayMs))
      }
    }

    await saveTriageMetadata({
      ...meta,
      totalCases,
      casesScanned: meta.casesScanned, // don't reset scan count
      scanInProgress: meta.scanInProgress,
      lastScanStarted: meta.lastScanStarted,
      lastScanCompleted: meta.lastScanCompleted,
    })

    return NextResponse.json({
      synced,
      total: totalCases,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
