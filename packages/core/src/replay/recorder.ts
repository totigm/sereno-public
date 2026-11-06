import type { EngineFailure, EngineSnapshot } from '../engine/types'
import type { EquityPoint } from '../stats/stats'
import type { AccountSnapshot, ClosedPosition, Decision, EngineEvent } from '../types'
import type { Books, DrawdownPause, ReplayEquityPoint, ReplayFailure, TuningRun } from './types'

// Lo que el replay junta mientras corre: trades cerrados, decisiones (de los eventos del
// motor), la pausa por drawdown de lo real, fallas, y la equity de cada vela.

export interface RecorderOptions {
  // Guardar las decisiones o sólo pasarlas a `onDecision` (ver `ReplayInput.keepDecisions`).
  keepDecisions: boolean
  onDecision: (decision: Decision) => void
}

export class ReplayRecorder {
  readonly closed: Books<ClosedPosition[]> = { real: [], shadow: [] }
  readonly decisions: Decision[] = []
  readonly failures: ReplayFailure[] = []
  private pause: DrawdownPause | null = null

  constructor(private readonly options: RecorderOptions) {}

  get drawdownPause(): DrawdownPause | null {
    return this.pause
  }

  event(event: EngineEvent): void {
    if (event.type === 'position_closed') this.closed[event.position.shadow ? 'shadow' : 'real'].push(event.position)
    else if (event.type === 'decisions') this.noteDecisions(event.decisions)
    // El de la sombra no pausa (`shadow: true`); el de lo real no se levanta en un replay.
    else if (event.type === 'account_rule' && event.rule === 'drawdown' && !event.shadow && this.pause === null) this.notePause(event.at, event.data)
  }

  // El resultado tiene que poder serializarse igual siempre: del error queda el mensaje.
  // `tuning`: la falla salió del ajuste semanal, agrupada (ver `ReplayFailure`).
  failure({ error, ...failure }: EngineFailure, tuning?: { run: TuningRun; count: number }): void {
    this.failures.push({ ...failure, error: errorMessage(error), ...(tuning ? { tuning: tuning.run, count: tuning.count } : {}) })
  }

  // Corre dentro del sink del motor: lanzar acá cortaría una operación a mitad. Un aviso
  // que no se puede leer queda como falla y la pausa, sin registrar.
  private notePause(at: number, data: unknown): void {
    // `account_rule.data` llega sin tipo en `EngineEvent`: el del drawdown es `{ peak, equity }`.
    const { peak, equity } = (data ?? {}) as Record<string, unknown>
    if (typeof peak === 'number' && typeof equity === 'number') this.pause = { at, peak, equity }
    else this.failures.push({ operation: 'event', event: 'account_rule', at, error: `aviso de drawdown sin pico o equity: ${JSON.stringify(data)}` })
  }

  private noteDecisions(decisions: readonly Decision[]): void {
    for (const decision of decisions) this.options.onDecision(decision)
    if (this.options.keepDecisions) this.decisions.push(...decisions)
  }
}

export class EquityRecorder {
  readonly curve: ReplayEquityPoint[] = []
  // Serie del drawdown por vela en el peor caso: los cierres de vela y, entre ellos, el
  // momento en que toda la cartera está en su extremo adverso.
  private readonly worst: Books<EquityPoint[]> = { real: [], shadow: [] }

  close(at: number, snapshot: EngineSnapshot): void {
    const { real, shadow } = accountsOf(snapshot)
    this.curve.push({ at, real, shadow })
    this.worst.real.push({ at, equity: real.equity })
    this.worst.shadow.push({ at, equity: shadow.equity })
  }

  adverse(at: number, snapshot: EngineSnapshot): void {
    const { real, shadow } = accountsOf(snapshot)
    this.worst.real.push({ at, equity: real.equity })
    this.worst.shadow.push({ at, equity: shadow.equity })
  }

  worstCase(book: keyof Books<unknown>): EquityPoint[] {
    return this.worst[book]
  }
}

function accountsOf(snapshot: EngineSnapshot): Books<AccountSnapshot> {
  const { real, shadow } = snapshot.accounts
  if (shadow === null) throw new Error('el replay corre siempre con sombra')
  return { real, shadow }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
