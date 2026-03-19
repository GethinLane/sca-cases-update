import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'SCA Revision Bot — Case Correction Review',
  description: 'MRCGP SCA case correction review dashboard by SCARevision.co.uk',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
