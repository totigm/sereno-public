import type { NextRequest } from 'next/server'
import { repos } from '@/lib/db'
import { loadLive } from '@/lib/queries/live'
import { requireApiSession } from '@/lib/session'

// `GET /api/live?session=<id>&since=<versión>` (spec §11.5). Sin `session`, la
// simulación activa. Nunca se cachea: es lo que el dashboard consulta cada 5 s.
const NO_STORE = { 'Cache-Control': 'no-store' }
const MAX_PARAM = 512

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireApiSession()
  if (auth instanceof Response) return auth

  const params = request.nextUrl.searchParams
  const session = params.get('session') ?? undefined
  const since = params.get('since') ?? undefined
  if ((session?.length ?? 0) > MAX_PARAM || (since?.length ?? 0) > MAX_PARAM) return json({ error: 'bad_request' }, 400)

  const sessionId = session ?? (await repos.sessions.getActive('paper_live'))?.id
  if (sessionId === undefined) return json({ error: 'no_session' }, 404)
  const live = await loadLive(sessionId, since)
  if (!live) return json({ error: 'no_session' }, 404)
  return json(live)
}
