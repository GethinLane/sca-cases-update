import { NextResponse } from 'next/server'
import { auth } from '@/auth'

export default auth((req) => {
  const { pathname } = req.nextUrl

  if (pathname === '/login' || pathname.startsWith('/api/auth')) {
    return NextResponse.next()
  }

  if (req.auth?.user?.email) {
    return NextResponse.next()
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Unauthorized — please sign in.' },
      { status: 401 },
    )
  }

  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/login'
  loginUrl.searchParams.set('callbackUrl', pathname)
  return NextResponse.redirect(loginUrl)
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
