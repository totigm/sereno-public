import { join } from 'node:path'

// Las capturas de una ruta: escritorio y celular, cada una en claro y oscuro, más una
// con movimiento reducido para ver la versión sin animaciones. De cada variante, la
// primera pantalla tal como se ve y la página completa.

export type Device = 'escritorio' | 'celular'
export type Scheme = 'claro' | 'oscuro'

export interface ShotVariant {
  device: Device
  scheme: Scheme
  reducedMotion: boolean
}

export interface DeviceOptions {
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
}

export const DEVICES: Record<Device, DeviceOptions> = {
  escritorio: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  celular: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}

export const VARIANTS: readonly ShotVariant[] = [
  { device: 'escritorio', scheme: 'claro', reducedMotion: false },
  { device: 'escritorio', scheme: 'oscuro', reducedMotion: false },
  { device: 'celular', scheme: 'claro', reducedMotion: false },
  { device: 'celular', scheme: 'oscuro', reducedMotion: false },
  { device: 'celular', scheme: 'claro', reducedMotion: true },
]

export interface ShotFrame {
  /** Lo que se agrega al nombre del archivo. */
  name: string
  fullPage: boolean
  /** CSS que se agrega sólo para esta captura, después de la anterior. */
  css: string | null
}

// En la página completa, la barra inferior fija quedaría pintada a la altura de la
// primera pantalla (844 px en celular), encima del contenido: se oculta, con el lugar
// que el contenido le reserva, y el nombre del archivo lo dice.
const HIDE_FIXED_BARS_CSS = '[data-bottom-bar] { display: none !important; } :root { --shell-bottom: 0px !important; }'

export const FRAMES: readonly ShotFrame[] = [
  { name: 'pantalla', fullPage: false, css: null },
  { name: 'completa-sin-barras', fullPage: true, css: HIDE_FIXED_BARS_CSS },
]

// "/" → "inicio", "/dev/kit" → "dev-kit", "/historial?simbolo=SOL" → "historial-simbolo-sol".
export function routeSlug(route: string): string {
  const slug = route
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'inicio' : slug
}

export function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : `/${route}`
}

// Fecha local "2026-10-31": la carpeta del día en que se sacaron.
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function defaultOutDir(repoDir: string, route: string, date: Date): string {
  return join(repoDir, '.local', 'shots', localDay(date), routeSlug(route))
}

export function shotFileName(variant: ShotVariant, frame: ShotFrame, label?: string): string {
  const parts = [label ? routeSlug(label) : null, variant.device, variant.scheme, variant.reducedMotion ? 'sin-movimiento' : null, frame.name]
  return `${parts.filter((p) => p !== null).join('-')}.png`
}
