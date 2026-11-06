import { describe, expect, it } from 'vitest'
import type { SettingsHistoryRow } from '@sereno/db'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { missedPause, rebuildSettings, resumedBetween } from '../../src/live/session-settings'

function paused(by: 'user' | 'auto' | null): Settings {
  return by === null ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, pause: { ...DEFAULT_SETTINGS.pause, paused: true, by } }
}

describe('ajustes al rehacer el motor', () => {
  it('reanudó si venía pausado (o con una pausa que el poll no vio) y ya no lo está', () => {
    expect(resumedBetween(paused('auto'), paused(null), null)).toBe(true)
    expect(resumedBetween(paused(null), paused(null), paused('auto').pause)).toBe(true)
    expect(resumedBetween(paused(null), paused(null), null)).toBe(false)
    expect(resumedBetween(paused('user'), paused('user'), null)).toBe(false)
  })

  it('con la pausa por drawdown puesta y sin reanudación, el motor nuevo se arma pausado', () => {
    expect(rebuildSettings(paused(null), { resumed: false, drawdownPaused: true }).pause.paused).toBe(true)
    expect(rebuildSettings(paused(null), { resumed: true, drawdownPaused: true })).toBe(DEFAULT_SETTINGS)
    expect(rebuildSettings(paused(null), { resumed: false, drawdownPaused: false })).toBe(DEFAULT_SETTINGS)
  })
})

describe('pausa que el poll no vio', () => {
  // Historial en memoria con la misma semántica que el repo (rango estricto, de la más vieja a la más nueva).
  function historyOf(configs: Settings[]) {
    const rows = configs.map((config, i): SettingsHistoryRow => ({ id: i + 1, sessionId: 's1', version: i + 1, config, changedBy: null, changedAt: new Date(0) }))
    return {
      settings: {
        historyBetween: async (_sessionId: string, after: number, before: number) => rows.filter((r) => r.version > after && r.version < before),
      },
    }
  }

  it('la encuentra por rango de versiones aunque el dueño haya guardado otra versión después de la que leyó el poll', async () => {
    // Aplicada la 1; el poll leyó la 3; la 2 fue la pausa automática que Toti levantó; la 4 llegó entre las dos lecturas.
    const repos = historyOf([paused(null), paused('auto'), paused(null), { ...paused(null), mode: 'custom' }])
    const found = await missedPause(repos, 's1', { previous: paused(null), next: paused(null), applied: 1, version: 3 })
    expect(found).toEqual(paused('auto').pause)
  })

  it('sin versiones salteadas o con alguna punta pausada no busca nada', async () => {
    const repos = historyOf([paused(null), paused('auto'), paused(null)])
    expect(await missedPause(repos, 's1', { previous: paused(null), next: paused(null), applied: 2, version: 3 })).toBeNull()
    expect(await missedPause(repos, 's1', { previous: paused('user'), next: paused(null), applied: 1, version: 3 })).toBeNull()
  })
})
