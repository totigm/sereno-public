import { getSessionCookie } from 'better-auth/cookies'
import { NextResponse, type NextRequest } from 'next/server'
import { ACCESS_PATH, RETURN_PARAM } from '@/lib/return-path'

// Sólo mira que exista la cookie de sesión: es barato y no toca la base. Cada página
// valida la sesión de verdad con `requireSession()` y cada Route Handler con
// `requireApiSession()` (spec §11.7).
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (pathname === ACCESS_PATH || isAuthRoute(pathname)) return NextResponse.next()
  if (getSessionCookie(request)) return NextResponse.next()

  // A un fetch no le sirve un redirect a una página: recibe 401 y la UI decide.
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(ACCESS_PATH, request.url)
  if (pathname !== '/') url.searchParams.set(RETURN_PARAM, `${pathname}${search}`)
  return NextResponse.redirect(url)
}

// Los endpoints de Better Auth (entrar, callback de Google) se usan sin sesión. Exacto:
// `/api/authx` no es de Better Auth y queda protegido como cualquier `/api/*`.
function isAuthRoute(pathname: string): boolean {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/')
}

export const config = {
  // Fuera quedan los archivos que el navegador pide sin sesión: assets, íconos y manifest.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon|manifest.webmanifest).*)'],
}
