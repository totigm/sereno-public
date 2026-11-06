import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Los mismos comandos que se usan a mano (`pnpm seed:demo`, `pnpm seed:user`), contra la
// base de la prueba.

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url))

function run(databaseUrl: string, args: string[]): void {
  execFileSync('pnpm', args, { cwd: WEB_DIR, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'ignore', 'inherit'] })
}

/** El escenario `active`: 23 cerradas (14 ganadas), 3 abiertas, ganando, latido de ahora. */
export function seedActiveScenario(databaseUrl: string): void {
  run(databaseUrl, ['seed:demo', '--scenario', 'active'])
}

/** El usuario del dashboard (sobrevive a `seed:demo`). */
export function seedUser(databaseUrl: string): void {
  run(databaseUrl, ['seed:user'])
}
