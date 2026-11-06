// Cómo llega al motor en vivo una versión nueva de los ajustes.

import type { SymbolInfo } from '@sereno/core'
import type { TradingEngine } from '@sereno/core/src/engine/engine'
import type { Repos } from '@sereno/db'
import type { Settings } from '@sereno/shared'

type Pause = Settings['pause']

// Una pausa que quedó entre la versión aplicada y la nueva sin que el poll la viera (la
// automática del propio bot que Toti levantó enseguida, por ejemplo): el motor tiene que
// ver igual la reanudación, si no la pausa por drawdown seguiría con los ajustes sin pausa.
// El historial se pide por rango explícito: si Toti guarda otra versión entre la lectura
// de `version` y esta, la ventana no se corre.
export async function missedPause(
  repos: { settings: Pick<Repos['settings'], 'historyBetween'> },
  sessionId: string,
  { previous, next, applied, version }: { previous: Settings; next: Settings; applied: number; version: number },
): Promise<Pause | null> {
  if (previous.pause.paused || next.pause.paused || version <= applied + 1) return null
  const between = await repos.settings.historyBetween(sessionId, applied, version)
  return between.find((h) => h.config.pause.paused)?.config.pause ?? null
}

// `applySettings` pasando antes por la pausa que el poll no vio: así el motor ve la
// transición de pausada a reanudada.
export async function applyThrough(engine: TradingEngine, next: Settings, missed: Pause | null): Promise<void> {
  if (missed) await engine.applySettings({ ...next, pause: missed })
  await engine.applySettings(next)
}

// Toti reanudó entre los ajustes aplicados y los nuevos (también con una pausa que el poll
// no vio).
export function resumedBetween(current: Settings, next: Settings, missed: Pause | null): boolean {
  return (current.pause.paused || missed !== null) && !next.pause.paused
}

// Los ajustes con que se arma un motor que reemplaza a otro. `restore` levanta la pausa
// por drawdown si los ajustes no están pausados (lo que vale al reiniciar). Al rehacerlo
// en caliente eso sólo corresponde si Toti reanudó: si no, el bot acaba de pausarse y su
// escritura todavía no llegó, y el motor nuevo se arma con la pausa puesta para que la
// levante la próxima reanudación, como en el anterior.
export function rebuildSettings(next: Settings, { resumed, drawdownPaused }: { resumed: boolean; drawdownPaused: boolean }): Settings {
  const hold = !resumed && !next.pause.paused && drawdownPaused
  return hold ? { ...next, pause: { ...next.pause, paused: true } } : next
}

// Lo que el simulador usa de los contratos relevantes, para saber si cambió.
export function infosKey(infos: Record<string, SymbolInfo>, symbols: readonly string[]): string {
  return JSON.stringify([...symbols].sort().map((s) => infos[s] ?? null))
}
