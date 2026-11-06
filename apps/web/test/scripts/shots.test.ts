// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultOutDir, DEVICES, FRAMES, localDay, normalizeRoute, routeSlug, shotFileName, VARIANTS } from '../../scripts/shots/variants'

describe('variantes de captura', () => {
  it('escritorio y celular en claro y oscuro, más una sin movimiento', () => {
    const keys = VARIANTS.map((v) => `${v.device}/${v.scheme}/${v.reducedMotion}`)
    expect(keys).toEqual(['escritorio/claro/false', 'escritorio/oscuro/false', 'celular/claro/false', 'celular/oscuro/false', 'celular/claro/true'])
  })

  it('de cada variante, la primera pantalla como se ve y la página completa sin la barra inferior fija', () => {
    const [screenFrame, fullFrame] = FRAMES
    expect(FRAMES).toHaveLength(2)
    expect(screenFrame).toEqual({ name: 'pantalla', fullPage: false, css: null })
    expect(fullFrame?.name).toBe('completa-sin-barras')
    expect(fullFrame?.fullPage).toBe(true)
    // Sólo la barra (los diálogos abiertos también son fijos y se tienen que ver) y el lugar que le reserva el contenido.
    expect(fullFrame?.css).toBe('[data-bottom-bar] { display: none !important; } :root { --shell-bottom: 0px !important; }')
  })

  it('usa los tamaños pedidos', () => {
    expect(DEVICES.escritorio.viewport).toEqual({ width: 1440, height: 900 })
    expect(DEVICES.celular).toEqual({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  })
})

describe('nombres de archivo', () => {
  it('convierte la ruta en un nombre de carpeta', () => {
    expect(routeSlug('/')).toBe('inicio')
    expect(routeSlug('/acceso')).toBe('acceso')
    expect(routeSlug('/dev/kit')).toBe('dev-kit')
    expect(routeSlug('/historial?símbolo=SOL')).toBe('historial-simbolo-sol')
    expect(normalizeRoute('acceso')).toBe('/acceso')
  })

  it('arma el nombre con la etiqueta del escenario y la variante', () => {
    const [desktop, , , , reduced] = VARIANTS
    const [screenFrame, fullFrame] = FRAMES
    if (!desktop || !reduced || !screenFrame || !fullFrame) throw new Error('faltan variantes')
    expect(shotFileName(desktop, screenFrame)).toBe('escritorio-claro-pantalla.png')
    expect(shotFileName(desktop, fullFrame)).toBe('escritorio-claro-completa-sin-barras.png')
    expect(shotFileName(reduced, fullFrame, 'Blindada')).toBe('blindada-celular-claro-sin-movimiento-completa-sin-barras.png')
  })

  it('guarda por defecto en .local/shots/<fecha>/<ruta> de la raíz del repo', () => {
    const date = new Date(2026, 9, 31, 23, 50)
    expect(localDay(date)).toBe('2026-10-31')
    expect(defaultOutDir('/repo', '/dev/kit', date)).toBe('/repo/.local/shots/2026-10-31/dev-kit')
  })
})
