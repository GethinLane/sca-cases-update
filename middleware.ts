import { NextRequest, NextResponse } from 'next/server'

const PROTECTED_COOKIE = 'site_auth'

export function middleware(req: NextRequest) {
  const cookie = req.cookies.get(PROTECTED_COOKIE)?.value
  const { pathname } = req.nextUrl

  // Allow the login page and auth API through without checking cookie
  if (pathname === '/login' || pathname === '/api/auth') {
    return NextResponse.next()
  }

  // If cookie matches password, allow through
  if (cookie === process.env.SITE_PASSWORD) {
    return NextResponse.next()
  }

  // Otherwise redirect to login
  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/login'
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
