import { assertDevDatabase } from '../scripts/lib/db-url'
import { envValue, readEnvFile } from '../scripts/lib/env-file'
import { ENV_LOCAL_PATH } from '../scripts/lib/paths'

// El entorno de la prueba de humo: el mismo apps/web/.env.local que usa `pnpm dev` (el
// entorno del proceso gana). La base se vuelve a sembrar en cada corrida, así que tiene
// que ser una de desarrollo: nunca `sereno` ni Neon.

const DEFAULT_PORT = '3132'

export interface E2eEnv {
  port: string
  baseURL: string
  databaseUrl: string
}

export function e2eEnv(): E2eEnv {
  const file = readEnvFile(ENV_LOCAL_PATH)
  const port = envValue('E2E_PORT', file) ?? DEFAULT_PORT
  if (!/^\d+$/.test(port)) throw new Error(`E2E_PORT tiene que ser un número (recibido ${port}).`)
  const databaseUrl = envValue('DATABASE_URL', file)
  if (databaseUrl === undefined) throw new Error('Falta DATABASE_URL en apps/web/.env.local: la prueba de humo corre contra tu base de desarrollo.')
  assertDevDatabase(databaseUrl)
  return { port, baseURL: `http://localhost:${port}`, databaseUrl }
}
