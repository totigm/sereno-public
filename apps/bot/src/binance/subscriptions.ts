// Qué SUBSCRIBE/UNSUBSCRIBE le falta recibir a una conexión para llegar al conjunto
// deseado de símbolos. El stream no encola cada llamada a `subscribe`/`unsubscribe`:
// compara lo deseado con lo que la conexión ya tiene (los símbolos de su URL más lo que
// se le mandó). Así nada se pierde si la llamada llega durante un handshake (sale al
// abrir), un alta y una baja del mismo símbolo se anulan, y una conexión nueva arranca
// con el conjunto completo en la URL.

export interface ControlStep {
  method: 'SUBSCRIBE' | 'UNSUBSCRIBE'
  symbols: string[]
}

// Un mensaje por vez. Primero las bajas: la conexión nunca supera, ni por un instante,
// los streams del conjunto deseado (que ya respeta el tope de 1024).
export function nextControlStep(desired: ReadonlySet<string>, applied: ReadonlySet<string>): ControlStep | null {
  const removed = [...applied].filter((s) => !desired.has(s))
  if (removed.length > 0) return { method: 'UNSUBSCRIBE', symbols: removed }
  const added = [...desired].filter((s) => !applied.has(s))
  if (added.length > 0) return { method: 'SUBSCRIBE', symbols: added }
  return null
}
