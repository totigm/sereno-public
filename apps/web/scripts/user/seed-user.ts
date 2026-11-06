import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { account, session, user, verification, type AnyDb } from '@sereno/db'
import { createAuth } from '../../lib/auth-config'

export interface SeedUserInput {
  db: AnyDb
  email: string
  password: string
  secret: string
  baseURL: string
  allowedEmails: string
}

export interface SeedUserResult {
  userId: string
  created: boolean
}

// El dashboard tiene el alta pública apagada (`disableSignUp`) y Better Auth 1.7 rechaza
// `signUpEmail` con esa opción aunque lo llame el servidor; `internalAdapter.createUser`
// fuera de un endpoint falla por `validateUserInfo`. Por eso el seed arma su propia
// instancia, sólo en este proceso y sin rutas HTTP, a partir de la configuración del
// dashboard (`createAuth`: mismo hash de contraseñas, mismas guardas de la lista blanca)
// con el alta prendida.
function seedAuth({ db, secret, baseURL, allowedEmails }: Omit<SeedUserInput, 'email' | 'password'>) {
  const database = drizzleAdapter(db, { provider: 'pg', schema: { user, session, account, verification } })
  const { options } = createAuth({ database, secret, baseURL, allowedEmails })
  return betterAuth({
    ...options,
    // Sin `autoSignIn` el alta no deja una sesión abierta en la base.
    emailAndPassword: { ...options.emailAndPassword, disableSignUp: false, autoSignIn: false },
    // `nextCookies` sólo tiene sentido dentro de un pedido de Next; el seed corre fuera.
    plugins: [],
    logger: { level: 'error' },
  })
}

function displayName(email: string): string {
  const local = email.split('@')[0] ?? email
  return local.charAt(0).toUpperCase() + local.slice(1)
}

// Crea el único usuario del dashboard o, si ya existe, le pone la contraseña dada.
// En los dos casos deja `emailVerified = true`: con `requireLocalEmailVerified` (el
// valor por defecto) entrar después con Google daría `account_not_linked`.
export async function seedUser(input: SeedUserInput): Promise<SeedUserResult> {
  const email = input.email.trim().toLowerCase()
  const auth = seedAuth(input)
  const ctx = await auth.$context
  const existing = await ctx.internalAdapter.findUserByEmail(email)

  let userId: string
  if (existing) {
    userId = existing.user.id
    const hash = await ctx.password.hash(input.password)
    const accounts = await ctx.internalAdapter.findAccounts(userId)
    // Un usuario que hasta ahora sólo entró con Google no tiene cuenta de contraseña.
    if (accounts.some((a) => a.providerId === 'credential')) await ctx.internalAdapter.updatePassword(userId, hash)
    else await ctx.internalAdapter.linkAccount({ userId, providerId: 'credential', accountId: userId, password: hash })
  } else {
    await auth.api.signUpEmail({ body: { email, password: input.password, name: displayName(email) } })
    // Si una guarda frena el alta, Better Auth igual responde con un usuario inventado
    // (para no revelar qué emails existen): sólo la base dice si quedó creado.
    const created = await ctx.internalAdapter.findUserByEmail(email)
    if (!created) throw new Error(`No se creó el usuario ${email}: ¿está en ALLOWED_EMAILS?`)
    userId = created.user.id
  }

  await ctx.internalAdapter.updateUser(userId, { emailVerified: true })
  return { userId, created: existing === null }
}
