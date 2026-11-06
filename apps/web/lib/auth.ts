import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { account, session, user, verification } from '@sereno/db'
import { createAuth, type GoogleCredentials } from './auth-config'
import { db } from './db'
import { env } from './env'

const google: GoogleCredentials | undefined =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
    : undefined

/** Si la pantalla de acceso muestra "Entrar con Google". */
export const googleEnabled = google !== undefined

export const auth = createAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema: { user, session, account, verification } }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  allowedEmails: env.ALLOWED_EMAILS,
  google,
})
