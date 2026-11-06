import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LeanBar } from '@/components/monedas/lean-bar'
import { updateSettings } from '@/lib/actions/settings'
import { setReducedMotion } from '../media'
import { expectReducedMotionWarning } from '../motion-warning'
import { contextFor, NOW, replaySession } from '../nav/fixtures'
import { boardLive, EXPECTED_ORDER, market, OPEN, openPosition, settingsWith, THETA } from './fixtures'
import { refresh, resetUrl } from './navigation'
import { renderScreen } from './render'

vi.mock('next/navigation', async () => (await import('./navigation')).navigation)
vi.mock('@/lib/actions/settings', () => ({ updateSettings: vi.fn() }))
// Las fixtures arman las sesiones con `toSessionView` (puro); el módulo trae la base, que acá no hace falta.
vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const update = vi.mocked(updateSettings)

function board(): HTMLElement {
  return screen.getByRole('list', { name: 'Monedas del tablero' })
}

function tile(name: string): HTMLElement {
  return within(board()).getByRole('button', { name: new RegExp(`^${name},`) })
}

function tileNames(): string[] {
  return within(board())
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label')?.split(',')[0] ?? '')
}

beforeEach(() => {
  resetUrl('/monedas')
  update.mockReset()
})

describe('tablero', () => {
  it('muestra las 30 baldosas: primero las que tienen posición, después por |S′|', () => {
    renderScreen()
    expect(tileNames()).toEqual(EXPECTED_ORDER)
  })

  it('la baldosa de 1000PEPEUSDT dice "PEPE"', () => {
    renderScreen()
    expect(within(tile('PEPE')).getByText('PEPE')).toBeInTheDocument()
    expect(within(board()).queryByText('1000PEPE')).not.toBeInTheDocument()
  })

  it('con posición muestra el chip de lado y apalancamiento; sin posición, el cambio de 24 h', () => {
    renderScreen()
    expect(within(tile('SOL')).getByText('L 5x')).toBeInTheDocument()
    expect(within(tile('AVAX')).getByText('S 2x')).toBeInTheDocument()
    expect(within(tile('BTC')).getByText('+1,2%')).toBeInTheDocument()
    expect(within(tile('INJ')).getByText('−3,0%')).toBeInTheDocument()
    // Ganancia o pérdida de la abierta no depende sólo del color del borde.
    expect(tile('AVAX')).toHaveAccessibleName(expect.stringContaining('−US$ 3,10'))
  })

  it('estados: degradada, en enfriamiento y en penitencia, con sus textos', () => {
    renderScreen()
    expect(within(tile('FIL')).getByText('sin datos hace 3 min')).toBeInTheDocument()
    expect(within(tile('NEAR')).getByText('espera 45 min')).toBeInTheDocument()
    expect(within(tile('WIF')).getByText('vuelve el 7/11')).toBeInTheDocument()
    expect(tile('WIF')).toHaveAttribute('data-state', 'penalized')
    expect(tile('FIL')).toHaveAttribute('data-state', 'degraded')
  })

  it('titular y explicación del orden en la simulación activa', () => {
    renderScreen()
    expect(screen.getByRole('heading', { level: 1, name: 'Mirando 30 monedas, con 3 posiciones abiertas.' })).toBeInTheDocument()
    expect(screen.getByText('Primero las abiertas, después las que más se inclinan.')).toBeInTheDocument()
  })

  it('sin conexión: titular en pasado, los cambios de 24 h apagados y la hora de los precios', () => {
    renderScreen({ live: boardLive({ offline: true }) })
    expect(screen.getByRole('heading', { level: 1, name: 'Miraba 30 monedas, con 3 posiciones abiertas.' })).toBeInTheDocument()
    expect(screen.getByText('Precios de las 15:31.')).toBeInTheDocument()
    expect(within(tile('BTC')).getByText('+1,2%')).toHaveClass('text-muted')
  })

  it('en un replay, el titular cuenta cómo terminó', () => {
    const live = boardLive({ sessionId: 'ses_replay', open: OPEN.slice(0, 2) })
    renderScreen({ context: contextFor(replaySession()), live })
    expect(
      screen.getByRole('heading', { level: 1, name: 'Al terminar el replay miraba 30 monedas, con 2 posiciones abiertas.' }),
    ).toBeInTheDocument()
  })

  it('sin snapshot de mercado todavía: "El tablero se llena cuando el bot conecte"', () => {
    renderScreen({ live: boardLive({ market: null, open: [], botStatus: null, offline: true }) })
    expect(screen.getByRole('heading', { level: 1, name: 'El tablero se llena cuando el bot conecte.' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Monedas del tablero' })).not.toBeInTheDocument()
  })
})

describe('barra de inclinación', () => {
  function fill(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-lean-fill]')
  }

  it('con S′ = 0,72 va del centro hacia la derecha: left 50%, width 36%', () => {
    const { container } = render(<LeanBar sPrime={0.72} theta={THETA} />)
    expect(fill(container)).toHaveStyle({ left: '50%', width: '36%' })
  })

  it('con S′ = −0,4 va del centro hacia la izquierda', () => {
    const { container } = render(<LeanBar sPrime={-0.4} theta={THETA} />)
    expect(fill(container)).toHaveStyle({ left: '30%', width: '20%' })
  })

  it('sin puntaje no dibuja inclinación', () => {
    const { container } = render(<LeanBar sPrime={null} theta={THETA} />)
    expect(fill(container)).toBeNull()
  })
})

describe('latido al abrir una posición', () => {
  const withBtc = () =>
    boardLive({
      open: [...OPEN, openPosition('p-btc', { symbol: 'BTCUSDT', side: 'long', leverage: 4 }, 0.5)],
      market: market((symbols) => symbols.map((s) => (s.symbol === 'BTCUSDT' ? { ...s, state: 'in_position' } : s))),
    })

  it('no late en la carga inicial', () => {
    renderScreen()
    expect(within(board()).getAllByRole('button').filter((b) => b.hasAttribute('data-pulse'))).toEqual([])
  })

  it('late una vez cuando la baldosa pasa a tener posición entre dos refrescos', async () => {
    const { pushLive } = renderScreen()
    await pushLive(withBtc())
    expect(tile('BTC')).toHaveAttribute('data-pulse', 'beat')
    expect(within(tile('BTC')).getByText('L 4x')).toBeInTheDocument()
  })

  it('con movimiento reducido el latido es sólo de color', async () => {
    const checkWarning = expectReducedMotionWarning()
    setReducedMotion(true)
    const { pushLive } = renderScreen()
    await pushLive(withBtc())
    expect(tile('BTC')).toHaveAttribute('data-pulse', 'color')
    checkWarning()
  })
})

describe('hoja de la moneda', () => {
  it('tocar una baldosa abre la hoja con las barras de señales, Fijar y Excluir, y la URL lo refleja', () => {
    renderScreen()
    fireEvent.click(tile('SOL'))
    const sheet = screen.getByRole('dialog', { name: 'SOL' })
    const signals = within(sheet).getByRole('table', { name: 'Señales del último ciclo' })
    expect(within(signals).getByRole('row', { name: /Tendencia de 15 minutos/ })).toHaveTextContent('+0,80')
    expect(within(signals).getByRole('row', { name: /Funding/ })).toHaveTextContent('sin dato')
    expect(within(sheet).getByRole('button', { name: 'Fijar' })).toBeEnabled()
    expect(within(sheet).getByRole('button', { name: 'Excluir' })).toBeEnabled()
    expect(window.location.search).toBe('?moneda=SOLUSDT')
    // El gráfico de la moneda lo trae el Server Component con la URL nueva.
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('"atrás" la cierra', async () => {
    renderScreen()
    fireEvent.click(tile('SOL'))
    window.history.back()
    await waitFor(() => expect(window.location.search).toBe(''))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('una URL con ?moneda= la abre al cargar', () => {
    resetUrl('/monedas?moneda=WIFUSDT')
    renderScreen()
    const sheet = screen.getByRole('dialog', { name: 'WIF' })
    expect(within(sheet).getByText(/En penitencia hasta el 7 de noviembre/)).toBeInTheDocument()
  })

  it('en un replay no ofrece fijar ni excluir', () => {
    const live = boardLive({ sessionId: 'ses_replay' })
    renderScreen({ context: contextFor(replaySession()), live })
    fireEvent.click(tile('SOL'))
    const sheet = screen.getByRole('dialog', { name: 'SOL' })
    expect(within(sheet).getByRole('table', { name: 'Señales del último ciclo' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Fijar' })).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument()
  })

  it('la explicación de excluir depende de si tiene una abierta', () => {
    renderScreen({ live: boardLive({ settings: settingsWith({ excluded: ['ETHUSDT'] }) }) })
    fireEvent.click(tile('SOL'))
    expect(screen.getByRole('dialog', { name: 'SOL' })).toHaveTextContent('Excluirla la saca cuando cierre esta posición.')
    act(() => window.history.replaceState(null, '', '/monedas?moneda=BTCUSDT'))
    expect(screen.getByRole('dialog', { name: 'BTC' })).toHaveTextContent('Excluirla la saca del tablero.')
    act(() => window.history.replaceState(null, '', '/monedas?moneda=ETHUSDT'))
    expect(screen.getByRole('dialog', { name: 'ETH' })).toHaveTextContent('Está excluida: la cuido hasta cerrar la posición')
  })

  it('sin conexión, Fijar y Excluir quedan deshabilitados con la explicación', () => {
    renderScreen({ live: boardLive({ offline: true }) })
    fireEvent.click(tile('SOL'))
    const sheet = screen.getByRole('dialog', { name: 'SOL' })
    expect(within(sheet).getByRole('button', { name: 'Fijar' })).toBeDisabled()
    expect(within(sheet).getByRole('button', { name: 'Excluir' })).toBeDisabled()
    expect(within(sheet).getByText('Sin conexión con el bot: vas a poder fijarla o excluirla cuando vuelva.')).toBeInTheDocument()
  })
})

describe('fijar y excluir', () => {
  it('Fijar escribe el universo con la versión vista y "Deshacer" vuelve a escribir el anterior', async () => {
    update.mockResolvedValueOnce({ ok: true, version: 5 }).mockResolvedValueOnce({ ok: true, version: 6 })
    renderScreen()
    fireEvent.click(tile('SOL'))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'SOL' })).getByRole('button', { name: 'Fijar' }))

    expect(update).toHaveBeenCalledWith('ses_live', { universe: { ...DEFAULT_SETTINGS.universe, pinned: ['SOLUSDT'] } }, 4)
    const toast = await screen.findByText('Fijaste SOL.')
    // La hoja queda abierta (el aviso va por encima) y, mientras el refresco en vivo no trae
    // la versión nueva, ya muestra el cambio.
    const sheet = screen.getByRole('dialog', { name: 'SOL' })
    expect(window.location.search).toBe('?moneda=SOLUSDT')
    expect(within(sheet).getByRole('button', { name: 'Dejar de fijar' })).toBeInTheDocument()
    expect(within(sheet).getByText('Está fijada: sigue en el tablero aunque salga del top 30.')).toBeInTheDocument()

    fireEvent.click(within(toast.parentElement as HTMLElement).getByRole('button', { name: 'Deshacer' }))
    expect(update).toHaveBeenLastCalledWith('ses_live', { universe: DEFAULT_SETTINGS.universe }, 5)
    expect(await screen.findByRole('button', { name: 'Fijar' })).toBeInTheDocument()
  })

  it('Excluir saca la moneda de las fijadas', async () => {
    update.mockResolvedValueOnce({ ok: true, version: 5 })
    renderScreen({ live: boardLive({ settings: settingsWith({ pinned: ['SOLUSDT', 'BTCUSDT'] }) }) })
    fireEvent.click(tile('SOL'))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'SOL' })).getByRole('button', { name: 'Excluir' }))
    expect(update).toHaveBeenCalledWith(
      'ses_live',
      { universe: { ...DEFAULT_SETTINGS.universe, pinned: ['BTCUSDT'], excluded: ['SOLUSDT'] } },
      4,
    )
    expect(await screen.findByText('Excluiste SOL.')).toBeInTheDocument()
  })

  it('con conflicto de versión avisa y recarga', async () => {
    const message = 'Los ajustes cambiaron mientras los editabas: te muestro la versión nueva.'
    update.mockResolvedValueOnce({ ok: false, reason: 'conflict', message, version: 9, settings: DEFAULT_SETTINGS })
    renderScreen()
    fireEvent.click(tile('SOL'))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'SOL' })).getByRole('button', { name: 'Fijar' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    // El clic de la baldosa pidió el gráfico; el conflicto vuelve a pedir la página.
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Deshacer')).not.toBeInTheDocument()
  })

  it('las excluidas quedan listadas fuera del tablero, con "Incluir"', async () => {
    update.mockResolvedValueOnce({ ok: true, version: 5 })
    renderScreen({
      // DOGE ya salió del snapshot; SOL tiene una abierta y sigue en el tablero hasta cerrarla.
      live: boardLive({
        settings: settingsWith({ excluded: ['DOGEUSDT', 'SOLUSDT'], pinned: ['XAUUSDT'] }),
        market: market((symbols) => symbols.filter((s) => s.symbol !== 'DOGEUSDT')),
      }),
      excluded: { XAUUSDT: { reason: 'tradfi', pinned: true }, USDCUSDT: { reason: 'stablecoin' } },
    })
    const outside = screen.getByRole('region', { name: 'Fuera del tablero' })
    expect(within(outside).queryByText('SOL')).not.toBeInTheDocument()
    expect(within(outside).getByText('XAU')).toBeInTheDocument()
    expect(within(outside).getByText('Fijada, pero es TradFi y está apagado en Ajustes.')).toBeInTheDocument()
    // Las que filtra el universo y nadie pidió no son noticia.
    expect(within(outside).queryByText('USDC')).not.toBeInTheDocument()
    const include = within(outside).getByRole('button', { name: 'Incluir DOGE' })
    // Objetivo táctil de 44 px.
    expect(include).toHaveClass('h-11')
    fireEvent.click(include)
    expect(update).toHaveBeenCalledWith('ses_live', { universe: settingsWith({ excluded: ['SOLUSDT'], pinned: ['XAUUSDT'] }).universe }, 4)
    expect(await screen.findByText('Volviste a incluir DOGE.')).toBeInTheDocument()
  })

  it('el reloj de los estados es el de la base, no el del navegador', () => {
    vi.setSystemTime(NOW + 3_600_000)
    try {
      renderScreen()
      expect(within(tile('NEAR')).getByText('espera 45 min')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
