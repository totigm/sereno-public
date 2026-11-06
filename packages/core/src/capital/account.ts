import type { AccountSnapshot, Position } from '../types'
import { EPSILON } from '../risk/epsilon'

export type OnShield = 'keep' | 'reduce' | 'closeAll'

export interface AccountInit {
  capitalInicial: number
  reinvest: boolean
  protectPct: number
  onShield: OnShield
  // Estado persistido para retomar una sesión; si falta, la cuenta arranca en I₀.
  saldo?: number
  protegido?: number
  baseBlindaje?: number
}

export interface ShieldCheck {
  triggered: boolean
  toClose: Position[]
  // Presente cuando el blindaje no se evaluó este ciclo: sin la marca de una abierta no
  // se sabe si pierde, y disparar es irreversible sin que Toti libere el capital.
  skipped?: { reason: 'missing_mark'; symbols: string[] }
}

export type ReleaseResult = { released: true } | { released: false; reason: 'not_shielded' | 'no_balance' }

// Precio de marca por símbolo, tal como lo tiene el motor en el ciclo actual.
export type Marks = Record<string, number>

// Estado de capital de una cartera (spec §7): saldo, blindaje del capital inicial y
// reinversión. Es puro: no lee reloj ni IO; el motor le pasa posiciones y marcas.
// La cartera sombra usa su propia instancia, así que acá no se filtra por `shadow`.
export class Account {
  readonly capitalInicial: number
  private saldo: number
  private protegido: number
  private baseBlindaje: number
  private reinvest: boolean
  private protectPct: number
  private onShield: OnShield

  constructor(init: AccountInit) {
    if (!(Number.isFinite(init.capitalInicial) && init.capitalInicial > 0)) {
      throw new RangeError(`capitalInicial debe ser positivo (recibido ${init.capitalInicial})`)
    }
    assertPct(init.protectPct)
    this.capitalInicial = init.capitalInicial
    this.saldo = init.saldo ?? init.capitalInicial
    this.protegido = init.protegido ?? 0
    this.baseBlindaje = init.baseBlindaje ?? init.capitalInicial
    assertRestored(this.saldo, this.protegido, this.baseBlindaje)
    this.reinvest = init.reinvest
    this.protectPct = init.protectPct
    this.onShield = init.onShield
  }

  // Resultado realizado (pnl de un cierre, comisión, funding). Un monto no finito
  // corrompería el saldo para siempre, por eso se rechaza en vez de ignorarse.
  applyRealized(amount: number): void {
    if (!Number.isFinite(amount)) throw new RangeError(`monto realizado no finito: ${amount}`)
    this.saldo += amount
  }

  setReinvest(value: boolean): void {
    this.reinvest = value
  }

  setProtectPct(value: number): void {
    assertPct(value)
    this.protectPct = value
  }

  setOnShield(value: OnShield): void {
    this.onShield = value
  }

  marginInUse(open: readonly Position[]): number {
    return open.reduce((sum, p) => sum + p.margin, 0)
  }

  // Una abierta sin marca no aporta no realizado (no se inventa un precio) y el snapshot
  // lo avisa con `marksIncomplete` para que el equity no se lea como exacto.
  snapshot(open: readonly Position[], marks: Marks): AccountSnapshot {
    const unrealized = open.reduce((sum, p) => sum + (unrealizedPnl(p, marks) ?? 0), 0)
    const margenEnUso = this.marginInUse(open)
    const capitalBase = this.capitalBase()
    const snapshot: AccountSnapshot = {
      capitalInicial: this.capitalInicial,
      saldo: this.saldo,
      equity: this.saldo + unrealized,
      protegido: this.protegido,
      baseBlindaje: this.baseBlindaje,
      capitalBase,
      capitalOperable: Math.max(0, capitalBase - margenEnUso),
      margenEnUso,
      realizado: this.saldo - this.capitalInicial,
      unrealized,
      reinvest: this.reinvest,
    }
    if (missingMarks(open, marks).length > 0) snapshot.marksIncomplete = true
    return snapshot
  }

