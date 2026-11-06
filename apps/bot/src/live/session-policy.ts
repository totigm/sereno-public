// Lo que cambia entre la sesión en papel y la real dentro del mismo `LiveSession`. La de papel
// es la dueña de los datos compartidos: consulta los de futuros, muestrea spreads, guarda las
// velas y limpia la base. La real lee lo que guarda la de papel y no escribe nada de mercado.
//
// `afterGap`: qué pasa con las abiertas después de un hueco (un corte del stream, un
// reinicio). En papel el motor las reevalúa (un stop que quedó atrás cierra como no ejecutado
// por el bot sin conexión); en la real Binance ya resolvió sus stops, así que sólo reciben el
// precio. `marketFunding`: en papel el funding sale del stream y del historial de REST; en la
// real, de lo que Binance cobró (`FundingCollector`).

export interface SessionPolicy {
  kind: 'paper' | 'real'
  pollFutures: boolean
  sampleSpreads: boolean
  persistCandles: boolean
  cleanup: boolean
  afterGap: 'engine_reconcile' | 'mark_ticks'
  marketFunding: boolean
}

export const PAPER_POLICY: SessionPolicy = {
  kind: 'paper',
  pollFutures: true,
  sampleSpreads: true,
  persistCandles: true,
  cleanup: true,
  afterGap: 'engine_reconcile',
  marketFunding: true,
}

export const REAL_POLICY: SessionPolicy = {
  kind: 'real',
  pollFutures: false,
  sampleSpreads: false,
  persistCandles: false,
  cleanup: false,
  afterGap: 'mark_ticks',
  marketFunding: false,
}
