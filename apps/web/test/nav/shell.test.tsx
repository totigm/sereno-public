import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { BottomBar } from '@/components/nav/bottom-bar'
import { ContextBand } from '@/components/nav/context-band'
import { SessionChip } from '@/components/nav/session-chip'
import { TopBar } from '@/components/nav/top-bar'
import { AppShell } from '@/components/shell/app-shell'
import { resolveTitle } from 'next/dist/lib/metadata/resolvers/resolve-title'
import { generateMetadata } from '@/app/s/[sessionId]/layout'
import { metadata as rootMetadata } from '@/app/layout'
import {
  archivedSession,
  BOT,
  contextFor,
  liveSession,
  livePayload,
  NOW,
  realRow,
  realSession,
  replaySession,
  withQueryClient,
} from './fixtures'

// Las fixtures arman las sesiones con `toSessionView` (puro); de la base sólo se lee la sesión del título.
const sessionRows = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/db', () => ({ db: {}, repos: { sessions: { get: async (id: string) => sessionRows.get(id) ?? null } } }))
vi.mock('@/lib/session', () => ({ requireSession: vi.fn() }))
// La raíz trae la fuente de next/font, que sólo existe compilando con Next; acá sólo se lee su metadata.
vi.mock('@/lib/fonts', () => ({ instrumentSans: { variable: '' } }))

const navigation = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}))

const LABELS = ['Resumen', 'Posiciones', 'Monedas', 'Aprendizaje', 'Ajustes']

function bottomBar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Secciones' })
}

beforeEach(() => {
  navigation.pathname = '/'
  document.title = 'Sereno'
})

describe('barra inferior', () => {
  it('tiene exactamente los cinco destinos, en orden', () => {
    render(<BottomBar base="" />)
    const links = within(bottomBar()).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(LABELS)
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/', '/posiciones', '/monedas', '/aprendizaje', '/ajustes'])
  })

  it('marca la pestaña de la ruta actual, también en subrutas', () => {
    navigation.pathname = '/posiciones/abc'
    render(<BottomBar base="" />)
    expect(within(bottomBar()).getByRole('link', { current: 'page' })).toHaveTextContent('Posiciones')
  })

  it('en el contexto de otra sesión los destinos quedan pegados a esa sesión', () => {
    navigation.pathname = '/s/ses_replay/monedas'
    render(<BottomBar base="/s/ses_replay" />)
    const links = within(bottomBar()).getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/s/ses_replay',
      '/s/ses_replay/posiciones',
      '/s/ses_replay/monedas',
      '/s/ses_replay/aprendizaje',
      '/s/ses_replay/ajustes',
    ])
    expect(within(bottomBar()).getByRole('link', { current: 'page' })).toHaveTextContent('Monedas')
  })

  it('se recorre con el teclado en orden y Enter marca el destino sin esperar a la navegación', async () => {
    const user = userEvent.setup()
    // Sin el router de Next el enlace navegaría el documento entero; jsdom no lo implementa.
    const stopNavigation = (event: MouseEvent) => event.preventDefault()
    window.addEventListener('click', stopNavigation)
    onTestFinished(() => window.removeEventListener('click', stopNavigation))
    render(<BottomBar base="" />)
    for (const label of LABELS) {
      await user.tab()
      expect(document.activeElement).toHaveTextContent(label)
    }
    await user.tab({ shift: true })
    await user.tab({ shift: true })
    expect(document.activeElement).toHaveTextContent('Monedas')
    await user.keyboard('{Enter}')
    expect(within(bottomBar()).getByRole('link', { current: 'page' })).toHaveTextContent('Monedas')
  })

  it('es translúcida con el área segura de abajo, y sólida con línea si el sistema pide menos transparencia', () => {
    render(<BottomBar base="" />)
    const bar = bottomBar()
    expect(bar).toHaveClass('material')
    expect(bar.className).toContain('env(safe-area-inset-bottom)')

    // jsdom no evalúa CSS: se verifica el contrato de la utilidad `material` en la hoja global.
    const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8')
    const material = utilityBlock(css, 'material')
    expect(material).toMatch(/backdrop-filter:\s*blur\(/)
    const reduced = mediaBlock(material, 'prefers-reduced-transparency: reduce')
    expect(reduced).toMatch(/background-color:\s*var\(--surface\)/)
    expect(reduced).toMatch(/(?<!-webkit-)backdrop-filter:\s*none/)
    expect(reduced).toMatch(/border-top:\s*1px solid var\(--line\)/)
  })
})

