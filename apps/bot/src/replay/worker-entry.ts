// El hilo del worker: corre un replay o el walk-forward semanal con su propio pool de la
// base, y pide REST y presupuesto al proceso principal (`rpc.ts`). Los logs viajan como
// líneas de pino y los escribe el logger del principal.
//
// Un pool de `pg` no cruza entre hilos, así que cada worker abre el suyo, de una sola
// conexión: todo lo que escribe va en serie (un día por transacción) y lo que lee mientras
// descarga espera su turno detrás de Binance. El proceso del bot llega así a 6 conexiones
// directas como mucho (las 4 del vivo, una del replay en curso y una del ajuste semanal si
// coinciden), dos más que las 4 de la spec §10: la alternativa era pasar cada consulta del
// worker por el hilo principal, que es justo lo que el worker evita.

import { parentPort, workerData } from 'node:worker_threads'
import { createDirectDb, createRepos } from '@sereno/db'
import pino from 'pino'
import { errorMessage } from '../jobs/errors'
import { RpcClient } from './rpc'
import { runReplaySession } from './run'
import { computeTuning } from './tuning'
import type { WorkerInput, WorkerMessage } from './worker'

const port = parentPort
if (!port) throw new Error('worker-entry corre sólo dentro de un worker')
const { task, databaseUrl, logLevel } = workerData as WorkerInput
const post = (message: WorkerMessage): void => port.postMessage(message)
const client = new RpcClient(port)
const onMessage = (message: unknown): void => {
  client.receive(message)
}
port.on('message', onMessage)
const logger = pino({ level: logLevel, base: null }, { write: (line: string) => post({ type: 'log', line }) })
const db = createDirectDb(databaseUrl, { max: 1 })
const deps = { rest: client.rest, budget: client.budget, logger }

try {
  const result = task.kind === 'replay' ? await runReplaySession({ ...deps, db, now: () => task.now }, task.sessionId) : await computeTuning({ ...deps, repos: createRepos(db) }, task)
  post({ type: 'done', result })
} catch (error) {
  post({ type: 'failed', error: errorMessage(error) })
} finally {
  await db.$client.end()
  port.off('message', onMessage)
}
