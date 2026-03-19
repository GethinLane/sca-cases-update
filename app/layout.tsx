import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ClawdBot — SCA Case Review',
  description: 'MRCGP SCA case correction review dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