describe('barra superior (desktop)', () => {
  it('lleva el nombre, el chip de la sesión y los mismos cinco destinos', () => {
    navigation.pathname = '/aprendizaje'
    render(<TopBar base="" session={liveSession()} />)
    expect(screen.getByText('Sereno')).toBeInTheDocument()
    expect(screen.getByText('Simulado')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Secciones' })
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(LABELS)
    expect(within(nav).getByRole('link', { current: 'page' })).toHaveTextContent('Aprendizaje')
  })

  it('en la sesión real, el estado dice en vivo que la apagó el tope', () => {
    navigation.pathname = '/s/ses_real'
    render(
      withQueryClient(
        <AppShell
          context={contextFor(realSession({ realStatus: 'on' }))}
          live={livePayload({ sessionId: 'ses_real', realStatus: 'loss_floor', botStatus: { ...BOT, real: { mode: 'reduce_only', missing: [] } } })}
          base="/s/ses_real"
        >
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    const status = within(screen.getByRole('banner')).getByRole('list', { name: 'Estado del bot' })
    expect(status).toHaveTextContent('Apagada por el tope de pérdida')
    // Si en 1024 px se corta, el texto entero sigue a mano.
    expect(within(status).getByTitle('Apagada por el tope de pérdida')).toBeInTheDocument()
  })

  it('también es un material, sólido con la línea abajo si el sistema pide menos transparencia', () => {
    const { container } = render(<TopBar base="" session={null} />)
    expect(container.firstElementChild).toHaveClass('material-top')
    const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8')
    const reduced = mediaBlock(utilityBlock(css, 'material-top'), 'prefers-reduced-transparency: reduce')
    expect(reduced).toMatch(/(?<!-webkit-)backdrop-filter:\s*none/)
    expect(reduced).toMatch(/border-bottom:\s*1px solid var\(--line\)/)
  })
})

describe('chip de sesión', () => {
  it('dice "Simulado" en la simulación en vivo', () => {
    render(<SessionChip session={liveSession()} />)
    expect(screen.getByText('Simulado')).toBeInTheDocument()
  })

  it('dice "Replay · 90 días" en un replay', () => {
    render(<SessionChip session={replaySession()} />)
    expect(screen.getByText('Replay · 90 días')).toBeInTheDocument()
  })
})

describe('banda de contexto', () => {
  it('en un replay dice el tramo y ofrece volver a la simulación actual', () => {
    render(<ContextBand session={replaySession()} />)
    expect(screen.getByText('Replay · 90 días · 2 ago → 31 oct')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Volver a la simulación actual' })).toHaveAttribute('href', '/')
  })

  it('en una simulación archivada dice que está archivada y su tramo', () => {
    render(<ContextBand session={archivedSession()} />)
    expect(screen.getByText('Simulación archivada · 14 oct → 20 oct')).toBeInTheDocument()
  })

  it('una sesión con plata real ya archivada no se confunde con una simulación', () => {
    const real = realSession({ status: 'archived', endedAt: new Date(Date.UTC(2026, 9, 31, 12, 0)), realStatus: 'loss_floor' })
    render(<ContextBand session={real} />)
    expect(screen.getByText('Plata real archivada · 30 oct → 31 oct')).toBeInTheDocument()
  })

  it('un replay que todavía corre muestra su avance', () => {
    render(<ContextBand session={replaySession({ status: 'simulando', mensaje: 'Simulando · día 41 de 90', progreso: 0.45 })} />)
    expect(screen.getByText('Simulando · día 41 de 90')).toBeInTheDocument()
  })
})

describe('shell', () => {
  it('en /s/[id] de un replay muestra la banda, el chip y no refresca nada en vivo', () => {
    navigation.pathname = '/s/ses_replay'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(
      withQueryClient(
        <AppShell context={contextFor(replaySession())} live={livePayload({ sessionId: 'ses_replay' })} base="/s/ses_replay">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(screen.getByText('Replay · 90 días · 2 ago → 31 oct')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Volver a la simulación actual' })).toBeInTheDocument()
    expect(screen.getAllByText('Replay · 90 días').length).toBeGreaterThan(0)
    expect(screen.getByText('pantalla')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('en la simulación activa no hay banda de contexto', () => {
    render(
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={livePayload()} base="">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(screen.queryByText('Volver a la simulación actual')).not.toBeInTheDocument()
    expect(screen.getAllByText('Simulado').length).toBeGreaterThan(0)
  })

  it('sin conexión, el <title> empieza con "● Sin conexión" y vuelve al reconectar', () => {
    const offline = livePayload({ offline: true, botStatus: { ...BOT, lastHeartbeat: NOW - 5 * 60_000 } })
    const ui = (live: typeof offline) =>
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={live} base="">
          <p>pantalla</p>
        </AppShell>,
      )
    const { unmount } = render(ui(offline))
    expect(document.title.startsWith('● Sin conexión')).toBe(true)
    expect(document.title).toBe('● Sin conexión · Sereno')
    unmount()
    expect(document.title).toBe('Sereno')
  })

  it('sin conexión, el prefijo sobrevive a que la navegación cambie el título', async () => {
    const offline = livePayload({ offline: true })
    render(
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={offline} base="">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    await act(async () => {
      document.title = 'Posiciones · Sereno'
      await Promise.resolve()
    })
    expect(document.title).toBe('● Sin conexión · Posiciones · Sereno')
  })

  it('sin sesión (primer uso) hay navegación pero ni chip ni bandas', () => {
    render(
      withQueryClient(
        <AppShell context={contextFor(null)} live={null} base="">
          <p>primer uso</p>
        </AppShell>,
      ),
    )
    expect(screen.getAllByRole('navigation', { name: 'Secciones' }).length).toBeGreaterThan(0)
    expect(screen.queryByText('Simulado')).not.toBeInTheDocument()
    expect(screen.getByText('primer uso')).toBeInTheDocument()
  })

  it('el área segura de arriba la toma una sola vez lo que queda arriba de todo', () => {
    const safeTop = (container: HTMLElement) => Array.from(container.querySelectorAll('[class*="safe-area-inset-top"]'))

    // En un replay la banda de contexto va primero, en el celu y en desktop: es la única que se corre.
    const replay = render(
      withQueryClient(
        <AppShell context={contextFor(replaySession())} live={null} base="/s/ses_replay">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(safeTop(replay.container)).toEqual([screen.getByRole('region', { name: 'Contexto de la sesión' })])
    replay.unmount()

    // En la activa no hay banda: la toman la barra superior (desktop) o la cabecera del celu, que nunca se ven juntas.
    const active = render(
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={livePayload()} base="">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    const holders = safeTop(active.container)
    expect(holders).toHaveLength(2)
    expect(holders.map((el) => el.classList.contains('desktop:hidden') || el.classList.contains('desktop:block'))).toEqual([true, true])
    expect(holders.some((el) => el.classList.contains('desktop:hidden'))).toBe(true)
  })

  it('tiene un atajo de teclado al contenido', () => {
    render(
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={livePayload()} base="">
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveAttribute('href', '#contenido')
    expect(document.getElementById('contenido')).toContainElement(screen.getByText('pantalla'))
  })
})

describe('título de la pestaña', () => {
  // El título final lo arma Next: el de la sesión pasa por el molde de la raíz y las páginas, por el suyo.
  async function titleOf(sessionId: string, page?: string): Promise<string> {
    const root = rootMetadata.title
    const rootTemplate = root && typeof root === 'object' && 'template' in root ? root.template : null
    const layout = resolveTitle((await generateMetadata({ params: Promise.resolve({ sessionId }) } as never)).title ?? null, rootTemplate)
    return page === undefined ? layout.absolute : resolveTitle(page, layout.template).absolute
  }

  it('el título de una sesión real es "Plata real · Sereno" y lo llevan todas sus pestañas', async () => {
    sessionRows.set('ses_real', realRow())
    expect(await titleOf('ses_real')).toBe('Plata real · Sereno')
    expect(await titleOf('ses_real', 'Ajustes')).toBe('Ajustes · Plata real · Sereno')
  })

  it('una sesión de papel o un replay no cambian el título', async () => {
    sessionRows.set('ses_old', realRow({ id: 'ses_old', kind: 'paper_live', binanceEnv: null, realStatus: null }))
    expect(await generateMetadata({ params: Promise.resolve({ sessionId: 'ses_old' }) } as never)).toEqual({})
  })
})

/** El cuerpo de `@utility <name> { … }`, contando llaves. */
function utilityBlock(css: string, name: string): string {
  return blockAfter(css, `@utility ${name} {`)
}

function mediaBlock(css: string, query: string): string {
  return blockAfter(css, `@media (${query}) {`)
}

function blockAfter(css: string, opener: string): string {
  const start = css.indexOf(opener)
  if (start < 0) throw new Error(`no encontré ${opener}`)
  let depth = 0
  for (let i = start + opener.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(start + opener.length, i)
  }
  throw new Error(`bloque sin cerrar: ${opener}`)
}
