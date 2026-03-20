'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import styles from './page.module.css'

interface TriageResult {
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
}

interface Stats {
  total: number
  upToDate: number
  reviewNeeded: number
  outdated: number
  errors: number
  pending: number
  totalSearches: number
}

interface TriageMetadata {
  lastScanStarted: string | null
  lastScanCompleted: string | null
  totalCases: number
  casesScanned: number
  scanInProgress: boolean
}

type FilterStatus = 'all' | 'outdated' | 'review-needed' | 'up-to-date' | 'pending' | 'error'

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  'up-to-date': { label: 'Up to date', className: 'statusUpToDate' },
  'review-needed': { label: 'Review needed', className: 'statusReviewNeeded' },
  'outdated': { label: 'Outdated', className: 'statusOutdated' },
  'error': { label: 'Error', className: 'statusError' },
  'pending': { label: 'Pending', className: 'statusPending' },
}

export default function AuditDashboard() {
  const [results, setResults] = useState<TriageResult[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [metadata, setMetadata] = useState<TriageMetadata | null>(null)
  const [provider, setProvider] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterStatus>('all')
  const [selectedCase, setSelectedCase] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 })
  const [syncing, setSyncing] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/triage-status')
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setResults(data.results ?? [])
      setStats(data.stats ?? null)
      setMetadata(data.metadata ?? null)
      setProvider(data.provider ?? '')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  // Sync cases from Airtable
  async function syncCases() {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync-cases', { method: 'POST' })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      await fetchStatus()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSyncing(false)
    }
  }

  // Run triage scan — processes cases sequentially with a delay
  async function runScan() {
    setScanning(true)
    const casesToScan = results
      .filter(r => r.status === 'pending' || r.status === 'error')
      .map(r => r.caseNumber)

    // If nothing pending, scan ALL cases
    const targets = casesToScan.length > 0 ? casesToScan : results.map(r => r.caseNumber)
    setScanProgress({ current: 0, total: targets.length })

    for (let i = 0; i < targets.length; i++) {
      try {
        const res = await fetch('/api/triage-case', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caseNumber: targets[i], batchMode: true }),
        })
        const data = await res.json()
        // Update the result in-place
        setResults(prev =>
          prev.map(r => r.caseNumber === targets[i] ? { ...r, ...data } : r)
        )
      } catch { /* continue on error */ }

      setScanProgress({ current: i + 1, total: targets.length })

      // Delay between cases to be nice to APIs
      if (i < targets.length - 1) {
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    setScanning(false)
    await fetchStatus()
  }

  // Triage a single case
  async function triageSingle(caseNumber: string) {
    setResults(prev =>
      prev.map(r => r.caseNumber === caseNumber ? { ...r, status: 'pending' as const, summary: 'Scanning...' } : r)
    )
    try {
      const res = await fetch('/api/triage-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseNumber, batchMode: false }),
      })
      const data = await res.json()
      setResults(prev =>
        prev.map(r => r.caseNumber === caseNumber ? { ...r, ...data } : r)
      )
    } catch (e: any) {
      setResults(prev =>
        prev.map(r => r.caseNumber === caseNumber ? { ...r, status: 'error' as const, summary: e.message } : r)
      )
    }
  }

  // Filter results
  const filtered = filter === 'all'
    ? results
    : results.filter(r => r.status === filter)

  // Sort: outdated first, then review-needed, then pending, then error, then up-to-date
  const sortOrder: Record<string, number> = { 'outdated': 0, 'review-needed': 1, 'pending': 2, 'error': 3, 'up-to-date': 4 }
  const sorted = [...filtered].sort((a, b) => (sortOrder[a.status] ?? 5) - (sortOrder[b.status] ?? 5))

  const selectedResult = results.find(r => r.caseNumber === selectedCase)

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
  }

  return (
    <div className={styles.root}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.logo}>
            <div className={styles.logoMark}>⚕</div>
            <div>
              <div className={styles.logoText}>SCA Revision Bot</div>
              <div className={styles.logoSub}>Guideline Audit Dashboard</div>
            </div>
          </div>
          <nav className={styles.headerNav}>
            <Link href="/" className={styles.navLink}>Feedback Review</Link>
            <Link href="/audit" className={`${styles.navLink} ${styles.navLinkActive}`}>Guideline Audit</Link>
          </nav>
        </div>
      </header>

      {/* Stats bar */}
      <div className={styles.statsBar}>
        {stats && (
          <>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Total cases</div>
              <div className={`${styles.statValue} ${styles.statMuted}`}>{stats.total}</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Up to date</div>
              <div className={`${styles.statValue} ${styles.statGreen}`}>{stats.upToDate}</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Review needed</div>
              <div className={`${styles.statValue} ${styles.statAmber}`}>{stats.reviewNeeded}</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Outdated</div>
              <div className={`${styles.statValue} ${styles.statRed}`}>{stats.outdated}</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Pending</div>
              <div className={`${styles.statValue} ${styles.statMuted}`}>{stats.pending}</div>
            </div>
          </>
        )}
        <div className={styles.scanControls}>
          {provider && (
            <span className={styles.providerBadge}>
              Provider: {provider}
            </span>
          )}
          <button
            className={`${styles.scanBtn} ${styles.scanBtnSecondary}`}
            onClick={syncCases}
            disabled={syncing || scanning}
          >
            {syncing ? <><span className={styles.btnSpinner} /> Syncing…</> : '⬇ Sync from Airtable'}
          </button>
          <button
            className={styles.scanBtn}
            onClick={runScan}
            disabled={scanning || syncing || results.length === 0}
          >
            {scanning ? <><span className={styles.btnSpinner} /> Scanning…</> : '⚡ Run triage scan'}
          </button>
        </div>
      </div>

      {/* Scan progress */}
      {scanning && (
        <div style={{ padding: '0 28px' }}>
          <div className={styles.progressWrap}>
            <div
              className={styles.progressBar}
              style={{ width: `${scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0}%` }}
            />
          </div>
          <div className={styles.progressText}>
            Scanning case {scanProgress.current} of {scanProgress.total}…
          </div>
        </div>
      )}

      {/* Content */}
      <div className={styles.content}>
        {loading && (
          <div className={styles.stateBox}>
            <div className={styles.spinner} />
            <p>Loading audit data…</p>
          </div>
        )}

        {error && !loading && (
          <div className={styles.stateBox}>
            <p style={{ color: '#dc2626' }}>Error: {error}</p>
            <p style={{ fontSize: 13 }}>
              Check your environment variables. If this is a fresh setup, click "Sync from Airtable" first.
            </p>
          </div>
        )}

        {!loading && !error && results.length === 0 && (
          <div className={styles.stateBox}>
            <div className={styles.emptyIcon}>📋</div>
            <div className={styles.emptyText}>No cases loaded yet</div>
            <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>
              Click "Sync from Airtable" to load your cases, then "Run triage scan" to check them against current guidelines.
            </p>
          </div>
        )}

        {!loading && !error && results.length > 0 && (
          <>
            {/* Filter bar */}
            <div className={styles.filterBar}>
              {(['all', 'outdated', 'review-needed', 'up-to-date', 'pending', 'error'] as FilterStatus[]).map(f => {
                const count = f === 'all' ? results.length : results.filter(r => r.status === f).length
                if (count === 0 && f !== 'all') return null
                const labels: Record<string, string> = {
                  'all': 'All',
                  'outdated': 'Outdated',
                  'review-needed': 'Review needed',
                  'up-to-date': 'Up to date',
                  'pending': 'Pending',
                  'error': 'Errors',
                }
                return (
                  <button
                    key={f}
                    className={`${styles.filterBtn} ${filter === f ? styles.filterBtnActive : ''}`}
                    onClick={() => setFilter(f)}
                  >
                    {labels[f]}<span className={styles.filterCount}>({count})</span>
                  </button>
                )
              })}
            </div>

            {/* Case list */}
            <div className={styles.caseList}>
              {sorted.map(r => {
                const sc = STATUS_CONFIG[r.status] ?? STATUS_CONFIG['pending']
                return (
                  <div
                    key={r.caseNumber}
                    className={`${styles.caseRow} ${selectedCase === r.caseNumber ? styles.caseRowSelected : ''}`}
                    onClick={() => setSelectedCase(r.caseNumber === selectedCase ? null : r.caseNumber)}
                  >
                    <div className={styles.caseNum}>Case {r.caseNumber}</div>
                    <span className={`${styles.statusBadge} ${styles[sc.className]}`}>{sc.label}</span>
                    <div className={styles.caseSummary}>
                      {r.summary.replace(/\*\*/g, '')}
                    </div>
                    <div className={styles.caseTimestamp}>
                      {r.timestamp && r.status !== 'pending' ? timeAgo(r.timestamp) : '—'}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Detail panel */}
            {selectedResult && (
              <div className={styles.detailPanel}>
                <div className={styles.detailHeader}>
                  <h2 className={styles.detailTitle}>Case {selectedResult.caseNumber}</h2>
                  <div className={styles.detailActions}>
                    <button
                      className={styles.scanBtn}
                      onClick={() => triageSingle(selectedResult.caseNumber)}
                      disabled={scanning}
                      style={{ fontSize: 12, padding: '8px 14px' }}
                    >
                      ↺ Re-triage
                    </button>
                    <Link
                      href={`/?case=${selectedResult.caseNumber}`}
                      className={styles.scanBtn}
                      style={{ fontSize: 12, padding: '8px 14px', textDecoration: 'none', background: 'var(--navy)' }}
                    >
                      ⚡ Full analysis
                    </Link>
                  </div>
                </div>

                <div className={styles.detailSection}>
                  <p className={styles.detailLabel}>Triage verdict</p>
                  <p className={styles.detailText}
                    dangerouslySetInnerHTML={{
                      __html: selectedResult.summary
                        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    }}
                  />
                </div>

                {selectedResult.assessmentSnippet && (
                  <div className={styles.detailSection}>
                    <p className={styles.detailLabel}>Assessment (preview)</p>
                    <pre className={styles.detailSnippet}>{selectedResult.assessmentSnippet}…</pre>
                  </div>
                )}

                {selectedResult.managementSnippet && (
                  <div className={styles.detailSection}>
                    <p className={styles.detailLabel}>Management (preview)</p>
                    <pre className={styles.detailSnippet}>{selectedResult.managementSnippet}…</pre>
                  </div>
                )}

                {selectedResult.citedUrls.length > 0 && (
                  <div className={styles.detailSection}>
                    <p className={styles.detailLabel}>Sources accessed</p>
                    <ul className={styles.detailSources}>
                      {selectedResult.citedUrls.map((url, i) => (
                        <li key={i}>
                          <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className={styles.detailMeta}>
                  <span className={styles.detailMetaItem}>
                    Provider: <strong>{selectedResult.provider || '—'}</strong>
                  </span>
                  <span className={styles.detailMetaItem}>
                    Model: <strong>{selectedResult.model || '—'}</strong>
                  </span>
                  <span className={styles.detailMetaItem}>
                    Searches: <strong>{selectedResult.searchCount}</strong>
                  </span>
                  <span className={styles.detailMetaItem}>
                    Scanned: <strong>{selectedResult.timestamp ? new Date(selectedResult.timestamp).toLocaleString() : '—'}</strong>
                  </span>
                </div>
              </div>
            )}

            {/* Last scan info */}
            {metadata?.lastScanCompleted && (
              <div style={{ marginTop: 20, fontSize: 12, color: '#888', textAlign: 'center' }}>
                Last full scan completed: {new Date(metadata.lastScanCompleted).toLocaleString()}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
