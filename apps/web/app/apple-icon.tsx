import { ImageResponse } from 'next/og'
import { tokens } from '@/lib/theme'

// iOS no acepta SVG como ícono de pantalla de inicio: este PNG se genera en el build
// con el mismo trazo que `icon.svg`. iOS redondea las esquinas por su cuenta.
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.light.ink,
      }}
    >
      <svg width="180" height="180" viewBox="0 0 64 64">
        <path
          d="M12 35c6.5 0 6.5-9 13-9s6.5 9 13 9 6.5-9 14-9"
          fill="none"
          stroke={tokens.dark.gain}
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
    </div>,
    size,
  )
}
