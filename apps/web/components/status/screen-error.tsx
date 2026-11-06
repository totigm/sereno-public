'use client'

import clsx from 'clsx'
import Link from 'next/link'
import { useEffect, useTransition } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'

export interface ScreenErrorProps {
  /** Lo que se tiró: de un Server Component llega como `Error` con `digest`; de un cliente, tal cual. */
  error: unknown
  retry: () => void
  /** Fuera del shell (error del layout de arriba): ocupa la pantalla entera, como la de acceso. */
  standalone?: boolean
}

function digestOf(error: unknown): string | null {
  if (error instanceof Error && 'digest' in error && typeof error.digest === 'string') return error.digest
  return null
}

/**
 * Una pantalla que no pudo cargar (spec §11.2: errores que dicen qué pasó y qué
 * hacer). Dentro del shell la navegación sigue a mano: se puede reintentar o ir a
 * otra pestaña. El código es el que figura en los logs del servidor.
 */
export function ScreenError({ error, retry, standalone = false }: ScreenErrorProps) {
  const [retrying, startRetry] = useTransition()
  const digest = digestOf(error)

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div
      role="alert"
      className={standalone ? 'flex min-h-dvh items-center justify-center px-5 py-10' : 'column pt-10 desktop:pt-16'}
    >
      <div className={clsx('flex max-w-[30rem] flex-col gap-6', standalone && 'items-center text-center')}>
        {standalone && <BrandMark className="size-12" />}
        <div className="flex flex-col gap-2">
          <h1 className="headline">No pude mostrar esta pantalla.</h1>
          <p className="text-pretty text-muted">
            Falló algo al leer los datos, probablemente la base o la conexión. Lo que hace el bot no depende de esta pantalla:
            reintentá en un momento.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" pending={retrying} onClick={() => startRetry(() => retry())}>
            Reintentar
          </Button>
          <Link href="/" className="pressable inline-flex h-11 items-center rounded-control border border-line bg-surface px-4 text-[0.9375rem] font-medium">
            Ir al resumen
          </Link>
        </div>
        {digest !== null && <p className="text-xs text-muted">Código para los logs: {digest}</p>}
      </div>
    </div>
  )
}
