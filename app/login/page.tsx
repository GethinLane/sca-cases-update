import { signIn, auth } from '@/auth'
import { redirect } from 'next/navigation'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>
}) {
  const params = await searchParams
  const rawCallback = params.callbackUrl ?? '/'
  const callbackUrl = rawCallback.startsWith('/') && !rawCallback.startsWith('/login') ? rawCallback : '/'
  const session = await auth()
  if (session?.user?.email) {
    redirect(callbackUrl)
  }

  const error = params.error
  const errorMessage =
    error === 'AccessDenied'
      ? 'That Google account is not on the access list. Contact the site owner if you think this is a mistake.'
      : error
        ? 'Sign-in failed. Please try again.'
        : null

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#1e2d54', fontFamily: 'sans-serif',
      padding: 24,
    }}>
      <div style={{
        background: 'white', borderRadius: 12, padding: '40px 48px',
        display: 'flex', flexDirection: 'column', gap: 16, minWidth: 320, maxWidth: 420,
      }}>
        <h1 style={{ margin: 0, fontSize: 20, color: '#1e2d54' }}>⚕ SCA Revision Bot</h1>
        <p style={{ margin: 0, fontSize: 14, color: '#6b7a99' }}>
          Sign in with your authorised Google account to continue.
        </p>

        {errorMessage && (
          <p style={{
            margin: 0, fontSize: 13, color: '#dc2626',
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 6, padding: '8px 12px',
          }}>
            {errorMessage}
          </p>
        )}

        <form
          action={async () => {
            'use server'
            await signIn('google', { redirectTo: callbackUrl })
          }}
        >
          <button
            type="submit"
            style={{
              width: '100%', background: 'white', color: '#1f2937',
              border: '1px solid #d1d5db', borderRadius: 8,
              padding: '10px 16px', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: 10,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
              <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
              <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
            </svg>
            Sign in with Google
          </button>
        </form>

        <p style={{ margin: 0, fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
          Only authorised accounts can sign in. Two-factor authentication is
          handled by your Google account.
        </p>
      </div>
    </div>
  )
}
