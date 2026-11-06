import { and, desc, eq, inArray } from 'drizzle-orm'
import { learningState, sessions, type Db } from '@sereno/db'

export interface ReplaySource {
  id: string
  name: string
  days: number | null
  capitalInicial: number
  endedAt: number | null
}

export interface LearningSources {
  /** Hay una simulación en papel con aprendizaje para continuar (`learningOrigin: 'continued'`). */
  continued: boolean
  /** Replays terminados con aprendizaje (`learningOrigin: 'replay:<id>'`), los más nuevos primero. */
  replays: ReplaySource[]
}

/** De dónde puede arrancar el aprendizaje de una simulación nueva (spec §8, primer uso paso 3). */
export async function learningSources(db: Db): Promise<LearningSources> {
  const rows = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      name: sessions.name,
      replayParams: sessions.replayParams,
      capitalInicial: sessions.capitalInicial,
      endedAt: sessions.endedAt,
      status: sessions.status,
    })
    .from(sessions)
    .innerJoin(learningState, eq(learningState.sessionId, sessions.id))
    .where(
      and(
        // La de plata real no es punto de partida: aprende con otro capital (`copyLearning` sólo sigue a las de papel).
        inArray(sessions.kind, ['paper_live', 'replay']),
        // Un replay a medias no es un punto de partida: sólo los que terminaron bien.
        inArray(sessions.status, ['active', 'archived', 'listo']),
      ),
    )
    .orderBy(desc(sessions.startedAt))
  return {
    continued: rows.some((r) => r.kind !== 'replay'),
    replays: rows
      .filter((r) => r.kind === 'replay')
      .map((r) => ({
        id: r.id,
        name: r.name,
        days: r.replayParams?.days ?? null,
        capitalInicial: r.capitalInicial,
        endedAt: r.endedAt?.getTime() ?? null,
      })),
  }
}
