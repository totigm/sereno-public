import type { Composite } from '@sereno/core'
import type { LearningChange } from '@sereno/core/src/learning/state'
import { coinName } from '@sereno/core/src/journal/coin-name'
import { phraseClose, phraseLearning, phraseStopMoved, phraseWait } from '@sereno/core/src/journal/phrases'
import type { ClosedPositionRecord, Db, DecisionRecord, LearningLogRecord, PositionRecord, RealEventKind, RealEventRecord, Repos, SettingsHistoryRow } from '@sereno/db'
import { ACCOUNT_TIERS_AUTHOR, ACCOUNT_TIERS_PHRASE, formatUsd, startOfDayBA } from '@sereno/shared'
import { decisionCycles, positionEventsIn, type WindowEvent } from './sql/activity'

// "Lo último que hizo" de Resumen (spec §11.1): aperturas, cierres, stops movidos,
// funding relevante, pausas, aprendizaje, liquidaciones, "esperé" y el mmr y las
// comisiones traídos de la cuenta de Binance. Todo sale de lo que el bot ya guardó; las
// frases son las del diario de core salvo funding, pausas y la cuenta, que no tienen
// frase propia en el motor. En la sesión con plata real, además, lo que pasó con Binance
// (`real_events`) y qué números informó Binance (`reported` en los eventos de la posición).

export type JournalKind =
  | 'open'
  | 'close'
  | 'liquidation'
  | 'stop_missed'
  | 'stop_moved'
  | 'funding'
  | 'pause'
  | 'resume'
  | 'learning'
  | 'waited'
  | 'tiers'
  | 'real'

export interface JournalEntry {
  /** Único en el diario (`<tipo>:<id de origen>`), para las keys de React. */
  id: string
  at: number
  kind: JournalKind
  text: string
  symbol: string | null
  positionId: string | null
  /** Resultado neto de un cierre. */
  pnl: number | null
  /** Liquidaciones, stops no ejecutados por el bot sin conexión y los avisos graves de Binance: van destacados. */
  highlight: boolean
  /** Precio, cantidad, comisión o funding son los que informó Binance, no los de la simulación. */
  reported: boolean
}

export interface JournalView {
  /** Desde cuándo cuenta el tramo: las 00:00 (Buenos Aires) de ayer. */
  from: number
  to: number
  summary: {
    trades: number
    won: number
    pnl: number
    /** Cierres de vela evaluados y monedas miradas ("Miré 30 monedas 32 veces"). */
    cycles: number
    coins: number
    liquidations: number
  }
  /** Lo más nuevo primero; "Ver todo" agrupa por día. */
  entries: JournalEntry[]
}

const DAY_MS = 86_400_000
const MAX_ENTRIES = 200
// Funding "relevante": más del 0,1% del margen de la posición (spec §11.1).
const FUNDING_RELEVANT = 0.001
// "Esperé" sólo cuando |S'| ≥ θ − 0,1 (spec §11.1).
const WAIT_MARGIN = 0.1
// Lo de Binance que no puede pasar desapercibido: una posición que quedó sin stop, el tope,
// un error que la apagó, una posición ajena y una diferencia que se corrigió.
const HIGHLIGHTED: ReadonlySet<RealEventKind> = new Set(['unprotected', 'loss_floor', 'fatal', 'foreign_position', 'reconciled'])

export interface JournalInput {
  sessionId: string
  /** Ahora, o el final de una sesión terminada. */
  anchor: number
  /** θ vigente (el aprendido si hay estado de aprendizaje). */
  theta: number
  /** La sesión opera con plata real: suma lo que pasó con Binance y de dónde salen los números. */
  real: boolean
}

export async function loadJournal(db: Db, repos: Repos, { sessionId, anchor, theta, real }: JournalInput): Promise<JournalView> {
  const from = startOfDayBA(anchor) - DAY_MS
  const to = anchor + 1
  const [closed, open, events, log, history, waits, cycles, fills, realEvents] = await Promise.all([
    repos.positions.listClosed(sessionId, { from, to }),
    repos.positions.listOpen(sessionId),
    positionEventsIn(db, sessionId, from, to, ['stop_moved', 'funding']),
    repos.learning.listLog(sessionId, { limit: MAX_ENTRIES }),
    repos.settings.history(sessionId, MAX_ENTRIES),
    repos.decisions.listJournalCandidates(sessionId, { from, to, minAbsSPrime: theta - WAIT_MARGIN, limit: MAX_ENTRIES }),
    decisionCycles(db, sessionId, from, to),
    real ? positionEventsIn(db, sessionId, from, to, ['open', 'close', 'liquidation']) : [],
    real ? repos.realEvents.list(sessionId, { from, to }) : [],
  ])
  const inWindow = (at: number) => at >= from && at < to
  // Un evento del tramo es de una posición abierta entonces: sigue abierta o cerró dentro del tramo.
  const byId = new Map<string, PositionRecord>([...open, ...closed.items].map((p) => [p.id, p]))
  // Qué aperturas y cierres trajeron los números de Binance, por posición.
  const reported = new Set(fills.filter(isReported).map((e) => `${e.kind === 'open' ? 'open' : 'close'}:${e.positionId}`))
  const withSource = (e: JournalEntry): JournalEntry => (reported.has(e.id) ? { ...e, reported: true } : e)

  const entries: JournalEntry[] = [
    ...[...open, ...closed.items].filter((p) => inWindow(p.openedAt)).map(openEntry).map(withSource),
    ...closed.items.map(closeEntry).map(withSource),
    ...events.flatMap((e) => eventEntry(e, byId.get(e.positionId))),
    ...realEvents.map(realEntry),
    ...log.filter((l) => inWindow(l.at)).map(learningEntry),
    ...pauseEntries(history).filter((e) => inWindow(e.at)),
    ...tiersEntries(history).filter((e) => inWindow(e.at)),
    ...waits.flatMap(waitEntry),
  ]
  entries.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))

  return {
    from,
    to: anchor,
    summary: {
      trades: closed.items.length,
      won: closed.items.filter((c) => c.pnlNet > 0).length,
      pnl: closed.items.reduce((sum, c) => sum + c.pnlNet, 0),
      cycles: cycles.cycles,
      coins: cycles.coins,
      liquidations: closed.items.filter((c) => c.closeReason === 'liquidation').length,
    },
    entries: entries.slice(0, MAX_ENTRIES),
  }
}

