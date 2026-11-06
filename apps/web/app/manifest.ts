import type { MetadataRoute } from 'next'
import { tokens } from '@/lib/theme'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sereno',
    short_name: 'Sereno',
    description: 'Bot de futuros con paper trading, replay histórico y aprendizaje explicable.',
    lang: 'es-AR',
    start_url: '/',
    display: 'standalone',
    background_color: tokens.light.bg,
    // El manifest admite un solo color; el <meta name="theme-color"> del layout
    // lleva uno por esquema.
    theme_color: tokens.light.bg,
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }
}
