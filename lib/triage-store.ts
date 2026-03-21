// lib/triage-store.ts
// Storage layer using Vercel Blob — ONE FILE PER CASE.
// Each case is stored as triage/case-{number}.json
// Metadata is stored as triage/meta.json
// Falls back to in-memory if BLOB_READ_WRITE_TOKEN is not set.

import { put, list, get, del } from '@vercel/blob'

export interface TriageResult {
  caseNumber: string
  status: 'up-to-date' | 'review-needed' | 'outdated' | 'error' | 'pending'
  summary: string
  searchCount: number
  citedUrls: string[]
  provider: string
  model: string
  timestamp: string
  assessmentSnippet?: string
  managementSnippet?: string
  // Full case fields stored so full-analysis can use them without re-fetching
  fullCaseFields?: Record<string, string>
  // Manual review timestamp — set when a human marks the case as reviewed
  reviewedAt?: string
}

export interface TriageMetadata {
  lastScanStarted: string | null
  lastScanCompleted: string | null
  totalCases: number
  casesScanned: number
  scanInProgress: boolean
}

// ─── In-memory fallback ───────────────────────────────────────────

const memResults: Record<string, TriageResult> = {}
let memMeta: TriageMetadata = {
  lastScanStarted: null,
  lastScanCompleted: null,
  totalCases: 0,
  casesScanned: 0,
  scanInProgress: false,
}

function useBlob(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN
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
  try {
    await put(path, JSON.stringify(data), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  } catch (err) {
    console.error(`Error writing blob ${path}:`, err)
  }
}

// ─── Public API ───────────────────────────────────────────────────

export async function saveTriageResult(result: TriageResult): Promise<void> {
  if (!useBlob()) {
    memResults[result.caseNumber] = result
    return
  }
  await writeBlob(casePath(result.caseNumber), result)
}

export async function getTriageResult(caseNumber: string): Promise<TriageResult | null> {
  if (!useBlob()) return memResults[caseNumber] ?? null
  return await readBlob(casePath(caseNumber))
}

export async function getAllTriageResults(): Promise<TriageResult[]> {
  if (!useBlob()) {
    return Object.values(memResults).sort((a, b) =>
      (parseInt(a.caseNumber) || 0) - (parseInt(b.caseNumber) || 0)
    )
  }

  const results: TriageResult[] = []

  // List all case blobs — Vercel Blob list returns up to 1000 per call
  let cursor: string | undefined
  do {
    const page = await list({
      prefix: 'triage/case-',
      limit: 1000,
      cursor,
    })

    // Fetch each blob's content
    for (const blob of page.blobs) {
      try {
        const res = await get(blob.url, { access: 'private' })
        if (res && res.statusCode === 200) {
          const text = await new Response(res.stream).text()
          const parsed = JSON.parse(text) as TriageResult
          results.push(parsed)
        }
      } catch { /* skip corrupt entries */ }
    }

    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  return results.sort((a, b) =>
    (parseInt(a.caseNumber) || 0) - (parseInt(b.caseNumber) || 0)
  )
}

export async function getTriageMetadata(): Promise<TriageMetadata> {
  if (!useBlob()) return memMeta
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
  if (!useBlob()) {
    memMeta = meta
    return
  }
  await writeBlob(META_PATH, meta)
}

export async function clearTriageResult(caseNumber: string): Promise<void> {
  if (!useBlob()) {
    delete memResults[caseNumber]
    return
  }
  try {
    const { blobs } = await list({ prefix: casePath(caseNumber), limit: 1 })
    const blob = blobs.find(b => b.pathname === casePath(caseNumber))
    if (blob) await del(blob.url)
  } catch { /* ignore */ }
}
