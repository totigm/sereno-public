import { Instrument_Sans } from 'next/font/google'

// Una sola familia para todo (spec §11.2), con el eje de peso variable 400..700.
// La variable propia de next/font es `--font-instrument-sans`; `globals.css` la
// mapea a `--font-sans` en el `@theme` de Tailwind (definir `--font-sans` en los
// dos lados sería circular).
export const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-instrument-sans',
})
