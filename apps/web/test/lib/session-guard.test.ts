// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { auth } from '@/lib/auth'
import { requireApiSession } from '@/lib/session'

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('requireApiSession no debería redirigir nunca')
  }),
}))
vi.mock('@/lib/env', () => ({ env: { ALLOWED_EMAILS: 'owner@example.com' } }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }))

const getSession = vi.mocked(auth.api.getSession)

function sessionOf(email: string) {
  return { user: { email }, session: { id: 's1' } } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>
}

describe('requireApiSession', () => {
  it('sin sesión devuelve un 401 JSON en vez de redirigir', async () => {
    getSession.mockResolvedValueOnce(null)
    const result = await requireApiSession()
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('con un email fuera de la lista devuelve 403 `not_allowed`', async () => {
    getSession.mockResolvedValueOnce(sessionOf('otra@gmail.com'))
    const response = (await requireApiSession()) as Response
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'not_allowed' })
  })

  it('con la cuenta autorizada devuelve la sesión', async () => {
    const session = sessionOf('Owner@Example.com')
    getSession.mockResolvedValueOnce(session)
    expect(await requireApiSession()).toBe(session)
  })
})
