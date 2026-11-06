// `pnpm shots <ruta> [--port 3000] [--out <carpeta>] [--scenario-label <x>]`: capturas
// de una ruta del dashboard en escritorio y celular, claro y oscuro, más una con
// movimiento reducido; de cada una, la primera pantalla y la página completa. Entra con el usuario de `seed:user` y usa el Chromium que
// Playwright ya tiene en caché (no descarga nada).
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContextOptions } from 'playwright'
import { parseArgs } from './lib/args'
import { dashboardCredentials } from './lib/credentials'
import { REPO_DIR } from './lib/paths'
import { DEV_OVERLAY_CSS } from './shots/dev-overlay'
import { settle } from './shots/settle'
import { defaultOutDir, DEVICES, FRAMES, normalizeRoute, shotFileName, VARIANTS, type ShotVariant } from './shots/variants'

const ACCESS_PATH = '/acceso'
const LOGIN_TIMEOUT_MS = 20_000

type StorageState = Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['storageState']>>

async function assertServer(base: string): Promise<void> {
  try {
    await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error(`No hay un servidor en ${base}: levantá el dashboard (pnpm --filter @sereno/web dev --port ${new URL(base).port}).`)
  }
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("Executable doesn't exist")) {
      throw new Error('No encuentro el Chromium de Playwright en ~/Library/Caches/ms-playwright; esta herramienta no descarga navegadores.')
    }
    throw err
  }
}

async function login(browser: Browser, base: string): Promise<StorageState> {
  const { email, password } = dashboardCredentials()
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`${base}${ACCESS_PATH}`, { waitUntil: 'networkidle' })
    await page.locator('input[name="email"]').fill(email)
    await page.locator('input[name="password"]').fill(password)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => url.pathname !== ACCESS_PATH, { timeout: LOGIN_TIMEOUT_MS }).catch(() => {
      throw new Error('No pude entrar con DASHBOARD_PASSWORD: corré pnpm seed:user contra la misma base que usa el servidor.')
    })
    return await context.storageState()
  } finally {
    await context.close()
  }
}

function contextOptions(variant: ShotVariant, storageState: StorageState | undefined): BrowserContextOptions {
  return {
    ...DEVICES[variant.device],
    colorScheme: variant.scheme === 'claro' ? 'light' : 'dark',
    reducedMotion: variant.reducedMotion ? 'reduce' : 'no-preference',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    ...(storageState ? { storageState } : {}),
  }
}

async function main(): Promise<void> {
  const { positional, options } = parseArgs(process.argv.slice(2), ['port', 'out', 'scenario-label'])
  const [rawRoute] = positional
  if (rawRoute === undefined || positional.length > 1) throw new Error('Uso: pnpm shots <ruta> [--port 3000] [--out <carpeta>] [--scenario-label <x>]')
  const route = normalizeRoute(rawRoute)
  const port = options.port ?? '3000'
  if (!/^\d+$/.test(port)) throw new Error(`--port tiene que ser un número (recibido ${port})`)
  const base = `http://localhost:${port}`
  const outDir = options.out ? resolve(options.out) : defaultOutDir(REPO_DIR, route, new Date())
  const label = options['scenario-label']

  await assertServer(base)
  const browser = await launch()
  try {
    // La pantalla de acceso se captura sin sesión: con sesión redirige.
    const storageState = route.split('?')[0] === ACCESS_PATH ? undefined : await login(browser, base)
    mkdirSync(outDir, { recursive: true })
    for (const variant of VARIANTS) {
      const context = await browser.newContext(contextOptions(variant, storageState))
      try {
        const page = await context.newPage()
        await page.goto(`${base}${route}`, { waitUntil: 'networkidle' })
        await settle(page)
        // El indicador de Next.js en desarrollo no es parte de la pantalla.
        await page.addStyleTag({ content: DEV_OVERLAY_CSS })
        for (const frame of FRAMES) {
          if (frame.css) await page.addStyleTag({ content: frame.css })
          const path = join(outDir, shotFileName(variant, frame, label))
          await page.screenshot({ path, fullPage: frame.fullPage })
          console.log(path)
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