  // Dispara cuando min(realizado, equity − baseBlindaje) ≥ p × baseBlindaje. "Realizado"
  // se mide desde que se fijó la base (I₀ al crear; el saldo al volver a usar el capital),
  // y como la base siempre se fija igual al saldo de ese momento, vale saldo − baseBlindaje.
  // Al disparar, `protegido` queda fijo en `baseBlindaje` hasta `releaseProtected()`.
  checkShield(open: readonly Position[], marks: Marks): ShieldCheck {
    if (this.protegido > 0 || this.protectPct <= 0) return { triggered: false, toClose: [] }
    const missing = missingMarks(open, marks)
    if (missing.length > 0) return { triggered: false, toClose: [], skipped: { reason: 'missing_mark', symbols: missing } }

    const realizado = this.saldo - this.baseBlindaje
    const unrealized = open.reduce((sum, p) => sum + (unrealizedPnl(p, marks) ?? 0), 0)
    const ganancia = Math.min(realizado, realizado + unrealized)
    if (ganancia + EPSILON < this.protectPct * this.baseBlindaje) return { triggered: false, toClose: [] }

    this.protegido = this.baseBlindaje
    return { triggered: true, toClose: this.positionsToClose(open, marks) }
  }

  // "Volver a usar el capital blindado" (spec §7). Sin blindaje activo re-basar bajaría el
  // umbral después de una pérdida, y con saldo ≤ 0 la base quedaría no positiva y el
  // disparo se cumpliría en cada ciclo: en esos casos no se toca nada.
  releaseProtected(): ReleaseResult {
    if (!(this.protegido > 0)) return { released: false, reason: 'not_shielded' }
    if (!(this.saldo > 0)) return { released: false, reason: 'no_balance' }
    this.protegido = 0
    this.baseBlindaje = this.saldo
    return { released: true }
  }

  // Con pérdidas después de blindar el saldo puede quedar por debajo de lo protegido:
  // no hay capital para operar, pero tampoco una base negativa.
  private capitalBase(): number {
    const disponible = Math.max(0, this.saldo - this.protegido)
    return this.reinvest ? disponible : Math.min(disponible, this.baseBlindaje)
  }

  private positionsToClose(open: readonly Position[], marks: Marks): Position[] {
    switch (this.onShield) {
      case 'keep':
        return []
      case 'closeAll':
        return [...open]
      case 'reduce':
        return reduceToCushion(open, marks, this.saldo - this.baseBlindaje)
    }
  }
}

// Cierra en orden de peor R vigente hasta que la suma de márgenes entre en el colchón
// (saldo − baseBlindaje), que es lo único que queda operable al blindar. Sólo se llama
// con todas las marcas presentes (`checkShield` no evalúa si falta alguna).
function reduceToCushion(open: readonly Position[], marks: Marks, cushion: number): Position[] {
  const byWorstR = [...open].sort((a, b) => currentNetR(a, marks) - currentNetR(b, marks))
  const toClose: Position[] = []
  let margin = open.reduce((sum, p) => sum + p.margin, 0)
  for (const p of byWorstR) {
    if (margin <= cushion) break
    toClose.push(p)
    margin -= p.margin
  }
  return toClose
}

function markOf(p: Position, marks: Marks): number | null {
  const mark = marks[p.symbol]
  return mark !== undefined && Number.isFinite(mark) && mark > 0 ? mark : null
}

function missingMarks(open: readonly Position[], marks: Marks): string[] {
  return [...new Set(open.filter((p) => markOf(p, marks) === null).map((p) => p.symbol))]
}

// No realizado bruto a la marca; `null` si no hay una marca válida para el símbolo.
function unrealizedPnl(p: Position, marks: Marks): number | null {
  const mark = markOf(p, marks)
  if (mark === null) return null
  return (mark - p.entryPrice) * p.qty * (p.side === 'long' ? 1 : -1)
}

// R vigente neto (spec §5.5: R = pnlNeto / riesgoReal): descuenta lo ya pagado en
// comisiones y funding de la posición.
function currentNetR(p: Position, marks: Marks): number {
  const r = ((unrealizedPnl(p, marks) ?? 0) - p.feesPaid - p.fundingPaid) / p.riesgoReal
  return Number.isFinite(r) ? r : 0
}

function assertPct(value: number): void {
  if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError(`protectPct debe estar entre 0 y 1 (recibido ${value})`)
  }
}

// Un NaN restaurado de la base corrompería todos los valores siguientes sin error visible.
function assertRestored(saldo: number, protegido: number, baseBlindaje: number): void {
  if (!Number.isFinite(saldo)) throw new RangeError(`saldo restaurado no finito: ${saldo}`)
  if (!(Number.isFinite(protegido) && protegido >= 0)) {
    throw new RangeError(`protegido restaurado debe ser finito y ≥ 0 (recibido ${protegido})`)
  }
  if (!(Number.isFinite(baseBlindaje) && baseBlindaje > 0)) {
    throw new RangeError(`baseBlindaje restaurada debe ser positiva (recibido ${baseBlindaje})`)
  }
}
