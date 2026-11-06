import { describe, expect, it } from 'vitest'
import { accessErrorKind, signInErrorMessage } from '@/lib/sign-in-error'

describe('signInErrorMessage', () => {
  it('credenciales que no coinciden', () => {
    expect(signInErrorMessage({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 })).toBe(
      'El email o la contraseña no coinciden.',
    )
  })

  it('email mal escrito', () => {
    expect(signInErrorMessage({ code: 'INVALID_EMAIL', status: 400 })).toBe('Revisá el email: no parece válido.')
  })

  it('demasiados intentos', () => {
    expect(signInErrorMessage({ status: 429 })).toBe('Demasiados intentos. Esperá un minuto y probá de nuevo.')
  })

  it('cualquier otra falla dice qué hacer', () => {
    expect(signInErrorMessage({ status: 500 })).toBe('No pude entrar. Revisá la conexión y probá de nuevo.')
  })
})

describe('accessErrorKind', () => {
  it('sin error no hay aviso', () => {
    expect(accessErrorKind(undefined)).toBeNull()
    expect(accessErrorKind('')).toBeNull()
  })

  it('el rechazo de la lista blanca es un rechazo', () => {
    expect(accessErrorKind('not_allowed')).toBe('not-allowed')
  })

  it('el resto de los errores de Google es una falla que se puede reintentar', () => {
    expect(accessErrorKind('access_denied')).toBe('failed')
    expect(accessErrorKind('state_mismatch')).toBe('failed')
    expect(accessErrorKind(['not_allowed', 'x'])).toBe('failed')
  })
})
