// `pnpm seed:user` (o `pnpm db:seed-user` desde la raíz): crea o actualiza el único
// usuario del dashboard con la contraseña de `DASHBOARD_PASSWORD`. Nunca la imprime.
import { createDbFromUrl } from '@sereno/db'
import { parseAllowedEmails } from '../lib/allowlist'
import { assertNotProduction, redactUrl } from './lib/db-url'
import { envValue, readEnvFile, writeEnvValue } from './lib/env-file'
import { ENV_LOCAL_PATH } from './lib/paths'
import { generatePassword } from './user/password'
import { seedUser } from './user/seed-user'

const ENV_LABEL = 'apps/web/.env.local'

function required(key: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`Falta ${key} en ${ENV_LABEL} o en el entorno.`)
  return value
}

async function main(): Promise<void> {
  const file = readEnvFile(ENV_LOCAL_PATH)
  const url = required('DATABASE_URL', envValue('DATABASE_URL', file))
  assertNotProduction(url)
  const allowedEmails = required('ALLOWED_EMAILS', envValue('ALLOWED_EMAILS', file))
  const [email] = parseAllowedEmails(allowedEmails)
  if (email === undefined) throw new Error(`ALLOWED_EMAILS no tiene ningún email en ${ENV_LABEL}.`)
  const secret = required('BETTER_AUTH_SECRET', envValue('BETTER_AUTH_SECRET', file))
  const baseURL = required('BETTER_AUTH_URL', envValue('BETTER_AUTH_URL', file))

  let password = envValue('DASHBOARD_PASSWORD', file)
  const generated = password === undefined
  if (password === undefined) {
    // Se guarda antes de tocar la base: nunca queda un usuario con una contraseña perdida.
    password = generatePassword()
    writeEnvValue(ENV_LOCAL_PATH, 'DASHBOARD_PASSWORD', password)
  }

  const db = createDbFromUrl(url, { max: 1 })
  try {
    const { created } = await seedUser({ db, email, password, secret, baseURL, allowedEmails })
    console.log(`${created ? 'Creé' : 'Actualicé'} el usuario ${email} en ${redactUrl(url)} (email verificado).`)
    console.log(
      generated
        ? `La contraseña quedó en ${ENV_LABEL} como DASHBOARD_PASSWORD.`
        : `La contraseña es la de DASHBOARD_PASSWORD en ${ENV_LABEL}.`,
    )
  } finally {
    await db.$client.end()
  }
}

main().catch((err: unknown) => {
  const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code
  if (code === '42P01') console.error('Faltan las tablas de la base: corré las migraciones antes (pnpm db:migrate).')
  else console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
