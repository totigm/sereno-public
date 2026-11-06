// Pausa automática en `settings.pause` (spec §7): el drawdown máximo y el capital blindado
// sin margen para operar pausan la sesión como si Toti hubiera tocado "Pausar", con
// `by: 'auto'` y el motivo en `reason` (lo que el diario muestra). Se escribe con el mismo
// optimistic locking que el dashboard; si Toti guardó en el medio, se relee y reintenta.

import type { Repos } from '@sereno/db'

const ATTEMPTS = 3

type SettingsRepos = Pick<Repos, 'settings'>

// true si pausó; false si ya estaba pausada (una pausa de Toti no se pisa).
export async function setAutoPause(repos: SettingsRepos, sessionId: string, reason: string, at: number): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await repos.settings.get(sessionId)
    if (!row) throw new Error(`La sesión ${sessionId} no tiene ajustes para pausar`)
    if (row.config.pause.paused) return false
    const pause = { paused: true, by: 'auto' as const, at: new Date(at).toISOString(), reason }
    if ((await repos.settings.update(sessionId, { pause }, row.version)).ok) return true
  }
  throw new Error(`No pude pausar la sesión ${sessionId}: los ajustes cambiaron ${ATTEMPTS} veces seguidas`)
}

// Levanta una pausa automática (no una de Toti). true si reanudó.
export async function liftAutoPause(repos: SettingsRepos, sessionId: string): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await repos.settings.get(sessionId)
    if (!row) throw new Error(`La sesión ${sessionId} no tiene ajustes para reanudar`)
    if (!row.config.pause.paused || row.config.pause.by !== 'auto') return false
    const pause = { paused: false, by: null, at: null, reason: null }
    if ((await repos.settings.update(sessionId, { pause }, row.version)).ok) return true
  }
  throw new Error(`No pude reanudar la sesión ${sessionId}: los ajustes cambiaron ${ATTEMPTS} veces seguidas`)
}
