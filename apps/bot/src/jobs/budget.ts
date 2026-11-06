import { RateLimiter, type LimitKind } from '../binance/rate-limiter'
import { BINANCE_LIMITS } from '../config'

// Tope propio de un job, por debajo del limitador compartido del cliente REST: el job
// reserva acá antes de cada llamada y el cliente vuelve a reservar en el compartido.
// Así una descarga larga no se come el margen que necesita el ciclo en vivo. El runtime
// crea uno por proceso y lo pasa a cada job: uno nuevo por llamada no limitaría nada.
export interface CallBudget {
  acquire(kind: LimitKind, weight: number): Promise<void>
}

// ≤ 150 llamadas de peso 10 por minuto (spec §12): quedan 900 de los 2.400 para el vivo.
export const WARMUP_WEIGHT_PER_MINUTE = 1500

export function weightBudget(weightPerMinute: number, now: () => number = Date.now): CallBudget {
  return new RateLimiter({ ...BINANCE_LIMITS, weightPerMinute, now })
}
