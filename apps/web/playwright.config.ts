import { defineConfig, type Project } from 'playwright/test'
import { e2eEnv } from './e2e/env'

// `pnpm e2e`: la prueba de humo contra `pnpm dev` y la base de desarrollo de
// apps/web/.env.local, recién sembrada. Celular y escritorio, cada uno con y sin
// movimiento reducido. Las cuatro corren en serie: comparten la base y la pausa.

const { port, baseURL, databaseUrl } = e2eEnv()

const phone = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }

const projects: Project[] = [
  { name: 'celular', use: { ...phone, reducedMotion: 'no-preference' } },
  { name: 'celular-sin-movimiento', use: { ...phone, reducedMotion: 'reduce' } },
  { name: 'escritorio', use: { ...desktop, reducedMotion: 'no-preference' } },
  { name: 'escritorio-sin-movimiento', use: { ...desktop, reducedMotion: 'reduce' } },
]

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: '../../.local/e2e/resultados',
  use: {
    baseURL,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    trace: 'retain-on-failure',
  },
  projects,
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: `${baseURL}/acceso`,
    reuseExistingServer: false,
    timeout: 120_000,
    // El entorno del proceso gana sobre .env.local: el servidor usa la misma base que
    // siembra la corrida y Better Auth acepta el origen del puerto de la prueba.
    // SERENO_E2E apaga el reenvío de la consola del navegador a la terminal (next.config.ts).
    env: { DATABASE_URL: databaseUrl, BETTER_AUTH_URL: baseURL, SERENO_E2E: '1' },
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
