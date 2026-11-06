import { test as base, expect, type ConsoleMessage, type Page } from 'playwright/test'
import type { DirectDb } from '@sereno/db'
import { dashboardCredentials } from '../scripts/lib/credentials'
import { DEV_OVERLAY_CSS } from '../scripts/shots/dev-overlay'
import { activeSessionId, beat, closeDb, firstOpenTrade, openDb, type OpenTrade } from './db'
import { e2eEnv } from './env'
import { seedActiveScenario } from './seed'

// Cada 10 s, como el latido del bot en vivo (spec §12).
const BEAT_EVERY_MS = 10_000

// Motion avisa en desarrollo, una vez por carga, que el sistema pide movimiento
// reducido: es justo lo que prueba la mitad de los proyectos, no un problema.
const EXPECTED = [/^You have Reduced Motion enabled on your device/]

// Sin latido hace más de 60 s, el dashboard lo da por caído (spec §11.1).
const OFFLINE_FOR_MS = 5 * 60_000

export interface DevBot {
  db: DirectDb
  sessionId: string
  trade: OpenTrade
  /** El bot se cae: deja de latir y su último latido queda de hace 5 minutos. */
  disconnect: () => Promise<void>
  /** Vuelve a latir cada 10 s. */
  reconnect: () => Promise<void>
  /** El primer latido periódico que no pudo escribir en la base, si hubo. */
  beatFailure: () => unknown
}

/** Errores y avisos de la consola del navegador, más las excepciones sin atrapar. */
export interface ConsoleWatch {
  /** Lo que llegó desde la última vez, y lo vacía. */
  take: () => string[]
}

function describeMessage(message: ConsoleMessage): string | null {
  if (message.type() !== 'error' && message.type() !== 'warning') return null
  const text = message.text()
  if (EXPECTED.some((pattern) => pattern.test(text))) return null
  return `${message.type()}: ${text}`
}

// Va como hoja adoptada: no toca el DOM que React hidrata.
const HIDE_DEV_OVERLAY = `{
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(${JSON.stringify(DEV_OVERLAY_CSS)})
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}`

// Un latido que no se pudo escribir se ve después como "sin conexión" o "Pausar"
// deshabilitado: el test falla antes, con el error de la base.
function assertBeating(bot: DevBot): void {
  const failure = bot.beatFailure()
  if (failure === undefined) return
  const reason = failure instanceof Error ? failure.message : String(failure)
  throw new Error(`El latido falso no pudo escribir en la base: ${reason}`, { cause: failure })
}

export const test = base.extend<{ consoleWatch: ConsoleWatch; heartbeat: void }, { bot: DevBot }>({
  context: async ({ context }, use) => {
    await context.addInitScript(HIDE_DEV_OVERLAY)
    await use(context)
  },
  // Cada proyecto arranca con el escenario recién sembrado (lo que pausó el anterior no
  // aparece en sus capturas) y un latido vivo hasta el final.
  bot: [
    async ({}, use) => {
      const { databaseUrl } = e2eEnv()
      seedActiveScenario(databaseUrl)
      const db = openDb(databaseUrl)
      const sessionId = await activeSessionId(db)
      const trade = await firstOpenTrade(db, sessionId)
      let timer: ReturnType<typeof setInterval> | undefined
      let failure: unknown
      const beatNow = () =>
        beat(db, sessionId, new Date()).catch((error: unknown) => {
          if (failure !== undefined) return
          failure = error
          console.error('El latido falso no pudo escribir en la base:', error)
        })
      const reconnect = async () => {
        await beat(db, sessionId, new Date())
        timer = setInterval(() => void beatNow(), BEAT_EVERY_MS)
      }
      const disconnect = async () => {
        clearInterval(timer)
        await beat(db, sessionId, new Date(Date.now() - OFFLINE_FOR_MS))
      }
      await reconnect()
      try {
        await use({ db, sessionId, trade, disconnect, reconnect, beatFailure: () => failure })
      } finally {
        clearInterval(timer)
        await closeDb(db)
      }
    },
    { scope: 'worker', auto: true },
  ],
  heartbeat: [
    async ({ bot }, use) => {
      assertBeating(bot)
      await use()
      assertBeating(bot)
    },
    { auto: true },
  ],
  consoleWatch: async ({ page }, use) => {
    const seen: string[] = []
    page.on('console', (message) => {
      const line = describeMessage(message)
      if (line !== null) seen.push(`${line} (${page.url()})`)
    })
    page.on('pageerror', (error) => seen.push(`pageerror: ${error.message} (${page.url()})`))
    await use({ take: () => seen.splice(0) })
  },
})

export { expect }

/** Entra por /acceso con el usuario de `seed:user`, como una persona. */
export async function login(page: Page): Promise<void> {
  const { email, password } = dashboardCredentials()
  await page.goto('/acceso')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Contraseña').fill(password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}
