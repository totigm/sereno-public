// Ids de cliente de las órdenes de la sesión real: `sereno-<sesión corta>-<tipo><hora><n>`,
// con la hora y el contador en base 36. Van en `newClientOrderId` (mercado) y `clientAlgoId`
// (stops y take profits); Binance acepta hasta 36 caracteres de `[.A-Z:/a-z0-9_-]` y acá son
// 25 más los dígitos del contador (la hora en base 36 tiene 8 caracteres hasta 2059).
// Con esto se reconoce en Binance qué es de la sesión; qué posición es del bot lo decide la base.

// o abrir · c cerrar · s stop · t take profit · x interruptor (cerrar todo y apagar).
export type ClientKind = 'o' | 'c' | 's' | 't' | 'x'

const SESSION_ID = /^ses_([0-9a-f]{8})-[0-9a-f]{4}-/i
const CLIENT_ID = /^sereno-([0-9a-f]{8})-([octsx])[0-9a-z]+$/

export function sessionShort(sessionId: string): string {
  const match = SESSION_ID.exec(sessionId)
  if (!match) throw new Error(`"${sessionId}" no es un id de sesión (ses_<uuid>)`)
  return match[1]!.toLowerCase()
}

export class ClientIds {
  readonly short: string
  private seq = 0

  constructor(
    sessionId: string,
    private readonly now: () => number,
  ) {
    this.short = sessionShort(sessionId)
  }

  // La hora separa los reinicios; el contador, dos ids del mismo milisegundo.
  next(kind: ClientKind): string {
    return `sereno-${this.short}-${kind}${this.now().toString(36)}${(this.seq++).toString(36)}`
  }
}

export function parseClientId(id: string): { short: string; kind: ClientKind } | null {
  const match = CLIENT_ID.exec(id)
  if (!match) return null
  return { short: match[1]!, kind: match[2] as ClientKind }
}
