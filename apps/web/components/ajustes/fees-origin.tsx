'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { feesOriginText, type FeesOrigin as Origin } from '@/lib/fees-origin'

// Por contexto y no por props: Riesgo (avanzado) sólo monta la línea, y la pantalla le
// pasa el origen calculado sobre los ajustes que se están editando.
const FeesOriginContext = createContext<Origin | null>(null)

export function FeesOriginProvider({ origin, children }: { origin: Origin; children: ReactNode }) {
  return <FeesOriginContext.Provider value={origin}>{children}</FeesOriginContext.Provider>
}

/** De dónde salen el mmr y las comisiones: la cuenta de Binance, un cambio a mano o los supuestos. */
export function FeesOrigin() {
  const origin = useContext(FeesOriginContext)
  if (!origin) return null
  return <p className="text-sm text-muted">{feesOriginText(origin)}</p>
}
