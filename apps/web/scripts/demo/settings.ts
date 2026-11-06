import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '@sereno/shared'
import type { LearningState } from '@sereno/core'
import { initialLearningState } from '@sereno/core/src/learning/state'
import type { SettingsChange } from './spec'

// Historia de ajustes de una simulación: la versión 1 al crearla y una más por cada
// guardado. Un parche reemplaza grupos enteros, como `settings.update` del repo.
export interface SettingsVersion {
  version: number
  at: number
  by: string | null
  config: Settings
}

// Los escenarios de demostración se armaron con θ 0,35 y k 1,5 (los defaults de entonces);
// quedan fijos acá para que un cambio de default no les mueva los números.
export const DEMO_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  entry: { ...DEFAULT_SETTINGS.entry, theta: 0.35 },
  exits: { ...DEFAULT_SETTINGS.exits, k: 1.5 },
}

// Lo aprendido al arrancar, con los mismos θ y k de los escenarios.
export function demoLearningState(now: number): LearningState {
  const state = initialLearningState(now)
  return { ...state, params: { ...state.params, theta: DEMO_SETTINGS.entry.theta, k: DEMO_SETTINGS.exits.k } }
}

export function settingsTimeline(changes: readonly SettingsChange[]): SettingsVersion[] {
  if (changes.length === 0) throw new Error('Una simulación arranca con su versión 1 de ajustes')
  const out: SettingsVersion[] = []
  let config: Settings = DEMO_SETTINGS
  for (const [i, change] of changes.entries()) {
    const previous = out[i - 1]
    if (previous && change.at <= previous.at) throw new Error('Los cambios de ajustes van en orden')
    config = SettingsSchema.parse({ ...config, ...change.patch })
    out.push({ version: i + 1, at: change.at, by: change.by, config })
  }
  return out
}

// Los ajustes vigentes en un instante; antes de la primera versión, la primera.
export function settingsAt(timeline: readonly SettingsVersion[]): (t: number) => Settings {
  return (t) => {
    let current = timeline[0]
    for (const v of timeline) if (v.at <= t) current = v
    if (!current) throw new Error('Historia de ajustes vacía')
    return current.config
  }
}
