import clsx from 'clsx'
import { formatTimeBA, formatUsd } from '@/lib/format'
import type { OpenPositionView } from '@/lib/live/types'
import type { StatsView } from '@/lib/queries/stats'
import { formatResult } from './format'
import type { TradeScope } from './trade-model'

// Por debajo de medio centavo, "en cero": el formato redondearía a US$ 0,00 con signo.
const ZERO = 0.005

const abiertas = (n: number) => `${n} ${n === 1 ? 'abierta' : 'abiertas'}`

interface Phrase {
  before: string
  amount: number | null
  after: string
}

/** El titular: cuántas abiertas hay y cuánto van (spec §11.1, en presente o en pasado). */
export function headlinePhrase(open: readonly OpenPositionView[], scope: TradeScope): Phrase {
  const n = open.length
  const values = open.map((p) => p.valuation.net)
  const priced = values.every((v) => v !== null)
  const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0)
  const many = n !== 1
  if (!scope.active) {
    if (n === 0) return { before: 'Terminó sin operaciones abiertas.', amount: null, after: '' }
    if (!priced) return { before: `Terminó con ${abiertas(n)}.`, amount: null, after: '' }
    if (Math.abs(total) < ZERO) return { before: `Terminó con ${abiertas(n)}, en cero.`, amount: null, after: '' }
    return { before: `Terminó con ${abiertas(n)}, que ${many ? 'iban' : 'iba'} ${total > 0 ? 'ganando' : 'perdiendo'} `, amount: total, after: '.' }
  }
  if (n === 0) return { before: 'Ninguna operación abierta ahora.', amount: null, after: '' }
  if (!priced) return { before: `${abiertas(n)}; alguna no tiene precio para valuarla.`, amount: null, after: '' }
  const when = scope.offline && scope.pricesAt !== null ? `a las ${formatTimeBA(scope.pricesAt)} ` : ''
  if (Math.abs(total) < ZERO) return { before: `${abiertas(n)}, ${when}${many ? 'están' : 'está'} en cero.`, amount: null, after: '' }
  const verb = when === '' ? (many ? 'van' : 'va') : many ? 'iban' : 'iba'
  return { before: `${abiertas(n)}, ${when}${verb} ${total > 0 ? 'ganando' : 'perdiendo'} `, amount: total, after: '.' }
}

/** "23 cerradas, 14 ganadas · cerrado +US$ 57,51". */
export function closedLine(stats: StatsView): string {
  if (stats.trades === 0) return 'Todavía no se cerró ninguna operación.'
  const realized = Object.values(stats.bySymbol).reduce((sum, s) => sum + s.pnlNet, 0)
  const cerradas = `${stats.trades} ${stats.trades === 1 ? 'cerrada' : 'cerradas'}`
  return `${cerradas}, ${stats.wins} ${stats.wins === 1 ? 'ganada' : 'ganadas'} · cerrado ${formatResult(realized)}`
}

export function PosicionesHeadline({ open, scope, stats }: { open: readonly OpenPositionView[]; scope: TradeScope; stats: StatsView }) {
  const phrase = headlinePhrase(open, scope)
  const stale = scope.offline
  const tone = phrase.amount === null || stale ? 'text-muted' : phrase.amount > 0 ? 'text-gain' : 'text-loss'
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="headline">
        {phrase.before}
        {phrase.amount !== null && <span className={clsx('font-semibold', tone)}>{formatUsd(Math.abs(phrase.amount))}</span>}
        {phrase.after}
      </h1>
      <p className="text-muted">{closedLine(stats)}</p>
    </div>
  )
}
