import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'
import { allowlistGuards } from './auth-guards'

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
}

export interface AuthConfig {
  database: NonNullable<BetterAuthOptions['database']>
  secret: string
  baseURL: string
  /** `ALLOWED_EMAILS` tal cual viene del entorno. */
  allowedEmails: string
  /** Sin credenciales no hay proveedor ni botón (skill `marrona-google-auth`). */
  google?: GoogleCredentials | undefined
}

// La configuración vive separada de `auth.ts` (que lee el entorno y abre la base) para
// poder probarla entera con el adaptador en memoria.
export function createAuth({ database, secret, baseURL, allowedEmails, google }: AuthConfig) {
  const guards = allowlistGuards(allowedEmails)

  return betterAuth({
    appName: 'Sereno',
    baseURL,
    secret,
    database,
    emailAndPassword: { enabled: true, disableSignUp: true },
    ...(google && {
      socialProviders: {
        // `select_account`: "Probar con otra cuenta" tiene que dejar elegir otra cuenta de Google.
        google: { clientId: google.clientId, clientSecret: google.clientSecret, prompt: 'select_account' },
      },
    }),
    // `requireLocalEmailVerified` queda en su valor por defecto (true).
    account: { accountLinking: { enabled: true, trustedProviders: ['google'] } },
    user: { validateUserInfo: guards.validateUserInfo },
    databaseHooks: {
      user: { create: { before: guards.beforeUserCreate } },
      session: { create: { before: guards.beforeSessionCreate } },
    },
    // Errores del flujo de Google que no traen su propio destino vuelven a la pantalla de acceso.
    onAPIError: { errorURL: `${baseURL}/acceso` },
    // Tiene que ir último: aplica las cookies de las llamadas desde Server Actions.
    plugins: [nextCookies()],
  })
}

export type Auth = ReturnType<typeof createAuth>
