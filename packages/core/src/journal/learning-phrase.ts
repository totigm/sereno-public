import { MINUS } from '@sereno/shared'
import type { LearningChange } from '../learning/state'
import { SIGNAL_IDS, type SignalId } from '../types'
import { withCoinNames } from './coin-name'
import { SIGNAL_NAMES } from './reasons'

// Los mensajes de aprendizaje se arman con ids de señal, símbolos de contrato y
// `toFixed` (son también el registro técnico de `learning_log`); el diario los
// muestra con nombres en castellano, el nombre de la moneda y el menos tipográfico.

const ID = `(?:${SIGNAL_IDS.join('|')})`
// Una sola pasada: los nombres ya puestos contienen ids ("el momentum", "el funding")
// y una segunda pasada los volvería a reemplazar.
//  · "subí trendHigher, funding" (weights.ts): la lista de pesos que se movieron.
//  · cualquier otro id, con la preposición que lo precede para contraer "de el".
const SIGNAL_REFERENCE = new RegExp(`\\b(?:(subí|bajé) (${ID}(?:, ${ID})*)|(?:(de|a) )?(${ID}))\\b`, 'g')
const ASCII_MINUS = /(^|[\s(])-(?=\d)/g

type Preposition = 'de' | 'a'
const CONTRACTED: Record<Preposition, string> = { de: 'del', a: 'al' }

function named(prep: Preposition, id: SignalId): string {
  const name = SIGNAL_NAMES[id]
  return name.startsWith('el ') ? `${CONTRACTED[prep]} ${name.slice('el '.length)}` : `${prep} ${name}`
}

// "de la tendencia mayor, del funding y de las bandas".
function namedList(ids: string): string {
  const items = ids.split(', ').map((id) => named('de', id as SignalId))
  const last = items.pop()
  return items.length === 0 ? `${last}` : `${items.join(', ')} y ${last}`
}

// Cada coincidencia trae o bien verbo y lista, o bien el id (con o sin preposición).
function replaceReference(_match: string, verb: string, list: string | undefined, prep: Preposition | undefined, id: SignalId): string {
  if (list !== undefined) return `${verb} el peso ${namedList(list)}`
  return prep === undefined ? SIGNAL_NAMES[id] : named(prep, id)
}

export function phraseLearning(change: LearningChange): string {
  const text = change.message.replace(SIGNAL_REFERENCE, replaceReference).replace(ASCII_MINUS, `$1${MINUS}`)
  return withCoinNames(text)
}
