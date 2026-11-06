// @vitest-environment node
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'

const ORIGIN = 'http://localhost:3000'
const SESSION_COOKIE = 'better-auth.session_token=token.firmado'

function request(path: string, { cookie }: { cookie?: string } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {})
}

// `NextResponse.next()` deja seguir el pedido: lo marca con este encabezado.
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1'

describe('proxy sin cookie de sesión', () => {
  it('una página redirige a /acceso con la ruta a la que volver', () => {
    const res = proxy(request('/posiciones?simbolo=SOL'))
    expect(res.status).toBe(307)
    const to = new URL(getRedirectUrl(res) ?? '')
    expect(`${to.origin}${to.pathname}`).toBe(`${ORIGIN}/acceso`)
    expect(to.searchParams.get('volver')).toBe('/posiciones?simbolo=SOL')
  })

  it('desde el inicio redirige a /acceso sin volver', () => {
    expect(getRedirectUrl(proxy(request('/')))).toBe(`${ORIGIN}/acceso`)
  })

  it('una ruta /api/* responde 401 en JSON, no un redirect', async () => {
    const res = proxy(request('/api/live'))
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it.each(['/acceso', '/api/auth', '/api/auth/sign-in/email', '/api/auth/callback/google'])('deja pasar %s', (path) => {
    expect(passes(proxy(request(path)))).toBe(true)
  })

  it.each(['/api/authx', '/api/auth-config'])('la excepción de auth es exacta: %s no pasa', (path) => {
    expect(proxy(request(path)).status).toBe(401)
  })

  it('una cookie ajena no cuenta como sesión', () => {
    expect(proxy(request('/posiciones', { cookie: 'otra=1' })).status).toBe(307)
  })
})

describe('proxy con cookie de sesión', () => {
  it.each(['/', '/posiciones', '/api/live'])('deja pasar %s', (path) => {
    expect(passes(proxy(request(path, { cookie: SESSION_COOKIE })))).toBe(true)
  })

  it('también con el prefijo __Secure- de producción', () => {
    expect(passes(proxy(request('/posiciones', { cookie: `__Secure-${SESSION_COOKIE}` })))).toBe(true)
  })
})

describe('matcher del proxy', () => {
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${path}` })

  it.each(['/favicon.ico', '/icon.svg', '/apple-icon.png', '/manifest.webmanifest', '/_next/static/chunks/app.js', '/_next/image'])(
    'no corre para %s, que el navegador pide sin sesión',
    (path) => {
      expect(matches(path)).toBe(false)
    },
  )

  it.each(['/', '/posiciones', '/acceso', '/api/live', '/api/auth/get-session'])('corre para %s', (path) => {
    expect(matches(path)).toBe(true)
  })
})
