import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, TestInfo } from 'playwright/test'
import { dashboardCredentials } from '../scripts/lib/credentials'
import { REPO_DIR } from '../scripts/lib/paths'
import { settle } from '../scripts/shots/settle'

// Las capturas de la prueba de humo. Cada pantalla, en claro y en oscuro, va a
// `.local/shots/e2e/<proyecto>/` (ignorado). Con `E2E_REVIEW=1`, los proyectos con
// movimiento además dejan el juego que se commitea en `docs/superpowers/review/`.

export type Scheme = 'claro' | 'oscuro'
export const SCHEMES: readonly Scheme[] = ['claro', 'oscuro']

const ITERATION_DIR = join(REPO_DIR, '.local', 'shots', 'e2e')
const REVIEW_DIR = join(REPO_DIR, 'docs', 'superpowers', 'review')

// En la página completa, la barra inferior fija quedaría pintada a la altura de la
// primera pantalla, encima del contenido: se oculta, con el lugar que le reserva.
const HIDE_BOTTOM_BAR_CSS = '[data-bottom-bar] { display: none !important; } :root { --shell-bottom: 0px !important; }'

// El email con que se entró (Ajustes › Cuenta) es el de verdad: en las capturas va tapado
// con el color apagado de la paleta.
const MASK_COLOR = '#8A93A3'

export interface CaptureOptions {
  /** La página entera (pantallas) o sólo lo que se ve (hojas). */
  fullPage: boolean
}

export function deviceOf(info: TestInfo): 'celular' | 'escritorio' {
  return info.project.name.startsWith('celular') ? 'celular' : 'escritorio'
}

function reviewWanted(info: TestInfo): boolean {
  return process.env.E2E_REVIEW === '1' && info.project.use.reducedMotion !== 'reduce'
}

/** Pasa la página a un esquema (recargando, como quien la abre así) y espera que se aquiete. */
export async function showScheme(page: Page, scheme: Scheme): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme === 'claro' ? 'light' : 'dark' })
  // Recargar con la respuesta anterior todavía en camino la corta, y `next dev` lo anota
  // como "The destination stream errored while writing data.".
  await page.waitForLoadState('networkidle')
  await page.reload()
  await settle(page)
}

export async function capture(page: Page, info: TestInfo, name: string, scheme: Scheme, { fullPage }: CaptureOptions): Promise<void> {
  await settle(page)
  const style = fullPage ? await page.addStyleTag({ content: HIDE_BOTTOM_BAR_CSS }) : null
  const dirs = [join(ITERATION_DIR, info.project.name)]
  if (reviewWanted(info)) dirs.push(REVIEW_DIR)
  const file = `${name}-${deviceOf(info)}-${scheme}.png`
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
    await page.screenshot({
      path: join(dir, file),
      fullPage,
      animations: 'disabled',
      mask: [page.getByText(dashboardCredentials().email, { exact: true })],
      maskColor: MASK_COLOR,
    })
  }
  // La prueba sigue navegando con la barra.
  await style?.evaluate((node) => node.parentNode?.removeChild(node))
}
