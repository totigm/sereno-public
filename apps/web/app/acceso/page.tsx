import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { GoogleButton } from '@/components/auth/google-button'
import { PasswordForm } from '@/components/auth/password-form'
import { TryAnotherAccount } from '@/components/auth/try-another-account'
import { BrandMark } from '@/components/brand-mark'
import { isAllowed } from '@/lib/allowlist'
import { googleEnabled } from '@/lib/auth'
import { env } from '@/lib/env'
import { RETURN_PARAM, safeReturnPath } from '@/lib/return-path'
import { getSession } from '@/lib/session'
import { accessErrorKind } from '@/lib/sign-in-error'

export const metadata: Metadata = { title: 'Entrar' }

const TAGLINE = 'Dashboard del bot. Sólo para la cuenta autorizada.'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 pt-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="panel flex w-full max-w-[400px] flex-col gap-7 px-6 py-8 desktop:px-8">
        <header className="flex flex-col items-center gap-4 text-center">
          <BrandMark className="size-12" />
          <div className="flex flex-col gap-1.5">
            <h1 className="headline">{title}</h1>
            <p className="text-balance text-muted">{TAGLINE}</p>
          </div>
        </header>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </main>
  )
}

export default async function AccessPage({ searchParams }: PageProps<'/acceso'>) {
  const params = await searchParams
  const returnTo = safeReturnPath(params[RETURN_PARAM])

  // Con una sesión válida no hay nada que hacer acá, aunque la URL traiga un error viejo.
  const session = await getSession()
  if (session && isAllowed(session.user.email, env.ALLOWED_EMAILS)) redirect(returnTo)

  const error = accessErrorKind(params.error)

  if (error === 'not-allowed') {
    return (
      <Card title="Esta cuenta no tiene acceso a Sereno">
        <TryAnotherAccount />
      </Card>
    )
  }

  return (
    <Card title="Sereno">
      {error === 'failed' && (
        <p role="alert" className="rounded-control bg-loss-soft px-3 py-2.5 text-sm">
          No pude terminar de entrar con Google. Probá de nuevo.
        </p>
      )}
      {googleEnabled && (
        <>
          <GoogleButton returnTo={returnTo} />
          <div className="flex items-center gap-3 text-sm text-muted" aria-hidden>
            <span className="h-px flex-1 bg-line" />o<span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <PasswordForm returnTo={returnTo} />
    </Card>
  )
}
