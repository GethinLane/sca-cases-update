// lib/triage-store.ts
// Storage layer for triage audit results.
// Uses Upstash Redis via REST API if UPSTASH_REDIS_REST_URL is set,
// otherwise falls back to in-memory (good for local dev, resets on deploy).

export interface TriageResult {
  caseNumber: string
  status: 'up-to-date' | 'review-needed' | 'outdated' | 'error' | 'pending'
  summary: string
  searchCount: number
  citedUrls: string[]
  provider: string
  model: string
  timestamp: string // ISO date
  assessmentSnippet?: string // first 200 chars of the assessment field
  managementSnippet?: string // first 200 chars of the management field
}

export interface TriageMetadata {
  lastScanStarted: string | null
  lastScanCompleted: string | null
  totalCases: number
  casesScanned: number
  scanInProgress: boolean
}

// ─── Upstash Redis REST client (no npm dependency needed) ─────────

async function redisCommand(command: string[]): Promise<any> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null

  const res = await fetch(`${url}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  const data = await res.json()
  if (data.error) throw new Error(`Redis error: ${data.error}`)
  return data.result
}

// ─── In-memory fallback ───────────────────────────────────────────

const memStore: Record<string, string> = {}

// ─── Store interface ──────────────────────────────────────────────

function useRedis(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

async function setKey(key: string, value: string): Promise<void> {
  if (useRedis()) {
    await redisCommand(['SET', key, value])
  } else {
    memStore[key] = value
  }
}

async function getKey(key: string): Promise<string | null> {
  if (useRedis()) {
    return await redisCommand(['GET', key])
  }
  return memStore[key] ?? null
}

async function getAllKeysWithPrefix(prefix: string): Promise<string[]> {
  if (useRedis()) {
    // SCAN-based approach for production; for small datasets KEYS is fine
    const keys = await redisCommand(['KEYS', `${prefix}*`])
    return keys ?? []
  }
  return Object.keys(memStore).filter(k => k.startsWith(prefix))
}

// ─── Triage-specific operations ───────────────────────────────────

const TRIAGE_PREFIX = 'triage:'
const META_KEY = 'triage:_meta'

export async function saveTriageResult(result: TriageResult): Promise<void> {
  await setKey(`${TRIAGE_PREFIX}${result.caseNumber}`, JSON.stringify(result))
}

export async function getTriageResult(caseNumber: string): Promise<TriageResult | null> {
  const raw = await getKey(`${TRIAGE_PREFIX}${caseNumber}`)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function getAllTriageResults(): Promise<TriageResult[]> {
  const keys = await getAllKeysWithPrefix(TRIAGE_PREFIX)
  const results: TriageResult[] = []

  for (const key of keys) {
    if (key === META_KEY) continue
    const raw = await getKey(key)
    if (raw) {
      try {
        results.push(JSON.parse(raw))
      } catch { /* skip corrupt entries */ }
    }
  }

  return results.sort((a, b) => {
    const numA = parseInt(a.caseNumber) || 0
    const numB = parseInt(b.caseNumber) || 0
    return numA - numB
  })
}

export async function getTriageMetadata(): Promise<TriageMetadata> {
  const raw = await getKey(META_KEY)
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch { /* fall through */ }
  }
  return {
    lastScanStarted: null,
    lastScanCompleted: null,
    totalCases: 0,
    casesScanned: 0,
    scanInProgress: false,
  }
}

export async function saveTriageMetadata(meta: TriageMetadata): Promise<void> {
  await setKey(META_KEY, JSON.stringify(meta))
}

export async function clearTriageResult(caseNumber: string): Promise<void> {
  if (useRedis()) {
    await redisCommand(['DEL', `${TRIAGE_PREFIX}${caseNumber}`])
  } else {
    delete memStore[`${TRIAGE_PREFIX}${caseNumber}`]
  }
}
