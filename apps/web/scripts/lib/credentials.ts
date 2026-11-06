import { parseAllowedEmails } from '../../lib/allowlist'
import { envValue, readEnvFile } from './env-file'
import { ENV_LOCAL_PATH } from './paths'

export interface Credentials {
  email: string
  password: string
}

// El usuario que crea `seed:user`: el primer email de ALLOWED_EMAILS y DASHBOARD_PASSWORD,
// del entorno o de apps/web/.env.local. Las capturas y la prueba de humo entran con él.
export function dashboardCredentials(): Credentials {
  const file = readEnvFile(ENV_LOCAL_PATH)
  const allowed = envValue('ALLOWED_EMAILS', file)
  const [email] = allowed === undefined ? [] : parseAllowedEmails(allowed)
  const password = envValue('DASHBOARD_PASSWORD', file)
  if (email === undefined || password === undefined) {
    throw new Error('Faltan ALLOWED_EMAILS o DASHBOARD_PASSWORD en apps/web/.env.local: corré pnpm seed:user.')
  }
  return { email, password }
}
