import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

// El `.env` vive en la raíz del repo; lo que ya está en el entorno gana.
export function loadRootEnv(): void {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
  if (!existsSync(path)) return
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (typeof value === 'string') process.env[key] ??= value
  }
}
