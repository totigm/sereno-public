// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { offMissingText } from '@/lib/real-copy'

// "apagada: falta X" (spec real): el verbo concuerda con lo que falta, tal como lo escribe
// el gate del bot ("las claves de operación" es plural; "prenderla en Ajustes", no).
describe('offMissingText', () => {
  it('con una sola cosa en singular dice "falta"', () => {
    expect(offMissingText(['prenderla en Ajustes'])).toBe('Apagada: falta prenderla en Ajustes')
    expect(offMissingText(['una sesión nueva (tocó el tope de pérdida)'])).toBe('Apagada: falta una sesión nueva (tocó el tope de pérdida)')
  })

  it('con algo en plural dice "faltan"', () => {
    expect(offMissingText(['las claves de operación'])).toBe('Apagada: faltan las claves de operación')
    expect(offMissingText(['Los chequeos'])).toBe('Apagada: faltan Los chequeos')
  })

  it('con varias cosas las junta y concuerda con la primera', () => {
    expect(offMissingText(['SERENO_REAL_TRADING=on', 'prenderla en Ajustes'])).toBe('Apagada: falta SERENO_REAL_TRADING=on y prenderla en Ajustes')
  })
})
