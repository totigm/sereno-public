'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { NOT_ALLOWED } from '@/lib/allowlist'
import { authClient } from '@/lib/auth-client'
import { ACCESS_PATH } from '@/lib/return-path'
import { signInErrorMessage, type SignInError } from '@/lib/sign-in-error'

// Sin respuesta del servidor (red caída): cae en el mensaje genérico.
const NETWORK_FAILURE: SignInError = { status: 0 }

export function PasswordForm({ returnTo }: { returnTo: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)

    const result = await authClient.signIn
      .email({ email: String(form.get('email')).trim(), password: String(form.get('password')) })
      .catch(() => ({ error: NETWORK_FAILURE }))

    if (!result.error) {
      // El botón sigue ocupado hasta que llega la página de destino.
      router.replace(returnTo)
      router.refresh()
      return
    }
    if (result.error.code === NOT_ALLOWED) {
      router.replace(`${ACCESS_PATH}?error=${NOT_ALLOWED}`)
      return
    }
    setPending(false)
    setError(signInErrorMessage(result.error))
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        inputMode="email"
        required
      />
      <Field label="Contraseña" name="password" type="password" autoComplete="current-password" required />
      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="mt-1 w-full" pending={pending}>
        Entrar
      </Button>
    </form>
  )
}
