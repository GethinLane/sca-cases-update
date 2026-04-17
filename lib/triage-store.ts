// lib/triage-store.ts
// Storage layer using Vercel Blob — ONE FILE PER CASE.
// Fails loudly if BLOB_READ_WRITE_TOKEN is not set — no silent in-memory fallback.

import { put, list, get, del } from '@vercel/blob'

// Fail fast at module load — better than silent data loss in serverless.
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  throw new Error(
    'BLOB_READ_WRITE_TOKEN is not set. Triage store requires Vercel Blob storage. ' +
    'Set this env var locally (via `vercel env pull`) and in your deployment environment.',
  )
}

export interface TriageResult {
  caseNumber: string
  status: 'up-to-date' | 'review-needed' | 'outdated' | 'error' | 'pending'
  summary: string
  searchCount: number
  citedUrls: string[]
  provider: string
  model: string
  timestamp: string
  /** First ~N chars of Assessment field, kept as a sidebar preview only. */
  assessmentSnippet?: string
  /** First ~N chars of Management field, kept as a sidebar preview only. */
  managementSnippet?: string
  /** Manual review timestamp — set when a human marks the case as reviewed. */
  reviewedAt?: string
  // NOTE: fullCaseFields has been removed. Full analysis now re-fetches from Airtable
  // to guarantee it's looking at the current content.
}

export interface TriageMetadata {
  lastScanStarted: string | null
  lastScanCompleted: string | null
  totalCases: number
  casesScanned: number
  scanInProgress: boolean
}

// ─── Blob helpers ─────────────────────────────────────────────────

function casePath(caseNumber: string): string {
  return `triage/case-${caseNumber}.json`
}

const META_PATH = 'triage/meta.json'

async function readBlob(path: string): Promise<any | null> {
  try {
    const { blobs } = await list({ prefix: path, limit: 1 })
    const blob = blobs.find(b => b.pathname === path)
    if (!blob) return null

    const res = await get(blob.url, { access: 'private' })
    if (!res || res.statusCode !== 200) return null

    const text = await new Response(res.stream).text()
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function writeBlob(path: string, data: any): Promise<void> {
  await put(path, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

// ─── Public API ───────────────────────────────────────────────────

export async function saveTriageResult(result: TriageResult): Promise<void> {
  await writeBlob(casePath(result.caseNumber), result)
}

export async function getTriageResult(caseNumber: string): Promise<TriageResult | null> {
  return await readBlob(casePath(caseNumber))
}

export async function getAllTriageResults(): Promise<TriageResult[]> {
  const results: TriageResult[] = []

  let cursor: string | undefined
  do {
    const page = await list({ prefix: 'triage/case-', limit: 1000, cursor })
    for (const blob of page.blobs) {
      try {
        const res = await get(blob.url, { access: 'private' })
        if (res && res.statusCode === 200) {
          const text = await new Response(res.stream).text()
          results.push(JSON.parse(text) as TriageResult)
        }
      } catch { /* skip corrupt entries */ }
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  return results.sort((a, b) =>
    (parseInt(a.caseNumber) || 0) - (parseInt(b.caseNumber) || 0),
  )
}

export async function getTriageMetadata(): Promise<TriageMetadata> {
  const data = await readBlob(META_PATH)
  return data ?? {
    lastScanStarted: null,
    lastScanCompleted: null,
    totalCases: 0,
    casesScanned: 0,
    scanInProgress: false,
  }
}

export async function saveTriageMetadata(meta: TriageMetadata): Promise<void> {
  await writeBlob(META_PATH, meta)
}

export async function clearTriageResult(caseNumber: string): Promise<void> {
  try {
    const { blobs } = await list({ prefix: casePath(caseNumber), limit: 1 })
    const blob = blobs.find(b => b.pathname === casePath(caseNumber))
    if (blob) await del(blob.url)
  } catch { /* ignore */ }
}
