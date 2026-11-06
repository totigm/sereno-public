// Apagado ordenado del proceso (spec §12): SIGINT y SIGTERM lo disparan una sola vez (un
// segundo aviso mientras se apaga no lo repite) y la promesa se cumple cuando terminó.

export interface SignalSource {
  once(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
}

export function shutdownOnSignals(source: SignalSource, shutdown: (signal: NodeJS.Signals) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false
    const onSignal = (signal: NodeJS.Signals): void => {
      if (started) return
      started = true
      shutdown(signal).then(resolve, reject)
    }
    source.once('SIGINT', onSignal)
    source.once('SIGTERM', onSignal)
  })
}
