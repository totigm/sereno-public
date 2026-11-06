// Recorre `items` con a lo sumo `concurrency` tareas en vuelo, en orden de salida. Ante
// el primer error deja de largar tareas, espera a las que ya salieron (para no dejar
// escrituras a medias corriendo detrás del rechazo) y lo propaga.
export async function forEachLimit<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`forEachLimit: concurrencia ${concurrency} inválida`)
  let next = 0
  const errors: unknown[] = []
  const worker = async (): Promise<void> => {
    while (errors.length === 0 && next < items.length) {
      const item = items[next++] as T
      try {
        await fn(item)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  if (errors.length > 0) throw errors[0]
}
