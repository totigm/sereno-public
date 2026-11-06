import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import { instrumentSans } from '@/lib/fonts'
import { themeColor } from '@/lib/theme'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Sereno', template: '%s · Sereno' },
  description: 'Bot de futuros con paper trading, replay histórico y aprendizaje explicable.',
  applicationName: 'Sereno',
  appleWebApp: { capable: true, title: 'Sereno', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [...themeColor],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-AR" className={instrumentSans.variable}>
      <body className="bg-bg font-sans text-ink">
        <Providers>
          {/*
            La hoja escala este nodo a 0,98 en el celu; por eso está separado del body.
            Mientras tiene `transform` es el bloque contenedor de todo `position: fixed`
            de adentro: lo fijo a la ventana (barra inferior, toasts) va como hermano
            de este nodo, nunca dentro de `children`.
          */}
          <div data-page-root className="min-h-dvh">
            {children}
          </div>
        </Providers>
      </body>
    </html>
  )
}
