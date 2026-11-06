import { fireEvent, render, screen, within } from '@testing-library/react'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { describe, expect, it, vi } from 'vitest'
import { botStatusChips } from '@/components/status/bot-status'
import { BotStatusChips } from '@/components/status/bot-status-chips'
import { ErrorBand } from '@/components/status/error-band'
import { OfflineBand } from '@/components/status/offline-band'
import { withOfflinePrefix } from '@/components/status/offline-title'
import { LiveProvider } from '@/lib/live/provider'
import type { LivePayload } from '@/lib/live/types'
import { BOT, livePayload, NOW, withQueryClient } from '../nav/fixtures'

// Las fixtures arman las sesiones con `toSessionView` (puro); el módulo trae la base, que acá no hace falta.
vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

/** Hora de pared de Buenos Aires (UTC−3) del 31 de octubre de 2026. */
const ba = (hour: number, minute: number, day = 31) => Date.UTC(2026, 9, day, hour + 3, minute)

function texts(live: Parameters<typeof botStatusChips>[0]): string[] {
  return botStatusChips(live).map((c) => c.text)
}

function withSettings(patch: (s: Settings) => Settings): Settings {
  return patch(structuredClone(DEFAULT_SETTINGS))
}

describe('chips de estado del bot', () => {
  it('en vivo, con la hora del último ciclo', () => {
    expect(texts(livePayload())).toEqual(['En vivo · último ciclo 14:32'])
  })

  it('pausado por el usuario, desde cuándo', () => {
    const settings = withSettings((s) => ({ ...s, pause: { paused: true, by: 'user', at: new Date(ba(13, 10)).toISOString(), reason: null } }))
    expect(texts(livePayload({ settings, botStatus: { ...BOT, phase: 'paused' } }))).toEqual(['Pausado por vos desde las 13:10'])
  })

  it('pausado solo por drawdown, con el porcentaje de los ajustes', () => {
    const settings = withSettings((s) => ({ ...s, pause: { paused: true, by: 'auto', at: new Date(ba(13, 10)).toISOString(), reason: 'x' } }))
    const live = livePayload({ settings, botStatus: { ...BOT, phase: 'paused', flags: { ...BOT.flags, drawdownPause: true } } })
    expect(texts(live)).toEqual(['Pausado solo: drawdown del 15%'])
  })

  it('pausado solo con el capital blindado', () => {
    const settings = withSettings((s) => ({ ...s, pause: { paused: true, by: 'auto', at: null, reason: null } }))
    const live = livePayload({ settings, botStatus: { ...BOT, phase: 'paused' } })
    live.ledger.protegido = 1000
    expect(texts(live)).toEqual(['Pausado solo: capital blindado'])
  })

  it('calentando, esperando el turno y arrancando', () => {
    expect(texts(livePayload({ botStatus: { ...BOT, phase: 'warming', warmProgress: 18, universeSize: 30 } }))).toEqual([
      'Calentando · 18 de 30 monedas',
    ])
    expect(texts(livePayload({ botStatus: { ...BOT, phase: 'waiting_lease' } }))).toEqual([
      'Esperando el turno (otra instancia tiene el control)',
    ])
    expect(texts(livePayload({ botStatus: { ...BOT, phase: 'starting' } }))).toEqual(['Arrancando'])
  })

  it('la sesión real apagada dice qué le falta', () => {
    expect(texts(livePayload({ botStatus: { ...BOT, phase: 'off' } }))).toEqual(['Apagada'])
    const noKeys = { mode: 'unguarded' as const, missing: ['las claves de operación'] }
    expect(botStatusChips(livePayload({ botStatus: { ...BOT, phase: 'off', real: noKeys } }))).toEqual([
      { key: 'phase', text: 'Apagada: faltan las claves de operación', tone: 'loss', dot: false },
    ])
    // Con motor pero sin poder abrir (falta la variable, o la apagó Toti): cuida las abiertas.
    const reduceOnly = { mode: 'reduce_only' as const, missing: ['SERENO_REAL_TRADING=on', 'prenderla en Ajustes'] }
    expect(texts(livePayload({ botStatus: { ...BOT, real: reduceOnly } }))).toEqual(['Apagada: falta SERENO_REAL_TRADING=on y prenderla en Ajustes'])
    expect(texts(livePayload({ botStatus: { ...BOT, real: { mode: 'trading', missing: [] } } }))).toEqual(['En vivo · último ciclo 14:32'])
  })

  it('lo que dice la sesión real manda: el tope de pérdida y apagada a mano', () => {
    const reduceOnly = { mode: 'reduce_only' as const, missing: ['prenderla en Ajustes'] }
    const trading = { mode: 'trading' as const, missing: [] }
    expect(texts({ ...livePayload({ botStatus: { ...BOT, real: reduceOnly } }), realStatus: 'loss_floor' })).toEqual(['Apagada por el tope de pérdida'])
    // El bot todavía no se enteró: la base ya la apagó.
    expect(texts({ ...livePayload({ botStatus: { ...BOT, real: trading } }), realStatus: 'loss_floor' })).toEqual(['Apagada por el tope de pérdida'])
    expect(texts({ ...livePayload({ botStatus: { ...BOT, real: trading } }), realStatus: 'off' })).toEqual(['Apagada'])
    expect(texts({ ...livePayload({ botStatus: { ...BOT, real: reduceOnly } }), realStatus: 'off' })).toEqual(['Apagada: falta prenderla en Ajustes'])
    expect(texts({ ...livePayload({ botStatus: { ...BOT, real: trading } }), realStatus: 'on' })).toEqual(['En vivo · último ciclo 14:32'])
  })

  it('suma los cortes y avisos activos después del estado', () => {
    const live = livePayload({
      botStatus: {
        ...BOT,
        degradedSymbols: ['SOLUSDT', 'INJUSDT'],
        flags: { btcVolExtreme: true, dailyLossHit: true, drawdownPause: false, streakPause: true, learningFrozen: true },
      },
    })
    expect(texts(live)).toEqual([
      'En vivo · último ciclo 14:32',
      'Aprendizaje congelado',
      'BTC muy volátil: opera con la mitad del tamaño',
      'Pérdida diaria alcanzada: sin entradas hasta mañana',
      '6 stops seguidos: sin entradas por 4 horas',
      '2 monedas sin datos',
    ])
  })

  it('una sola moneda sin datos va en singular; congelar desde Ajustes también cuenta', () => {
    const settings = withSettings((s) => ({ ...s, learning: { ...s.learning, frozen: true } }))
    expect(texts(livePayload({ settings, botStatus: { ...BOT, degradedSymbols: ['SOLUSDT'] } }))).toEqual([
      'En vivo · último ciclo 14:32',
      'Aprendizaje congelado',
      '1 moneda sin datos',
    ])
  })

  it('sin conexión no repite lo que el bot dijo antes de caerse, pero sí lo que está en los ajustes', () => {
    const settings = withSettings((s) => ({ ...s, pause: { paused: true, by: 'user', at: new Date(ba(13, 10)).toISOString(), reason: null } }))
    const live = livePayload({
      offline: true,
      settings,
      botStatus: { ...BOT, lastHeartbeat: ba(14, 30), degradedSymbols: ['SOLUSDT'], flags: { ...BOT.flags, btcVolExtreme: true } },
    })
    expect(texts(live)).toEqual(['Sin conexión desde las 14:30', 'Pausado por vos desde las 13:10'])
  })

  it('sin latido nunca, el bot todavía no se conectó', () => {
    expect(texts(livePayload({ offline: true, botStatus: null }))).toEqual(['El bot todavía no se conectó'])
  })

  it('un latido de ayer dice el día', () => {
    expect(texts(livePayload({ offline: true, botStatus: { ...BOT, lastHeartbeat: ba(23, 50, 30) } }))).toEqual([
      'Sin conexión desde ayer a las 23:50',
    ])
  })

  it('se pueden limitar a los primeros (la barra superior muestra sólo el estado)', () => {
    const live = livePayload({ botStatus: { ...BOT, degradedSymbols: ['SOLUSDT'] } })
    render(<BotStatusChips live={live} limit={1} />)
    expect(screen.getByRole('list', { name: 'Estado del bot' }).children).toHaveLength(1)
    expect(screen.getByText('En vivo · último ciclo 14:32')).toBeInTheDocument()
  })
})

