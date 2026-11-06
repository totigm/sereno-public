import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { migrate } from '@sereno/db/migrate'

// `pnpm db:migrate` corre con cwd en packages/db; el `.env` vive en la raíz del repo.
// Las variables ya presentes en el entorno ganan sobre el archivo.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true })

const url = process.env.DATABASE_URL_UNPOOLED
if (!url) {
  console.error('Falta DATABASE_URL_UNPOOLED: las migraciones usan la conexión directa, nunca el pooler.')
  process.exit(1)
}

function sinSecreto(raw: string): string {
  const u = new URL(raw)
  u.password = ''
  return u.toString()
}

// Antes de migrar: una URL que no se puede mostrar no tiene que fallar después de
// aplicar las migraciones y tapar que salieron bien.
let destino: string
try {
  destino = sinSecreto(url)
} catch {
  console.error('DATABASE_URL_UNPOOLED no es una URL válida (postgresql://usuario:clave@host:puerto/base).')
  process.exit(1)
}

await migrate(url)
console.log(`Migraciones aplicadas en ${destino}`)
