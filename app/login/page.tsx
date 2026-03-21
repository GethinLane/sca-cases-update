'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const router = useRouter()

  async function handleSubmit() {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      router.push('/')
      router.refresh()
    } else {
      setError(true)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#1e2d54', fontFamily: 'sans-serif'
    }}>
      <div style={{
        background: 'white', borderRadius: 12, padding: '40px 48px',
        display: 'flex', flexDirection: 'column', gap: 16, minWidth: 320
      }}>
        <h1 style={{ margin: 0, fontSize: 20, color: '#1e2d54' }}>⚕ SCA Revision Bot</h1>
        <p style={{ margin: 0, fontSize: 14, color: '#6b7a99' }}>Enter the access password to continue.</p>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => { setPassword(e.target.value); setError(false) }}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          style={{
            padding: '10px 14px', borderRadius: 8, fontSize: 14,
            border: error ? '1px solid #dc2626' : '1px solid #e2e8f0', outline: 'none'
          }}
        />
        {error && <p style={{ margin: 0, fontSize: 13, color: '#dc2626' }}>Incorrect password.</p>}
        <button
          onClick={handleSubmit}
          style={{
            background: '#3b82c4', color: 'white', border: 'none',
            borderRadius: 8, padding: '10px 0', fontSize: 14,
            fontWeight: 700, cursor: 'pointer'
          }}
        >
          Enter
        </button>
      </div>
    </div>
  )
}
