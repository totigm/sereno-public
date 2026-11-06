import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { isAllowed, NOT_ALLOWED } from './allowlist'
import { auth } from './auth'
import { env } from './env'
import { ACCESS_PATH } from './return-path'

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

/** La sesión del pedido actual, leída una sola vez aunque la pidan el layout y la página. */
export const getSession = cache(async (): Promise<AuthSession | null> => {
  return auth.api.getSession({ headers: await headers() })
})

/**
 * Para páginas y Server Actions: devuelve la sesión o redirige a `/acceso`.
 * `proxy.ts` sólo mira que haya cookie; la validación real es ésta. La lista se
 * vuelve a mirar acá para que sacar un email corte también las sesiones que ya
 * estaban abiertas. En Route Handlers va `requireApiSession`.
 */
export async function requireSession(): Promise<AuthSession> {
  const session = await getSession()
  if (!session) redirect(ACCESS_PATH)
  if (!isAllowed(session.user.email, env.ALLOWED_EMAILS)) redirect(`${ACCESS_PATH}?error=${NOT_ALLOWED}`)
  return session
}

/**
 * Para Route Handlers: la sesión, o la respuesta JSON que hay que devolver (401 sin
 * sesión, 403 con un email fuera de la lista). Nunca redirige: un `fetch` seguiría
 * el 307 hasta `/acceso` y recibiría HTML en lugar del error.
 */
export async function requireApiSession(): Promise<AuthSession | Response> {
  const session = await getSession()
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isAllowed(session.user.email, env.ALLOWED_EMAILS)) return Response.json({ error: NOT_ALLOWED }, { status: 403 })
  return session
}
