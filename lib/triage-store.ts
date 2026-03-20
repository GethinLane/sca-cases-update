// lib/triage-store.ts
// Storage layer for triage audit results using Vercel Blob (private access).
// Stores all results in a single JSON blob for simplicity and efficiency.
// Falls back to in-memory storage if BLOB_READ_WRITE_TOKEN is not set.
//
// Requires: npm install @vercel/blob
// Env var: BLOB_READ_WRITE_TOKEN (auto-set when you add a Blob store in Vercel dashboard)

import { put, list, get } from '@vercel/blob'

export interface TriageResult {
  caseNumber: string
  status: 'up-to-date' | 'review-needed' | 'outdated' | 'error' | 'pending'
  summary: string
  searchCount: number
  citedUrls: string[]
  provider: string
  model: string
  timestamp: string // ISO date
  assessmentSnippet?: string
  managementSnippet?: string
}

export interface TriageMetadata {
  lastScanStarted: string | null
  lastScanCompleted: string | null
  totalCases: number
  casesScanned: number
  scanInProgress: boolean
}

interface TriageStore {
  results: Record<string, TriageResult> // keyed by caseNumber
  metadata: TriageMetadata
}

const BLOB_PATH = 'triage/store.json'

// ─── In-memory fallback ───────────────────────────────────────────

let memStore: TriageStore = {
  results: {},
  metadata: {
    lastScanStarted: null,
    lastScanCompleted: null,
    totalCases: 0,
    casesScanned: 0,
    scanInProgress: false,
  },
}

const EMPTY_STORE: TriageStore = {
  results: {},
  metadata: {
    lastScanStarted: null,
    lastScanCompleted: null,
    totalCases: 0,
    casesScanned: 0,
    scanInProgress: false,
  },
}

function useBlob(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN
}

// ─── Blob read/write ──────────────────────────────────────────────

async function readStore(): Promise<TriageStore> {
  if (!useBlob()) return memStore

  try {
    let blobs
    try {
      const result = await list({ prefix: 'triage/' })
      blobs = result.blobs
    } catch {
      console.warn('Blob list() failed — returning empty store')
      return EMPTY_STORE
    }

    const storeBlob = blobs.find(b => b.pathname === BLOB_PATH)
    if (!storeBlob) return EMPTY_STORE

    // Use get() for private stores instead of fetch()
    const res = await get(storeBlob.url, { access: 'private' })
    if (!res || res.statusCode !== 200) return EMPTY_STORE

    const text = await res.text()
    try {
      return JSON.parse(text) as TriageStore
    } catch {
      console.warn('Blob content is not valid JSON — returning empty store')
      return EMPTY_STORE
    }
  } catch (err) {
    console.error('Error reading triage store from Blob:', err)
    return EMPTY_STORE
  }
}

async function writeStore(store: TriageStore): Promise<void> {
  if (!useBlob()) {
    memStore = store
    return
  }

  try {
    await put(BLOB_PATH, JSON.stringify(store), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  } catch (err) {
    console.error('Error writing triage store to Blob:', err)
    memStore = store
  }
}

// ─── Public API ───────────────────────────────────────────────────

export async function saveTriageResult(result: TriageResult): Promise<void> {
  const store = await readStore()
  store.results[result.caseNumber] = result
  await writeStore(store)
}

export async function getTriageResult(caseNumber: string): Promise<TriageResult | null> {
  const store = await readStore()
  return store.results[caseNumber] ?? null
}

export async function getAllTriageResults(): Promise<TriageResult[]> {
  const store = await readStore()
  return Object.values(store.results).sort((a, b) => {
    const numA = parseInt(a.caseNumber) || 0
    const numB = parseInt(b.caseNumber) || 0
    return numA - numB
  })
}

export async function getTriageMetadata(): Promise<TriageMetadata> {
  const store = await readStore()
  return store.metadata
}

export async function saveTriageMetadata(meta: TriageMetadata): Promise<void> {
  const store = await readStore()
  store.metadata = meta
  await writeStore(store)
}

export async function clearTriageResult(caseNumber: string): Promise<void> {
  const store = await readStore()
  delete store.results[caseNumber]
  await writeStore(store)
}

// ─── Bulk helpers (efficient for batch scans) ─────────────────────

export { writeStore, readStore }
