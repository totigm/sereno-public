import type { ChipTone } from '@/components/ui/chip'
import { isPausedByShield } from '@/lib/derive'
import { formatPct, formatTimeBA } from '@/lib/format'
import type { LivePayload } from '@/lib/live/types'
import { offMissingText } from '@/lib/real-copy'
import { sinceClock } from './clock-labels'

export interface StatusChip {
  key: string
  text: string
  tone: ChipTone
  /** Estados que cambian solos (en vivo, calentando, sin conexión) llevan punto. */
  dot: boolean
}

type StatusInput = Pick<LivePayload, 'offline' | 'botStatus' | 'settings' | 'now' | 'realStatus'> & {
  ledger: Pick<LivePayload['ledger'], 'protegido'>
}

function chip(key: string, text: string, tone: ChipTone = 'muted', dot = false): StatusChip {
  return { key, text, tone, dot }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** La pausa vive en los ajustes, no en el bot: vale también con el bot sin conexión. */
function pauseChip(live: StatusInput): StatusChip | null {
  const pause = live.settings?.pause
  if (!pause?.paused) return null
  if (pause.by === 'user') {
    const since = pause.at === null ? '' : ` desde ${sinceClock(Date.parse(pause.at), live.now)}`
    return chip('pause', `Pausado por vos${since}`)
  }
  if (live.botStatus?.flags.drawdownPause) {
    const limit = live.settings?.risk.maxDrawdown
    return chip('pause', limit === undefined ? 'Pausado solo: drawdown máximo' : `Pausado solo: drawdown del ${formatPct(limit, 0, false)}`)
  }
  if (isPausedByShield(live)) return chip('pause', 'Pausado solo: capital blindado')
  return chip('pause', 'Pausado solo')
}

/**
 * La sesión real que no puede abrir: "Apagada: falta X" (spec real, "apagada: falta X").
 * Sin claves nada la protege salvo los stops ya puestos en Binance: va en rojo.
 */
// La base manda sobre el latido: apagarla (a mano o por el tope) vale en el acto, aunque
// el bot todavía no lo haya tomado.
function realOffChip(live: StatusInput): StatusChip | null {
  if (live.realStatus === 'loss_floor') return chip('phase', 'Apagada por el tope de pérdida')
  const gate = live.botStatus?.real
  if (gate && gate.mode !== 'trading') {
    const text = gate.missing.length === 0 ? 'Apagada' : offMissingText(gate.missing)
    return chip('phase', text, gate.mode === 'unguarded' ? 'loss' : 'muted')
  }
  return live.realStatus === 'off' ? chip('phase', 'Apagada') : null
}

function phaseChip(live: StatusInput): StatusChip | null {
  const bot = live.botStatus
  if (!bot) return null
  const realOff = realOffChip(live)
  if (realOff) return realOff
  switch (bot.phase) {
    case 'starting':
      return chip('phase', 'Arrancando', 'muted', true)
    case 'warming':
      return chip('phase', `Calentando · ${bot.warmProgress} de ${plural(bot.universeSize, 'moneda', 'monedas')}`, 'muted', true)
    case 'waiting_lease':
      return chip('phase', 'Esperando el turno (otra instancia tiene el control)')
    case 'paused':
      return chip('phase', 'Pausado')
    case 'off':
      return chip('phase', 'Apagada')
    case 'live':
      return chip('phase', bot.lastCycleAt === null ? 'En vivo' : `En vivo · último ciclo ${formatTimeBA(bot.lastCycleAt)}`, 'gain', true)
  }
}

/** Avisos que el bot reporta en su latido (spec §11.1); con el bot caído pueden estar viejos. */
function botNotices(live: StatusInput): StatusChip[] {
  const bot = live.botStatus
  if (!bot) return []
  const risk = live.settings?.risk
  const out: StatusChip[] = []
  if (bot.flags.btcVolExtreme) out.push(chip('btc-vol', 'BTC muy volátil: opera con la mitad del tamaño'))
  if (bot.flags.dailyLossHit) out.push(chip('daily-loss', 'Pérdida diaria alcanzada: sin entradas hasta mañana', 'loss'))
  if (bot.flags.streakPause) {
    out.push(
      chip(
        'streak',
        risk ? `${risk.maxConsecutiveStops} stops seguidos: sin entradas por ${plural(risk.streakPauseHours, 'hora', 'horas')}` : 'Racha de stops: sin entradas por un rato',
      ),
    )
  }
  const degraded = bot.degradedSymbols.length
  if (degraded > 0) out.push(chip('degraded', `${plural(degraded, 'moneda', 'monedas')} sin datos`))
  return out
}

/**
 * Los chips de estado del bot, el principal primero (spec §11.1): "En vivo · último
 * ciclo 14:32", "Pausado por vos desde las 13:10", "Calentando · 18 de 30 monedas"…
 * Sin conexión se dice eso y lo que está en los ajustes; lo que el bot contó antes
 * de caerse no se repite como si siguiera vigente.
 */
export function botStatusChips(live: StatusInput): StatusChip[] {
  const pause = pauseChip(live)
  const frozen = live.settings?.learning.frozen === true || live.botStatus?.flags.learningFrozen === true

  if (live.offline) {
    const lastBeat = live.botStatus?.lastHeartbeat
    const head =
      lastBeat === undefined
        ? chip('offline', 'El bot todavía no se conectó', 'muted', true)
        : chip('offline', `Sin conexión desde ${sinceClock(lastBeat, live.now)}`, 'muted', true)
    const fromSettings = live.settings?.learning.frozen ? [chip('frozen', 'Aprendizaje congelado', 'info')] : []
    return [head, ...(pause ? [pause] : []), ...fromSettings]
  }

  const head = pause ?? phaseChip(live)
  return [...(head ? [head] : []), ...(frozen ? [chip('frozen', 'Aprendizaje congelado', 'info')] : []), ...botNotices(live)]
}
