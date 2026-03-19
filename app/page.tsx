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

type AnalysisState = { status: 'idle' } | { status: 'loading' } | { status: 'done'; data: Analysis } | { status: 'error'; message: string }

export default function Dashboard() {
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [analyses, setAnalyses] = useState<Record<string, AnalysisState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch('/api/fetch-feedback')
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setItems(d.items)
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
      setExpanded(e => ({ ...e, [key]: true }))
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
    valid: { label: 'Valid correction', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
    invalid: { label: 'Not valid', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    partial: { label: 'Partially valid', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    uncertain: { label: 'Uncertain', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  }

  const confidenceConfig = {
    high: { label: 'High confidence', color: '#15803d', bg: '#dcfce7' },
    medium: { label: 'Medium confidence', color: '#b45309', bg: '#fef3c7' },
    low: { label: 'Low confidence', color: '#b91c1c', bg: '#fee2e2' },
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.logo}>
            <span className={styles.logoMark}>✦</span>
            <span className={styles.logoText}>ClawdBot</span>
          </div>
          <p className={styles.headerSub}>MRCGP SCA Case Correction Review</p>
        </div>
      </header>

      <main className={styles.main}>
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
            <p className={styles.hint}>Check your environment variables: AIRTABLE_TOKEN, AIRTABLE_FEEDBACK_BASE_ID, AIRTABLE_CASES_BASE_ID</p>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className={styles.stateBox}>
            <p className={styles.emptyIcon}>✓</p>
            <p>No pending feedback — all clear!</p>
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <>
            <div className={styles.queueBar}>
              <span className={styles.queueCount}>{items.length}</span>
              <span className={styles.queueLabel}>pending {items.length === 1 ? 'submission' : 'submissions'}</span>
            </div>

            <div className={styles.cards}>
              {items.map(item => {
                const key = item.feedback.id
                const state = analyses[key] ?? { status: 'idle' }
                const isOpen = expanded[key]

                return (
                  <div key={key} className={styles.card}>
                    {/* Card header */}
                    <div className={styles.cardTop}>
                      <div className={styles.cardMeta}>
                        <span className={styles.caseTag}>Case {item.feedback.caseNumber || '?'}</span>
                        {item.feedback.contactRegardingOutcome && (
                          <span className={styles.contactTag}>
                            ✉ Reply requested
                          </span>
                        )}
                        {!item.caseData && (
                          <span className={styles.warnTag}>⚠ Case not found in base</span>
                        )}
                      </div>
                      <button
                        className={styles.analyseBtn}
                        onClick={() => analyse(item)}
                        disabled={state.status === 'loading'}
                      >
                        {state.status === 'loading' ? (
                          <><span className={styles.btnSpinner} /> Analysing…</>
                        ) : state.status === 'done' ? '↺ Re-analyse' : '⚡ Analyse'}
                      </button>
                    </div>

                    {/* Issue text */}
                    <div className={styles.issueBox}>
                      <p className={styles.issueLabel}>Submitted feedback</p>
                      <p className={styles.issueText}>{item.feedback.issueSummary}</p>
                    </div>

                    {/* Error state */}
                    {state.status === 'error' && (
                      <div className={styles.inlineError}>
                        Analysis failed: {state.message}
                      </div>
                    )}

                    {/* Results */}
                    {state.status === 'done' && (
                      <div className={styles.results}>
                        {/* Verdict banner */}
                        {(() => {
                          const vc = verdictConfig[state.data.verdict]
                          return (
                            <div className={styles.verdictBanner} style={{ background: vc.bg, borderColor: vc.border }}>
                              <span className={styles.verdictDot} style={{ background: vc.color }} />
                              <strong style={{ color: vc.color }}>{vc.label}</strong>
                              <span className={styles.verdictReason}>{state.data.verdictReason}</span>
                            </div>
                          )
                        })()}

                        {/* Summary */}
                        <div className={styles.section}>
                          <h3 className={styles.sectionTitle}>Summary</h3>
                          <p className={styles.summaryText}>{state.data.summary}</p>
                        </div>

                        {/* Sources */}
                        {state.data.sources?.length > 0 && (
                          <div className={styles.section}>
                            <h3 className={styles.sectionTitle}>Sources consulted</h3>
                            <ul className={styles.sourceList}>
                              {state.data.sources.map((s, i) => (
                                <li key={i}>{s}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Field changes */}
                        {state.data.fieldChanges?.length > 0 ? (
                          <div className={styles.section}>
                            <h3 className={styles.sectionTitle}>
                              Suggested field changes ({state.data.fieldChanges.length})
                            </h3>
                            <div className={styles.fieldChanges}>
                              {state.data.fieldChanges.map((fc, i) => {
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
                                      <div className={styles.diffBox + ' ' + styles.diffBefore}>
                                        <span className={styles.diffLabel}>Current</span>
                                        <p>{fc.currentText}</p>
                                      </div>
                                      <div className={styles.diffArrow}>→</div>
                                      <div className={styles.diffBox + ' ' + styles.diffAfter}>
                                        <span className={styles.diffLabel}>Suggested</span>
                                        <p>{fc.suggestedText}</p>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className={styles.section}>
                            <p className={styles.noChanges}>No specific field changes recommended.</p>
                          </div>
                        )}

                        {/* Email response */}
                        {item.feedback.contactRegardingOutcome && (
                          <div className={styles.section}>
                            <div className={styles.emailHeader}>
                              <h3 className={styles.sectionTitle}>Draft email response</h3>
                              <button
                                className={styles.copyBtn}
                                onClick={() => copyEmail(key, state.data.emailResponse)}
                              >
                                {copied[key] ? '✓ Copied' : 'Copy'}
                              </button>
                            </div>
                            {item.feedback.contactEmail && (
                              <p className={styles.emailTo}>To: {item.feedback.contactEmail}</p>
                            )}
                            <pre className={styles.emailText}>{state.data.emailResponse}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
