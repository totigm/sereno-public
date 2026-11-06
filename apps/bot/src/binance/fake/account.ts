// Los pedidos firmados del Binance falso (`USER_DATA`), verificados como Binance: la clave
// en `X-MBX-APIKEY`, la firma HMAC del query (lo que va antes de `&signature=`) y el
// `timestamp` dentro de `recvWindow` respecto del reloj del falso. La verificación la usan
// también las rutas de operación (`trading-routes.ts`), en GET, POST, PUT y DELETE.

import { signQuery } from '../signing'
import { COMMISSION_RATE, FAKE_API_KEY, FAKE_API_SECRET, KEY_REJECTED_ERROR, LEVERAGE_BRACKETS } from './account-fixtures'

export const SIGNED_PATHS: ReadonlySet<string> = new Set(['/fapi/v1/leverageBracket', '/fapi/v1/commissionRate'])

export interface FakeAccount {
  apiKey: string
  apiSecret: string
  // Modo "clave rechazada": todo pedido con la clave contesta este error.
  rejected: { status: number; code: number; msg: string } | null
}

export function defaultAccount(): FakeAccount {
  return { apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET, rejected: null }
}

export interface SignedRequest {
  path: string
  rawQuery: string
  apiKey: string | null
  now: number
}

export interface FakeAnswer {
  status: number
  body: unknown
  weight: number
}

export interface FakeRejection {
  status: number
  body: { code: number; msg: string }
}

const WEIGHT: Record<string, number> = { '/fapi/v1/leverageBracket': 1, '/fapi/v1/commissionRate': 20 }

const reject = (status: number, code: number, msg: string): FakeRejection => ({ status, body: { code, msg } })

// Pedidos `USER_STREAM` (listenKey): sólo la clave. null si pasa.
export function verifyApiKey(account: FakeAccount, apiKey: string | null): FakeRejection | null {
  if (account.rejected) return reject(account.rejected.status, account.rejected.code, account.rejected.msg)
  if (apiKey !== account.apiKey) return reject(401, KEY_REJECTED_ERROR.code, KEY_REJECTED_ERROR.msg)
  return null
}

// Pedidos `TRADE`/`USER_DATA`: clave, firma y ventana de tiempo. null si pasa.
export function verifySigned(account: FakeAccount, { rawQuery, apiKey, now }: Omit<SignedRequest, 'path'>): FakeRejection | null {
  const keyRejection = verifyApiKey(account, apiKey)
  if (keyRejection) return keyRejection
  const at = rawQuery.lastIndexOf('&signature=')
  const payload = at < 0 ? rawQuery : rawQuery.slice(0, at)
  if (at < 0 || rawQuery.slice(at + '&signature='.length) !== signQuery(payload, account.apiSecret)) {
    return reject(400, -1022, 'Signature for this request is not valid.')
  }
  const query = new URLSearchParams(payload)
  const timestamp = Number(query.get('timestamp'))
  const recvWindow = Number(query.get('recvWindow') ?? 5_000)
  if (!Number.isFinite(timestamp) || timestamp >= now + 1_000 || now - timestamp > recvWindow) {
    return reject(400, -1021, 'Timestamp for this request is outside of the recvWindow.')
  }
  return null
}

export function answerSigned(account: FakeAccount, { path, rawQuery, apiKey, now }: SignedRequest): FakeAnswer {
  const weight = WEIGHT[path] ?? 1
  const rejection = verifySigned(account, { rawQuery, apiKey, now })
  if (rejection) return { ...rejection, weight }

  if (path === '/fapi/v1/commissionRate') {
    const symbol = new URLSearchParams(rawQuery).get('symbol')
    if (!symbol) return { ...reject(400, -1102, "Mandatory parameter 'symbol' was not sent, was empty/null, or malformed."), weight }
    return { status: 200, body: { symbol, ...COMMISSION_RATE }, weight }
  }
  return { status: 200, body: LEVERAGE_BRACKETS, weight }
}
