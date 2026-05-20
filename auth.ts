import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'

const allowedEmails = (process.env.ALLOWED_EMAILS ?? '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean)

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: '/login', error: '/login' },
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.toLowerCase()
      if (!email) return false
      if (allowedEmails.length === 0) return false
      return allowedEmails.includes(email)
    },
    async jwt({ token, user }) {
      if (user?.email) token.email = user.email
      return token
    },
    async session({ session, token }) {
      if (token.email && session.user) session.user.email = token.email as string
      return session
    },
  },
})
