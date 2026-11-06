import { describe, expect, it } from 'vitest'
import { safeReturnPath } from '@/lib/return-path'

describe('safeReturnPath', () => {
  it('conserva una ruta interna con su query', () => {
    expect(safeReturnPath('/posiciones?filtro=sol')).toBe('/posiciones?filtro=sol')
  })

  it('cae en el inicio sin valor o con uno que no es texto', () => {
    expect(safeReturnPath(undefined)).toBe('/')
    expect(safeReturnPath('')).toBe('/')
    expect(safeReturnPath(['/posiciones', '/ajustes'])).toBe('/')
  })

  it('no deja salir a otro sitio', () => {
    expect(safeReturnPath('https://malo.com')).toBe('/')
    expect(safeReturnPath('//malo.com/x')).toBe('/')
    expect(safeReturnPath('/\\malo.com')).toBe('/')
    expect(safeReturnPath('posiciones')).toBe('/')
  })

  it('no vuelve a la pantalla de acceso ni a la API', () => {
    expect(safeReturnPath('/acceso')).toBe('/')
    expect(safeReturnPath('/acceso?error=not_allowed')).toBe('/')
    expect(safeReturnPath('/api/auth/sign-out')).toBe('/')
  })
})
