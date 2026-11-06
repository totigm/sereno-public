import { describe, it, expect } from 'vitest'
import { REAL_CHECK_IDS, REAL_CHECK_LABELS, REAL_LOSS_CAP_DEFAULT, READINESS_STALE_MS } from '../src/real'

describe('vocabulario de plata real', () => {
  it('REAL_CHECK_LABELS tiene una etiqueta no vacía por cada chequeo', () => {
    expect(Object.keys(REAL_CHECK_LABELS).sort()).toEqual([...REAL_CHECK_IDS].sort())
    for (const id of REAL_CHECK_IDS) expect(REAL_CHECK_LABELS[id].trim()).not.toBe('')
  })
  it('tope por defecto del 50% y chequeos viejos a los 15 minutos', () => {
    expect(REAL_LOSS_CAP_DEFAULT).toBe(0.5)
    expect(READINESS_STALE_MS).toBe(15 * 60_000)
  })
})
