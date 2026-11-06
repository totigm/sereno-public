import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionChip } from '@/components/nav/session-chip'
import type { SessionSwitcher } from '@/components/nav/session-switcher'
import { AppShell } from '@/components/shell/app-shell'
import { BOT, contextFor, liveSession, livePayload, realSession, replaySession, withQueryClient } from './fixtures'

// Las fixtures arman las sesiones con `toSessionView` (puro); el módulo trae la base, que acá no hace falta.
vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const navigation = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}))

beforeEach(() => {
  navigation.pathname = '/'
})

const WITH_REAL: SessionSwitcher = { paperHref: '', realHref: '/s/ses_real', current: 'paper' }

function switches(): HTMLElement[] {
  return screen.queryAllByRole('navigation', { name: 'Sesión' })
}

describe('selector de sesión', () => {
  it('sin una sesión real activa no aparece', () => {
    render(
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={livePayload()} base="" switcher={{ paperHref: '', realHref: null, current: 'paper' }}>
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(switches()).toEqual([])
    expect(screen.queryByRole('link', { name: 'Plata real' })).not.toBeInTheDocument()
  })

  it('con una real activa, en /posiciones lleva a la misma pestaña de la otra sesión', () => {
    navigation.pathname = '/posiciones'
    render(
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={livePayload()} base="" switcher={WITH_REAL}>
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    // Uno en la barra de desktop y otro en la cabecera del celu: los dos iguales.
    expect(switches()).toHaveLength(2)
    for (const nav of switches()) {
      expect(within(nav).getByRole('link', { name: 'Plata real' })).toHaveAttribute('href', '/s/ses_real/posiciones')
      expect(within(nav).getByRole('link', { name: 'Simulación' })).toHaveAttribute('href', '/posiciones')
      expect(within(nav).getByRole('link', { current: 'page' })).toHaveTextContent('Simulación')
    }
  })

  it('el selector reemplaza al chip: ya dice qué sesión se mira, y deja lugar al estado del bot', () => {
    const shell = (switcher: SessionSwitcher) =>
      withQueryClient(
        <AppShell context={contextFor(liveSession())} live={livePayload()} base="" switcher={switcher}>
          <p>pantalla</p>
        </AppShell>,
      )
    const { rerender } = render(shell({ paperHref: '', realHref: null, current: 'paper' }))
    expect(screen.getAllByText('Simulado')).toHaveLength(2)
    rerender(shell(WITH_REAL))
    expect(screen.queryAllByText('Simulado')).toHaveLength(0)
  })

  it('en la sesión real marca "Plata real" en color de alerta, en desktop y en el celu', () => {
    navigation.pathname = '/s/ses_real/monedas'
    const real = realSession()
    render(
      withQueryClient(
        <AppShell
          context={contextFor(real)}
          live={livePayload({ sessionId: 'ses_real', botStatus: { ...BOT, real: { mode: 'trading', missing: [] } } })}
          base="/s/ses_real"
          switcher={{ ...WITH_REAL, current: 'real' }}
        >
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    expect(switches()).toHaveLength(2)
    for (const nav of switches()) {
      const current = within(nav).getByRole('link', { current: 'page' })
      expect(current).toHaveTextContent('Plata real')
      expect(current).toHaveAttribute('data-tone', 'alert')
      expect(within(nav).getByRole('link', { name: 'Simulación' })).toHaveAttribute('href', '/monedas')
    }
    // La marca es el selector: ningún chip repite "Plata real" al lado.
    expect(screen.getAllByText('Plata real')).toHaveLength(2)
    // Sin banda de contexto: la real es una sesión activa, no una del pasado.
    expect(screen.queryByText('Volver a la simulación actual')).not.toBeInTheDocument()
  })

  it('en un replay no marca ninguna de las dos', () => {
    navigation.pathname = '/s/ses_replay'
    render(
      withQueryClient(
        <AppShell context={contextFor(replaySession())} live={null} base="/s/ses_replay" switcher={{ ...WITH_REAL, current: 'other' }}>
          <p>pantalla</p>
        </AppShell>,
      ),
    )
    for (const nav of switches()) expect(within(nav).queryByRole('link', { current: 'page' })).not.toBeInTheDocument()
  })
})

describe('chip de la sesión real', () => {
  it('dice "Plata real" con el tono de alerta', () => {
    render(<SessionChip session={realSession()} />)
    expect(screen.getByText('Plata real')).toHaveAttribute('data-tone', 'alert')
  })
})
