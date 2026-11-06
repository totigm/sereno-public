import type { BinanceEnv } from '@sereno/shared'
import { formatList, formatNumber } from './format'

// Las frases de la plata real que fija el diseño (spec real §Capital, tope e interruptor
// y §Cómo se prende), en un solo lugar: las dicen la pantalla y las acciones.

export const LOSS_FLOOR_TEXT = 'Apagada por el tope de pérdida. Para seguir, empezá una sesión nueva con un capital nuevo.'

export const TURN_OFF_TEXT = 'Cierro todas las posiciones del bot a mercado, cancelo sus órdenes y dejo de operar. Las tuyas no las toco.'

export const LOSS_CAP_NOTICE =
  'El tope se cuida con stops. Si el precio salta de golpe más allá de un stop, la pérdida puede pasar un poco el tope; el margen aislado la limita a lo que puso cada posición.'

export const UNGUARDED_TEXT =
  'El bot no puede hablar con Binance: lo único que protege tus posiciones son los stops y take profit que ya están puestos allá.'

export const STALE_TEXT = 'Hace más de 15 minutos que el bot no revisa: los chequeos pueden estar viejos.'

// Las etiquetas del gate llegan del bot tal cual ("las claves de operación"): el verbo
// concuerda con la primera, que es la que va pegada a él.
const PLURAL = /^(los|las|unos|unas)\s/i

/** "Apagada: falta X" (spec real), con "faltan" si lo que falta es plural. */
export function offMissingText(missing: readonly string[]): string {
  const verb = PLURAL.test(missing[0] ?? '') ? 'faltan' : 'falta'
  return `Apagada: ${verb} ${formatList(missing)}`
}

export const ENV_LABEL: Record<BinanceEnv, string> = { testnet: 'Testnet', mainnet: 'Binance real' }

/** El monto como se escribe para confirmar: "50", "1.250,50". */
export function capitalText(capital: number): string {
  return formatNumber(capital, Number.isInteger(capital) ? 0 : 2)
}

export function confirmText(capital: number): string {
  const amount = capitalText(capital)
  return `Escribí ${amount} para confirmar que vas a operar con US$ ${amount} de verdad.`
}