describe('banda sin conexión', () => {
  function renderBand(live: LivePayload) {
    return render(
      withQueryClient(
        <LiveProvider sessionId={live.sessionId} initial={live} enabled={false}>
          <OfflineBand />
        </LiveProvider>,
      ),
    )
  }

  it('dice desde cuándo y que los precios son de ese momento', () => {
    renderBand(livePayload({ offline: true, botStatus: { ...BOT, lastHeartbeat: ba(14, 32) } }))
    expect(screen.getByRole('status')).toHaveTextContent('Bot sin conexión desde las 14:32. Precios y resultados son de ese momento.')
  })

  it('sin latido nunca explica cómo arrancarlo', () => {
    renderBand(livePayload({ offline: true, botStatus: null }))
    expect(screen.getByRole('status')).toHaveTextContent('El bot todavía no se conectó. Para arrancarlo, en la Mac: pnpm bot')
  })

  it('con el bot en vivo no aparece, pero su región viva queda esperando vacía', () => {
    renderBand(livePayload())
    expect(screen.queryByText(/sin conexión/i)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})

describe('banda de error', () => {
  it('dice qué pasó, la hora del último dato y deja reintentar', () => {
    const onRetry = vi.fn()
    render(<ErrorBand error={new Error('boom')} updatedAt={ba(14, 32)} onRetry={onRetry} retrying={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('No pude leer la base. Último dato 14:32.')
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('sin error no ocupa lugar', () => {
    render(<ErrorBand error={null} updatedAt={NOW} onRetry={() => {}} retrying={false} />)
    expect(screen.getByRole('alert')).toBeEmptyDOMElement()
    expect(screen.queryByText(/No pude leer la base/)).not.toBeInTheDocument()
  })

  it('el botón queda fuera de la región viva: que cambie de texto al reintentar no vuelve a anunciar la alerta', () => {
    const band = (retrying: boolean) => <ErrorBand error={new Error('boom')} updatedAt={ba(14, 32)} onRetry={() => {}} retrying={retrying} />
    const { rerender } = render(band(false))
    const region = screen.getByRole('alert')
    expect(within(region).queryByRole('button')).toBeNull()
    expect(region.contains(screen.getByRole('button', { name: 'Reintentar' }))).toBe(false)
    const before = region.innerHTML
    rerender(band(true))
    expect(screen.getByRole('alert').innerHTML).toBe(before)
    expect(region).toHaveTextContent(/^No pude leer la base\. Último dato 14:32\.$/)
  })

  it('la región viva ya existe antes del error, así el lector de pantalla anuncia el texto que entra', () => {
    const band = (error: Error | null) => <ErrorBand error={error} updatedAt={ba(14, 32)} onRetry={() => {}} retrying={false} />
    const { rerender } = render(band(null))
    const region = screen.getByRole('alert')
    rerender(band(new Error('boom')))
    expect(screen.getByRole('alert')).toBe(region)
    expect(region).toHaveTextContent('No pude leer la base. Último dato 14:32.')
  })
})

describe('prefijo del título', () => {
  it('se agrega una sola vez y se saca al reconectar', () => {
    expect(withOfflinePrefix('Sereno', true)).toBe('● Sin conexión · Sereno')
    expect(withOfflinePrefix('● Sin conexión · Sereno', true)).toBe('● Sin conexión · Sereno')
    expect(withOfflinePrefix('● Sin conexión · Sereno', false)).toBe('Sereno')
    expect(withOfflinePrefix('Sereno', false)).toBe('Sereno')
  })
})
