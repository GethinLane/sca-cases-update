// app/(audit)/audit/layout.tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Guideline Audit — SCA Revision Bot',
  description: 'Weekly guideline audit dashboard for MRCGP SCA cases',
}

export default function AuditLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
