// @vitest-environment node
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it, vi } from 'vitest'
import { isPausedByShield } from '@/lib/derive'
import { fetchLive, LiveAuthError, liveUrl } from '@/lib/live/fetch-live'
import { IDLE_REFRESH_MS, LIVE_REFRESH_MS, liveRefetchInterval } from '@/lib/live/interval'
import type { BotStatusView, LivePayload } from '@/lib/live/types'

const NOW = Date.UTC(2026, 9, 31, 18, 0)

const BOT: BotStatusView = {
  instanceId: 'mac-1',
  lastHeartbeat: NOW - 5_000,
  phase: 'live',
  warmProgress: 30,
  universeSize: 30,
  lastCycleAt: NOW - 60_000,
  settingsVersionApplied: 3,
  degradedSymbols: [],
  flags: { btcVolExtreme: false, dailyLossHit: false, drawdownPause: false, streakPause: false, learningFrozen: false },
  recentErrors: [],
  botVersion: '0.1.0',
  real: null,
}

function live(patch: Partial<LivePayload> = {}): LivePayload {
  return {
    version: 'v1',
    sessionId: 'ses_1',
    now: NOW,
    offline: false,
    market: null,
    open: [],
    botStatus: BOT,
    equityLast: null,
    settingsVersion: 3,
    settings: DEFAULT_SETTINGS,
    ledger: {
      capitalInicial: 1000,
      startedAt: NOW - 86_400_000,
      saldo: 1000,
      protegido: 0,
      baseBlindaje: 1000,
      closedCount: 0,
      wonCount: 0,
      dayStart: NOW - 18 * 3_600_000,
      equityAtDayStart: 1000,
    },
    commands: [],
    realStatus: null,
    ...patch,
  }
}

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }))
}

describe('fetchLive', () => {
  it('la primera vez pide sin `since`', async () => {
    const fetcher = respond(200, live())
    await fetchLive('ses_1', undefined, { fetcher })
    expect(fetcher).toHaveBeenCalledWith('/api/live?session=ses_1', expect.objectContaining({ cache: 'no-store' }))
  })

  it('con datos previos manda su versión y, si nada cambió, devuelve los mismos datos', async () => {
    const previous = live({ version: '7.1730.3.4.abc' })
    const fetcher = respond(200, { unchanged: true })
    const result = await fetchLive('ses_1', previous, { fetcher })
    expect(fetcher.mock.calls[0]?.[0]).toBe(liveUrl('ses_1', '7.1730.3.4.abc'))
    expect(result).toBe(previous)
  })

  it('con cambios devuelve el payload nuevo', async () => {
    const next = live({ version: 'v2' })
    expect(await fetchLive('ses_1', live(), { fetcher: respond(200, next) })).toEqual(next)
  })

  it('401 y 403 son errores de sesión, no de red', async () => {
    await expect(fetchLive('ses_1', undefined, { fetcher: respond(401, { error: 'unauthorized' }) })).rejects.toEqual(new LiveAuthError(401))
    await expect(fetchLive('ses_1', undefined, { fetcher: respond(403, { error: 'not_allowed' }) })).rejects.toBeInstanceOf(LiveAuthError)
  })

  it('un 500 es un error para la banda de reintento', async () => {
    await expect(fetchLive('ses_1', undefined, { fetcher: respond(500, {}) })).rejects.toThrow('No pude leer los datos en vivo (500).')
  })
})

describe('liveRefetchInterval', () => {
  it('5 s con la pestaña visible y el bot en vivo', () => {
    expect(liveRefetchInterval(live(), 'visible')).toBe(LIVE_REFRESH_MS)
    expect(LIVE_REFRESH_MS).toBe(5_000)
  })

  it('30 s sin conexión o pausado', () => {
    expect(IDLE_REFRESH_MS).toBe(30_000)
    expect(liveRefetchInterval(live({ offline: true }), 'visible')).toBe(IDLE_REFRESH_MS)
    expect(liveRefetchInterval(live({ botStatus: { ...BOT, phase: 'paused' } }), 'visible')).toBe(IDLE_REFRESH_MS)
    const paused = { ...DEFAULT_SETTINGS, pause: { paused: true, by: 'user' as const, at: '2026-10-31T16:10:00Z', reason: null } }
    expect(liveRefetchInterval(live({ settings: paused }), 'visible')).toBe(IDLE_REFRESH_MS)
  })

  it('nada con la pestaña oculta', () => {
    expect(liveRefetchInterval(live(), 'hidden')).toBe(false)
  })
})

describe('isPausedByShield', () => {
  const autoPause = { ...DEFAULT_SETTINGS, pause: { paused: true, by: 'auto' as const, at: '2026-10-31T16:10:00Z', reason: 'Me pausé solo.' } }
  const shielded = { ...live().ledger, protegido: 1000 }

  it('pausa automática con el capital blindado', () => {
    expect(isPausedByShield(live({ settings: autoPause, ledger: shielded }))).toBe(true)
  })

  it('no es la del drawdown ni una pausa a mano', () => {
    const drawdown = { ...BOT, flags: { ...BOT.flags, drawdownPause: true } }
    expect(isPausedByShield(live({ settings: autoPause, ledger: shielded, botStatus: drawdown }))).toBe(false)
    const byUser = { ...autoPause, pause: { ...autoPause.pause, by: 'user' as const } }
    expect(isPausedByShield(live({ settings: byUser, ledger: shielded }))).toBe(false)
    expect(isPausedByShield(live({ settings: autoPause }))).toBe(false)
  })
})
