// `pnpm seed:demo --scenario <nombre> [--db <url>] [--now <ISO>] [--seed <n>]` (o
// `pnpm demo` desde la raíz): reemplaza los datos de una base de desarrollo por un
// escenario coherente para ver el dashboard. Nunca escribe en `sereno` ni en Neon.
import { createDbFromUrl } from '@sereno/db'
import { migrate } from '@sereno/db/migrate'
import { parseAllowedEmails } from '../lib/allowlist'
import type { DemoSession } from './demo/dataset'
import { buildDataset, DEFAULT_SEED, isScenario, SCENARIOS } from './demo/scenario'
import { sessionSummary } from './demo/summary'
import { writeDataset } from './demo/write'
import { parseArgs } from './lib/args'
import { assertDevDatabase, redactUrl } from './lib/db-url'
import { envValue, readEnvFile } from './lib/env-file'
import { ENV_LOCAL_PATH } from './lib/paths'

// Autor de los cambios de ajustes cuando no hay ALLOWED_EMAILS.
const FALLBACK_OWNER = 'demo@localhost'

function parseNow(value: string | undefined): number {
  if (value === undefined) return Date.now()
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`--now no es una fecha válida: ${value}`)
  return ms
}

function parseSeed(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SEED
  const seed = Number(value)
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`--seed tiene que ser un entero ≥ 0 (recibido ${value})`)
  return seed
}

const usd = (x: number): string => `US$ ${x.toFixed(2)}`

function describe(session: DemoSession, seed: number, now: number): string[] {
  const { row } = session
  const lines = [`· ${row.name} (${row.kind}, ${row.status})${row.mensaje ? `: ${row.mensaje}` : ''}`]
  const summary = sessionSummary(session, seed, now)
  if (!session.books || !summary) return lines
  for (const kind of ['real', 'shadow'] as const) {
    const book = session.books[kind]
    const open = book.positions.filter((p) => p.closed === null).length
    const { stats, verdict } = summary[kind]
    const pf = Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'
    lines.push(
      `  ${kind === 'real' ? 'real ' : 'sombra'}: saldo ${usd(book.final.saldo)}, equity ${usd(book.final.equity)}, ` +
        `${stats.trades} cerradas (${stats.wins} ganadas), ${open} abiertas, expectativa ${stats.expectancyR.toFixed(2)}R, factor ${pf}`,
      `          ${verdict.reason}`,
    )
  }
  return lines
}

async function main(): Promise<void> {
  const { options } = parseArgs(process.argv.slice(2), ['scenario', 'db', 'now', 'seed'])
  const scenario = options.scenario ?? 'active'
  if (!isScenario(scenario)) throw new Error(`Escenario desconocido: ${scenario} (válidos: ${SCENARIOS.join(', ')})`)
  const file = readEnvFile(ENV_LOCAL_PATH)
  const url = options.db ?? envValue('DATABASE_URL', file)
  if (url === undefined) throw new Error('Falta la base: pasá --db <url> o definí DATABASE_URL en apps/web/.env.local.')
  assertDevDatabase(url)
  const allowed = envValue('ALLOWED_EMAILS', file)
  const [firstAllowed] = allowed === undefined ? [] : parseAllowedEmails(allowed)
  const ownerEmail = firstAllowed ?? FALLBACK_OWNER
  const now = parseNow(options.now)
  const seed = parseSeed(options.seed)

  const dataset = buildDataset(scenario, { seed, now, ownerEmail })
  await migrate(url)
  const db = createDbFromUrl(url, { max: 1 })
  try {
    const written = await writeDataset(db, dataset)
    console.log(`Escenario "${scenario}" en ${redactUrl(url)} (semilla ${seed}, ahora ${new Date(now).toISOString()}).`)
    console.log(`${written.sessions} sesiones, ${written.positions} posiciones, ${written.decisions} decisiones, ${written.equityPoints} puntos de equity, ${written.candles} velas.`)
    for (const session of dataset.sessions) for (const line of describe(session, seed, now)) console.log(line)
  } finally {
    await db.$client.end()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
