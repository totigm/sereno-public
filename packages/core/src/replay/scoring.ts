import type { Scorer } from '../engine/types'
import { combineComposite, compositeInputs, type CompositeInputs } from '../signals/composite'
import type { MarketView } from '../types'

// El puntaje de las corridas de un replay. Lo real, la sombra y cada combinación del
// ajuste de parámetros puntúan las mismas vistas (`ReplayMarket` arma una por moneda y por
// instante) con pesos distintos, y los pesos no cambian las señales: se calculan una vez
// por vista y se combinan con cada juego. Da lo mismo que `computeComposite`.
export function perViewScorer(): Scorer {
  const inputs = new WeakMap<MarketView, CompositeInputs>()
  return (view, weights) => {
    let found = inputs.get(view)
    if (!found) {
      found = compositeInputs(view)
      inputs.set(view, found)
    }
    return combineComposite(found, weights)
  }
}