function entry(e: Omit<JournalEntry, 'symbol' | 'positionId' | 'pnl' | 'highlight' | 'reported'> & Partial<JournalEntry>): JournalEntry {
  return { symbol: null, positionId: null, pnl: null, highlight: false, reported: false, ...e }
}

const isReported = (e: { payload: Record<string, unknown> }): boolean => e.payload.reported === true

function realEntry(e: RealEventRecord): JournalEntry {
  return entry({ id: `real:${e.id}`, at: e.at, kind: 'real', text: e.phrase, symbol: e.symbol, highlight: HIGHLIGHTED.has(e.kind) })
}

function openEntry(p: PositionRecord): JournalEntry {
  return entry({ id: `open:${p.id}`, at: p.openedAt, kind: 'open', text: p.openReason, symbol: p.symbol, positionId: p.id })
}

function closeEntry(c: ClosedPositionRecord): JournalEntry {
  const kind: JournalKind =
    c.closeReason === 'liquidation' ? 'liquidation' : c.closeReason === 'stop_missed_offline' ? 'stop_missed' : 'close'
  return entry({
    id: `close:${c.id}`,
    at: c.closedAt,
    kind,
    text: c.closePhrase ?? phraseClose(c),
    symbol: c.symbol,
    positionId: c.id,
    pnl: c.pnlNet,
    highlight: kind !== 'close',
  })
}

const numberIn = (payload: Record<string, unknown>, key: string): number | null => {
  const v = payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function eventEntry(e: WindowEvent, p: PositionRecord | undefined): JournalEntry[] {
  const base = { at: e.at, symbol: e.symbol, positionId: e.positionId }
  if (e.kind === 'stop_moved') {
    const phrase = typeof e.payload.phrase === 'string' ? e.payload.phrase : null
    const from = numberIn(e.payload, 'from')
    const to = numberIn(e.payload, 'to')
    // El motor manda la frase con el evento; si no vino, se arma con los precios.
    const text = phrase ?? (p && from !== null && to !== null ? phraseStopMoved(p, from, to) : null)
    return text === null ? [] : [entry({ ...base, id: `stop:${e.id}`, kind: 'stop_moved', text })]
  }
  // `amount > 0` es funding pagado, como `fundingPaid`.
  const amount = numberIn(e.payload, 'amount')
  if (amount === null || Math.abs(amount) <= FUNDING_RELEVANT * e.margin) return []
  const verb = amount > 0 ? 'Pagué' : 'Cobré'
  const text = `${verb} ${formatUsd(Math.abs(amount))} de funding por el ${e.side} en ${coinName(e.symbol)}.`
  return [entry({ ...base, id: `funding:${e.id}`, kind: 'funding', text, reported: isReported(e) })]
}

function learningEntry(l: LearningLogRecord): JournalEntry {
  return entry({
    id: `learning:${l.id}`,
    at: l.at,
    kind: 'learning',
    // La frase sólo reescribe el mensaje; `kind` llega de la base como texto libre.
    text: phraseLearning(l as LearningChange),
    symbol: l.symbol,
  })
}

// Las pausas viven en `settings.pause` (spec §7): cada versión que cambia `paused`
// es una pausa o una reanudación.
function pauseEntries(history: SettingsHistoryRow[]): JournalEntry[] {
  const ascending = [...history].sort((a, b) => a.version - b.version)
  const out: JournalEntry[] = []
  for (let i = 1; i < ascending.length; i++) {
    const prev = ascending[i - 1]
    const row = ascending[i]
    if (!prev || !row || prev.config.pause.paused === row.config.pause.paused) continue
    const { pause } = row.config
    const text = pause.paused
      ? pause.by === 'auto'
        ? (pause.reason ?? 'Me pausé solo. Sigo cuidando las abiertas.')
        : 'Me pausaste: no abro nada nuevo y sigo cuidando las abiertas.'
      : 'Me reanudaste: vuelvo a buscar entradas.'
    out.push(entry({ id: `pause:${row.version}`, at: row.changedAt.getTime(), kind: pause.paused ? 'pause' : 'resume', text }))
  }
  return out
}

// Cada versión que guardó el bot con el mmr y las comisiones de la cuenta (job `accountTiers`).
function tiersEntries(history: SettingsHistoryRow[]): JournalEntry[] {
  return history
    .filter((row) => row.changedBy === ACCOUNT_TIERS_AUTHOR)
    .map((row) => entry({ id: `tiers:${row.version}`, at: row.changedAt.getTime(), kind: 'tiers', text: ACCOUNT_TIERS_PHRASE }))
}

function waitEntry(d: DecisionRecord): JournalEntry[] {
  if (d.blockedBy === null) return []
  // `phraseWait` sólo mira `Sprime` cuando no le pasan el lado; acá se le pasa.
  const side = d.sPrime >= 0 ? 'long' : 'short'
  const text = phraseWait(d.symbol, d.blockedBy, { Sprime: d.sPrime } as Composite, side)
  return [entry({ id: `waited:${d.id}`, at: d.candleCloseTime, kind: 'waited', text, symbol: d.symbol })]
}
