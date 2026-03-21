export function middleware(req: NextRequest) {
  const cookie = req.cookies.get(PROTECTED_COOKIE)?.value
  const { pathname } = req.nextUrl

  // Allow login page and auth API through
  if (pathname === '/login' || pathname === '/api/auth') {
    return NextResponse.next()
  }

  if (cookie === process.env.SITE_PASSWORD) return NextResponse.next()

  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/login'
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
