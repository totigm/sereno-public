// Llamadas del worker al proceso principal por el canal del worker. El cliente REST y el
// presupuesto de llamadas son uno por proceso (spec §3 y §12): el worker no tiene los
// suyos, pide por acá y así una descarga larga respeta los mismos límites que el vivo.
// Los errores de Binance cruzan con su clase: el worker decide igual que el vivo si un
// rechazo es de un símbolo (400) o de todos.

import type { MessagePort, Worker } from 'node:worker_threads'
import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from '../binance/errors'
import type { CallBudget } from '../jobs/budget'
import type { ReplayRest } from './download'

const REST_METHODS = [
  'exchangeInfo',
  'fundingInfo',
  'klines',
  'markPriceKlines',
  'fundingRate',
  'openInterestHist',
  'globalLongShortAccountRatio',
  'takerLongShortRatio',
] as const satisfies readonly (keyof ReplayRest)[]
const BUDGET_METHODS = ['acquire'] as const satisfies readonly (keyof CallBudget)[]

export interface RpcTargets {
  rest: ReplayRest
  budget: CallBudget
}

type Target = keyof RpcTargets
const ALLOWED: Record<Target, readonly string[]> = { rest: REST_METHODS, budget: BUDGET_METHODS }

export interface RpcRequest {
  type: 'rpc'
  id: number
  target: Target
  method: string
  args: unknown[]
}

interface SerializedError {
  name: string
  message: string
  status?: number
  code?: number | null
  path?: string
  retryAfterMs?: number | null
}

type RpcResponse = { type: 'rpc-result'; id: number; value: unknown } | { type: 'rpc-error'; id: number; error: SerializedError }

export function isRpcRequest(message: unknown): message is RpcRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'rpc'
}

// Lado principal: atiende un pedido del worker y le responde. No rechaza nunca: corre en el
// listener de mensajes del worker y un rechazo sin atender tumbaría al proceso en vivo.
export async function serveRpc(worker: Pick<Worker, 'postMessage'>, targets: RpcTargets, { id, target, method, args }: RpcRequest): Promise<void> {
  let response: RpcResponse
  try {
    if (!ALLOWED[target]?.includes(method)) throw new Error(`rpc: ${target}.${method} no está permitido`)
    const fn = (targets[target] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!
    response = { type: 'rpc-result', id, value: await fn.apply(targets[target], args) }
  } catch (error) {
    response = { type: 'rpc-error', id, error: serialize(error) }
  }
  try {
    worker.postMessage(response)
  } catch (error) {
    // Lo que devolvió no se puede clonar entre hilos (DataCloneError): el worker recibe el
    // error en vez de quedarse esperando la respuesta.
    worker.postMessage({ type: 'rpc-error', id, error: serialize(error) } satisfies RpcResponse)
  }
}

// Lado del worker: objetos con los mismos métodos que delegan en el proceso principal.
export class RpcClient {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(private readonly port: Pick<MessagePort, 'postMessage'>) {}

  readonly rest = this.remote<ReplayRest>('rest', REST_METHODS)
  readonly budget = this.remote<CallBudget>('budget', BUDGET_METHODS)

  // Entrega una respuesta del principal; devuelve si era una.
  receive(message: unknown): boolean {
    const response = message as RpcResponse
    if (response?.type !== 'rpc-result' && response?.type !== 'rpc-error') return false
    const call = this.pending.get(response.id)
    this.pending.delete(response.id)
    if (response.type === 'rpc-result') call?.resolve(response.value)
    else call?.reject(deserialize(response.error))
    return true
  }

  private remote<T>(target: Target, methods: readonly string[]): T {
    const call = (method: string, args: unknown[]): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = this.nextId++
        this.pending.set(id, { resolve, reject })
        const request: RpcRequest = { type: 'rpc', id, target, method, args }
        this.port.postMessage(request)
      })
    return Object.fromEntries(methods.map((method) => [method, (...args: unknown[]) => call(method, args)])) as T
  }
}

function serialize(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const out: SerializedError = { name: error.name, message: error.message }
  if (error instanceof BinanceHttpError || error instanceof BinanceGeoBlocked || error instanceof BinanceRateLimited) {
    Object.assign(out, { status: error.status, code: error.code, path: error.path })
  }
  if (error instanceof BinanceRateLimited) out.retryAfterMs = error.retryAfterMs
  if (error instanceof BinanceNetworkError) out.path = error.path
  return out
}

function deserialize(e: SerializedError): Error {
  const http = { status: e.status ?? 0, code: e.code ?? null, path: e.path ?? '' }
  switch (e.name) {
    case 'BinanceHttpError':
      return new BinanceHttpError(e.message, http)
    case 'BinanceGeoBlocked':
      return new BinanceGeoBlocked(e.message, http)
    case 'BinanceRateLimited':
      return new BinanceRateLimited(e.message, { ...http, retryAfterMs: e.retryAfterMs ?? null })
    case 'BinanceNetworkError':
      return new BinanceNetworkError(e.message, e.path ?? '')
    default:
      return new Error(e.message)
  }
}
