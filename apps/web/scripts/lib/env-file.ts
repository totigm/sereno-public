import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export type EnvValues = Readonly<Record<string, string>>

// Lee un `.env` con el mismo formato que Next.js; si no existe, queda vacío.
export function readEnvFile(path: string): EnvValues {
  if (!existsSync(path)) return {}
  const parsed = parseEnv(readFileSync(path, 'utf8'))
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

// Agrega o reemplaza una variable sin tocar el resto del archivo (comentarios y orden incluidos).
export function upsertEnvValue(content: string, key: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Nombre de variable inválido: ${key}`)
  if (/[\s#"'`\\$]/.test(value)) throw new Error(`El valor de ${key} tiene caracteres que habría que citar`)
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  if (pattern.test(content)) return content.replace(pattern, () => line)
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n'
  return `${content}${separator}${line}\n`
}

export function writeEnvValue(path: string, key: string, value: string): void {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, upsertEnvValue(current, key, value), { mode: 0o600 })
}

// El entorno del proceso gana sobre el archivo, como en Next.js. Vacío cuenta como ausente.
export function envValue(key: string, file: EnvValues): string | undefined {
  const fromEnv = process.env[key]
  const value = fromEnv === undefined || fromEnv === '' ? file[key] : fromEnv
  return value === undefined || value === '' ? undefined : value
}
