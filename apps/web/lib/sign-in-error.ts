import { NOT_ALLOWED } from './allowlist'

export interface SignInError {
  code?: string | undefined
  status: number
}

// Mensajes para el formulario de contraseña: qué pasó y qué hacer (spec §11.2). Un email
// sin cuenta recibe el mismo mensaje que una contraseña equivocada, así la pantalla no
// revela qué cuentas existen. Una cuenta que existe pero salió de la lista, con la
// contraseña correcta, no llega acá: Better Auth la rechaza con `not_allowed` y el
// formulario muestra la tarjeta de "sin acceso" de `/acceso`.
export function signInErrorMessage({ code, status }: SignInError): string {
  if (code === 'INVALID_EMAIL_OR_PASSWORD') return 'El email o la contraseña no coinciden.'
  if (code === 'INVALID_EMAIL') return 'Revisá el email: no parece válido.'
  if (status === 429) return 'Demasiados intentos. Esperá un minuto y probá de nuevo.'
  return 'No pude entrar. Revisá la conexión y probá de nuevo.'
}

export type AccessErrorKind = 'not-allowed' | 'failed'

/**
 * Lee `?error=` de `/acceso`. Better Auth vuelve con el código del rechazo de la lista
 * blanca o con el de una falla del flujo de Google (cancelado, estado vencido, etc.):
 * sólo el primero es "esta cuenta no tiene acceso"; el resto se puede reintentar.
 */
export function accessErrorKind(raw: string | string[] | undefined): AccessErrorKind | null {
  if (raw === undefined || raw === '') return null
  return raw === NOT_ALLOWED ? 'not-allowed' : 'failed'
}
