import type { GenericEndpointContext, Session, User, ValidateUserInfoResult, ValidateUserInfoSource } from 'better-auth'
import { APIError } from 'better-auth/api'
import { isAllowed, NOT_ALLOWED } from './allowlist'

const REJECTION = { error: NOT_ALLOWED, errorDescription: 'Esta cuenta no tiene acceso a Sereno' } as const

function notAllowed(): APIError {
  return new APIError('FORBIDDEN', { code: REJECTION.error, message: REJECTION.errorDescription })
}

// Tres puertas sobre la misma lista, porque Better Auth valida cosas distintas en cada una:
// - `validateUserInfo`: altas, vínculos y cada inicio con Google, con el email fresco del proveedor.
// - `user.create.before`: cualquier alta, incluso las que no pasan por un endpoint (el seed).
// - `session.create.before`: los inicios con contraseña, que Better Auth no revalida; así sacar
//   un email de la lista corta también la entrada con contraseña.
export function allowlistGuards(allowedEmails: string) {
  return {
    validateUserInfo(data: {
      user: Partial<User> & Record<string, unknown>
      source: ValidateUserInfoSource
    }): ValidateUserInfoResult | undefined {
      return isAllowed(data.user.email, allowedEmails) ? undefined : REJECTION
    },

    async beforeUserCreate(user: User & Record<string, unknown>): Promise<void> {
      if (!isAllowed(user.email, allowedEmails)) throw notAllowed()
    },

    async beforeSessionCreate(session: Session & Record<string, unknown>, context: GenericEndpointContext | null): Promise<void> {
      // Sin contexto no hay cómo leer el usuario: se cierra en vez de dejar pasar.
      const user = await context?.context.internalAdapter.findUserById(session.userId)
      if (!isAllowed(user?.email, allowedEmails)) throw notAllowed()
    },
  }
}
