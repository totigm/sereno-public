// El id de un comando lo genera el navegador: es la clave de idempotencia de la cola
// (spec §10). `crypto.randomUUID` sólo existe en contexto seguro (HTTPS o localhost);
// abierto por http en la red local, se arma el mismo UUID v4 con `getRandomValues`.

const hex = (bytes: Uint8Array, from: number, to: number) =>
  Array.from(bytes.subarray(from, to), (b) => b.toString(16).padStart(2, '0')).join('')

export function newCommandId(): string {
  const { crypto } = globalThis
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40 // versión 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80 // variante RFC 9562
  return `${hex(bytes, 0, 4)}-${hex(bytes, 4, 6)}-${hex(bytes, 6, 8)}-${hex(bytes, 8, 10)}-${hex(bytes, 10, 16)}`
}
