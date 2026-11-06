import { Writable } from 'node:stream'

// Destino de pino que guarda las líneas JSON para inspeccionarlas en un test.
export function logSink(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  return { stream, lines: () => chunks.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }
}
