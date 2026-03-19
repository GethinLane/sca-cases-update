'use client'

import { useState, useEffect } from 'react'
import styles from './page.module.css'

interface FeedbackItem {
  feedback: {
    id: string
    caseNumber: string
    issueSummary: string
    contactRegardingOutcome: boolean
    contactEmail: string
  }
  caseData: {
    caseNumber: string
    fields: Record<string, string>
  } | null
}

interface FieldChange {
  fieldName: string
  currentText: string
  issue: string
  suggestedText: string
  confidence: 'high' | 'medium' | 'low'
}

interface Analysis {
  verdict: 'valid' | 'invalid' | 'partial' | 'uncertain'
  verdictReason: string
  summary: string
  sources: string[]
  fieldChanges: FieldChange[]
  emailResponse: string
}

type AnalysisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; data: Analysis }
  | { status: 'error'; message: string }

export default function Dashboard() {
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [analyses, setAnalyses] = useState<Record<string, AnalysisState>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch('/api/fetch-feedback')
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setItems(d.items)
        if (d.items.length > 0) setSelectedId(d.items[0].feedback.id)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function analyse(item: FeedbackItem) {
    const key = item.feedback.id
    setAnalyses(a => ({ ...a, [key]: { status: 'loading' } }))
    try {
      const res = await fetch('/api/analyse-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: item.feedback, caseData: item.caseData }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setAnalyses(a => ({ ...a, [key]: { status: 'done', data } }))
    } catch (e: any) {
      setAnalyses(a => ({ ...a, [key]: { status: 'error', message: e.message } }))
    }
  }

  function copyEmail(id: string, text: string) {
    navigator.clipboard.writeText(text)
    setCopied(c => ({ ...c, [id]: true }))
    setTimeout(() => setCopied(c => ({ ...c, [id]: false })), 2000)
  }

  const verdictConfig = {
    valid:    { label: 'Valid correction',    color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
    invalid:  { label: 'Not valid',           color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    partial:  { label: 'Partially valid',     color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    uncertain:{ label: 'Uncertain',           color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  }

  const confidenceConfig = {
    high:   { label: 'High confidence',   color: '#15803d', bg: '#dcfce7' },
    medium: { label: 'Medium confidence', color: '#b45309', bg: '#fef3c7' },
    low:    { label: 'Low confidence',    color: '#b91c1c', bg: '#fee2e2' },
  }

  const selectedItem = items.find(i => i.feedback.id === selectedId) ?? null
  const selectedState = selectedId ? (analyses[selectedId] ?? { status: 'idle' }) : null

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.logo}>
            <div className={styles.logoMark}>⚕</div>
            <div>
              <div className={styles.logoText}>SCA Revision Bot</div>
              <div className={styles.logoSub}>Case Correction Review Tool</div>
            </div>
          </div>
          <span className={styles.headerBadge}>scarevision.co.uk</span>
        </div>
      </header>

      <div className={styles.appShell}>

        {/* ── Sidebar ── */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarTitle}>Pending submissions</div>
            {loading ? (
              <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>Loading…</div>
            ) : (
              <>
                <div className={styles.sidebarCount}>{items.length}</div>
                <div className={styles.sidebarCountLabel}>{items.length === 1 ? 'submission' : 'submissions'}</div>
              </>
            )}
          </div>

          <div className={styles.sidebarList}>
            {error && (
              <div style={{ padding: '16px', fontSize: 13, color: '#dc2626' }}>
                Failed to load. Check your environment variables.
              </div>
            )}
            {!loading && !error && items.length === 0 && (
              <div style={{ padding: '24px 20px', fontSize: 13, color: '#999', textAlign: 'center' }}>
                ✓ No pending feedback
              </div>
            )}
            {items.map(item => {
              const isActive = item.feedback.id === selectedId
              const state = analyses[item.feedback.id]
              return (
                <div
                  key={item.feedback.id}
                  className={`${styles.sidebarItem} ${isActive ? styles.sidebarItemActive : ''}`}
                  onClick={() => setSelectedId(item.feedback.id)}
                >
                  <div className={styles.sidebarCaseNum}>
                    Case {item.feedback.caseNumber || '?'}
                    {state?.status === 'done' && ' ✓'}
                    {state?.status === 'loading' && ' …'}
                    {state?.status === 'error' && ' ✗'}
                  </div>
                  <div className={styles.sidebarSnippet}>{item.feedback.issueSummary}</div>
                  <div className={styles.sidebarTags}>
                    {item.feedback.contactRegardingOutcome && (
                      <span className={styles.sidebarTagContact}>Reply needed</span>
                    )}
                    {!item.caseData && (
                      <span className={styles.sidebarTagWarn}>Case not found</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className={styles.content}>
          {loading && (
            <div className={styles.stateBox}>
              <div className={styles.spinner} />
              <p>Fetching feedback from Airtable…</p>
            </div>
          )}

          {error && (
            <div className={styles.errorBox}>
              <strong>Failed to load feedback</strong>
              <p>{error}</p>
              <p className={styles.hint}>Check: AIRTABLE_TOKEN, AIRTABLE_FEEDBACK_BASE_ID, AIRTABLE_CASES_BASE_ID</p>
            </div>
          )}

          {!loading && !error && !selectedItem && (
            <div className={styles.emptyState}>
              <div className={styles.emptyStateIcon}>📋</div>
              <div className={styles.emptyStateText}>
                {items.length === 0 ? 'No pending submissions — all clear!' : 'Select a submission from the sidebar'}
              </div>
            </div>
          )}

          {!loading && !error && selectedItem && (
            <>
              <div className={styles.caseHeader}>
                <div className={styles.caseTitleGroup}>
                  <h1 className={styles.caseTitle}>Case {selectedItem.feedback.caseNumber || '?'}</h1>
                  {selectedItem.feedback.contactRegardingOutcome && (
                    <span className={styles.contactTag}>✉ Reply requested</span>
                  )}
                  {!selectedItem.caseData && (
                    <span className={styles.warnTag}>⚠ Case not found in base</span>
                  )}
                </div>
                <button
                  className={styles.analyseBtn}
                  onClick={() => analyse(selectedItem)}
                  disabled={selectedState?.status === 'loading'}
                >
                  {selectedState?.status === 'loading' ? (
                    <><span className={styles.btnSpinner} /> Analysing…</>
                  ) : selectedState?.status === 'done' ? '↺ Re-analyse' : '⚡ Analyse with GPT'}
                </button>
              </div>

              <div className={styles.issueBox}>
                <p className={styles.issueLabel}>Submitted feedback</p>
                <p className={styles.issueText}>{selectedItem.feedback.issueSummary}</p>
              </div>

              {selectedState?.status === 'error' && (
                <div className={styles.inlineError}>
                  Analysis failed: {selectedState.message}
                </div>
              )}

              {selectedState?.status === 'done' && (() => {
                const analysis = selectedState.data
                return (
                  <>
                    {(() => {
                      const vc = verdictConfig[analysis.verdict]
                      return (
                        <div className={styles.verdictBanner} style={{ background: vc.bg, borderColor: vc.border }}>
                          <span className={styles.verdictDot} style={{ background: vc.color }} />
                          <strong style={{ color: vc.color }}>{vc.label}</strong>
                          <span className={styles.verdictReason}>{analysis.verdictReason}</span>
                        </div>
                      )
                    })()}

                    <div className={styles.section}>
                      <span className={styles.sectionTitle}>Summary</span>
                      <p className={styles.summaryText}>{analysis.summary}</p>
                    </div>

                    {analysis.sources?.length > 0 && (
                      <div className={styles.section}>
                        <span className={styles.sectionTitle}>Sources consulted</span>
                        <ul className={styles.sourceList}>
                          {analysis.sources.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </div>
                    )}

                    <div className={styles.section}>
                      <span className={styles.sectionTitle}>
                        {analysis.fieldChanges?.length > 0
                          ? `Suggested field changes (${analysis.fieldChanges.length})`
                          : 'Field changes'}
                      </span>
                      {analysis.fieldChanges?.length > 0 ? (
                        <div className={styles.fieldChanges}>
                          {analysis.fieldChanges.map((fc, i) => {
                            const cc = confidenceConfig[fc.confidence] ?? confidenceConfig.medium
                            return (
                              <div key={i} className={styles.fieldCard}>
                                <div className={styles.fieldCardHeader}>
                                  <span className={styles.fieldName}>{fc.fieldName}</span>
                                  <span className={styles.confidencePill} style={{ color: cc.color, background: cc.bg }}>
                                    {cc.label}
                                  </span>
                                </div>
                                <p className={styles.fieldIssue}>{fc.issue}</p>
                                <div className={styles.diffRow}>
                                  <div className={`${styles.diffBox} ${styles.diffBefore}`}>
                                    <span className={styles.diffLabel}>Current</span>
                                    <p>{fc.currentText}</p>
                                  </div>
                                  <div className={styles.diffArrow}>→</div>
                                  <div className={`${styles.diffBox} ${styles.diffAfter}`}>
                                    <span className={styles.diffLabel}>Suggested</span>
                                    <p>{fc.suggestedText}</p>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <p className={styles.noChanges}>No specific field changes recommended.</p>
                      )}
                    </div>

                    {selectedItem.feedback.contactRegardingOutcome && (
                      <div className={styles.section}>
                        <div className={styles.emailHeader}>
                          <span className={styles.sectionTitle}>Draft email response</span>
                          <button
                            className={styles.copyBtn}
                            onClick={() => copyEmail(selectedItem.feedback.id, analysis.emailResponse)}
                          >
                            {copied[selectedItem.feedback.id] ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                        {selectedItem.feedback.contactEmail && (
                          <p className={styles.emailTo}>To: {selectedItem.feedback.contactEmail}</p>
                        )}
                        <pre className={styles.emailText}>{analysis.emailResponse}</pre>
                      </div>
                    )}
                  </>
                )
              })()}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
