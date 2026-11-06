// Tokens de la spec §11.2. La fuente de verdad para la UI es `app/globals.css`
// (custom properties); esta copia en TypeScript sirve para lo que no puede leer
// CSS: `theme-color`, el manifest y los gráficos.

export const tokens = {
  light: {
    bg: '#EDF0F4',
    surface: '#FFFFFF',
    ink: '#17202A',
    muted: '#6B7482',
    line: '#DFE3E8',
    gain: '#2E8B6A',
    loss: '#C4553D',
    gainSoft: '#E1EEE8',
    lossSoft: '#F5E5E1',
  },
  dark: {
    bg: '#0F1318',
    surface: '#171C24',
    ink: '#E8ECF1',
    muted: '#8A93A3',
    line: '#262D38',
    gain: '#4FD1A5',
    loss: '#FF7A7A',
    gainSoft: 'rgba(79,209,165,.14)',
    lossSoft: 'rgba(255,122,122,.14)',
  },
} as const

export type TokenName = keyof typeof tokens.light

/** A partir de acá la hoja es un panel centrado y la navegación va arriba (spec §11.2). */
export const DESKTOP_QUERY = '(min-width: 900px)'

export const themeColor = [
  { media: '(prefers-color-scheme: light)', color: tokens.light.bg },
  { media: '(prefers-color-scheme: dark)', color: tokens.dark.bg },
] as const
