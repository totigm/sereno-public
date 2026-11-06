// Corre un replay o el walk-forward semanal en un `worker_threads` (spec §9 y §12): la
// simulación es CPU pura durante minutos y en el hilo principal frenaría el ciclo en vivo
// de 15 minutos, el stream y el latido. El worker escribe en la base por su cuenta (de a
// un día, ver `writer.ts`) y al principal sólo le devuelve el resultado final: nunca las
// decisiones. REST y presupuesto los pide al principal, que los comparte con el vivo.

import { Worker } from 'node:worker_threads'
import type { WalkForwardResult } from '@sereno/core/src/learning/params'
import type { CallBudget } from '../jobs/budget'
import { errorMessage } from '../jobs/errors'
import type { Logger } from '../logger'
import type { ReplayRest } from './download'
import { isRpcRequest, serveRpc } from './rpc'
import type { ReplayOutcome } from './run'
import type { TuningTask } from './tuning'

export interface ReplayTask {
  kind: 'replay'
  sessionId: string
  // El "ahora" del pedido: el período son los días UTC completos hasta acá.
  now: number
}

export type WorkerTask = ReplayTask | TuningTask

export interface WorkerInput {
  task: WorkerTask
  databaseUrl: string
  logLevel: string
}

export type WorkerMessage =
  | { type: 'log'; line: string }
  | { type: 'done'; result: ReplayOutcome | WalkForwardResult }
  | { type: 'failed'; error: string }

export interface WorkerDeps {
  rest: ReplayRest
  budget: CallBudget
  logger: Logger
  databaseUrl: string
}

export interface WorkerRun<T> {
  readonly result: Promise<T>
  // Corta el worker en seco (al apagar el bot): lo que estaba escribiendo se revierte.
  terminate(): Promise<void>
}

// El worker terminó sin dar un resultado (lo cortaron o se cayó).
export class WorkerExited extends Error {
  constructor(code: number) {
    super(`El worker terminó sin resultado (código ${code})`)
  }
}

const ENTRY = new URL('./worker-entry.ts', import.meta.url).href

// El bot corre con tsx: el worker carga su entrada TypeScript con el mismo cargador.
function bootstrap(): string {
  const api = import.meta.resolve('tsx/esm/api')
  return `import(${JSON.stringify(api)}).then(({ tsImport }) => tsImport(${JSON.stringify(ENTRY)}, ${JSON.stringify(ENTRY)}))`
}

export function startWorker(deps: WorkerDeps, task: ReplayTask): WorkerRun<ReplayOutcome>
export function startWorker(deps: WorkerDeps, task: TuningTask): WorkerRun<WalkForwardResult>
export function startWorker(deps: WorkerDeps, task: WorkerTask): WorkerRun<ReplayOutcome | WalkForwardResult> {
  const input: WorkerInput = { task, databaseUrl: deps.databaseUrl, logLevel: deps.logger.level }
  const worker = new Worker(bootstrap(), { eval: true, workerData: input })
  const logger = deps.logger.child({ worker: task.kind })
  const result = new Promise<ReplayOutcome | WalkForwardResult>((resolve, reject) => {
    worker.on('message', (message: unknown) => {
      if (isRpcRequest(message)) {
        serveRpc(worker, deps, message).catch((error: unknown) => logger.error({ err: errorMessage(error) }, 'Worker: no pude responderle un pedido'))
        return
      }
      const m = message as WorkerMessage
      if (m.type === 'log') relog(logger, m.line)
      else if (m.type === 'done') resolve(m.result)
      else reject(new Error(m.error))
    })
    worker.on('error', reject)
    worker.on('exit', (code) => reject(new WorkerExited(code)))
  })
  return {
    result,
    terminate: async () => {
      await worker.terminate()
    },
  }
}

const LEVELS: Record<number, 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }

// Una línea de pino del worker, escrita por el logger del principal. Corre en el listener
// de mensajes: una línea ilegible queda como aviso en vez de tirar y tumbar al proceso.
export function relog(logger: Logger, line: string): void {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    entry = null
  }
  if (typeof entry !== 'object' || entry === null) {
    logger.warn({ line }, 'Worker: línea de log ilegible')
    return
  }
  const { level, msg, time: _time, ...fields } = entry as { level?: number; msg?: string; time?: number }
  logger[LEVELS[level ?? 30] ?? 'info'](fields, msg ?? '')
}
