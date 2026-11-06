import { eq, sql } from 'drizzle-orm'
import { botCommands, botStatus, equitySnapshots, marketSnapshot, positions, sessions, settings, type Db } from '@sereno/db'
import type { RealStatus } from '@sereno/shared'
import { asNullableNumber, asNumber, epochMs, scalar } from './fields'

export interface LiveVersionRow {
  capitalInicial: number
  startedAt: number
  protegido: number
  baseBlindaje: number
  market: number | null
  heartbeat: number | null
  settings: number | null
  /** Huella de lo que cambia en las abiertas (stops, trailing, cantidad, costos). */
  openHash: string
  /** Todas las posiciones de la sesión: cubre una que abrió y cerró entre dos consultas. */
  positions: number
  equityId: number | null
  /** El último cambio de estado de un comando (cada transición sella una fecha). */
  commands: number | null
  /**
   * Pendientes que ya vencieron por el reloj. Sólo el bot los pasa a `expired`: con el
   * bot caído ninguna fecha cambia, y sin esto la UI se quedaría en "enviado al bot…".
   */
  expiredCommands: number
  /** El interruptor de la sesión real (null en papel): lo mueven la web y el tope, no el latido. */
  realStatus: RealStatus | null
  /** Reloj de la base. */
  now: number
}

// `positions` no tiene `updated_at`: la huella de las abiertas cumple ese papel sin
// tocar el esquema (son pocas filas y el índice por sesión las encuentra).
const openFields = sql.join(
  [
    positions.id,
    positions.qty,
    positions.margin,
    positions.stopPrice,
    positions.takeProfitPrice,
    positions.liquidationPrice,
    positions.trailingActive,
    positions.bestPrice,
    positions.fees,
    positions.funding,
  ],
  sql`, `,
)

/**
 * Todo lo que mira `?since=` en una sola consulta: si la ficha no cambió, `/api/live`
 * contesta sin leer nada más. Null si la sesión no existe.
 */
export async function readLiveVersion(db: Db, sessionId: string): Promise<LiveVersionRow | null> {
  const [row] = await db
    .select({
      capitalInicial: sessions.capitalInicial,
      startedAt: sessions.startedAt,
      protegido: sessions.protegido,
      baseBlindaje: sessions.baseBlindaje,
      market: asNullableNumber(scalar(sql`select ${marketSnapshot.version} from ${marketSnapshot} where ${marketSnapshot.sessionId} = ${sessions.id}`)),
      heartbeat: epochMs(scalar(sql`select ${botStatus.lastHeartbeat} from ${botStatus} where ${botStatus.sessionId} = ${sessions.id}`)),
      settings: asNullableNumber(scalar(sql`select ${settings.version} from ${settings} where ${settings.sessionId} = ${sessions.id}`)),
      openHash: scalar<string>(
        sql`select md5(coalesce(string_agg(concat_ws(':', ${openFields}), ',' order by ${positions.id}), '')) from ${positions} where ${positions.sessionId} = ${sessions.id} and ${positions.closedAt} is null`,
      ),
      positions: asNumber(scalar(sql`select count(*) from ${positions} where ${positions.sessionId} = ${sessions.id}`)),
      equityId: asNullableNumber(
        scalar(
          sql`select ${equitySnapshots.id} from ${equitySnapshots} where ${equitySnapshots.sessionId} = ${sessions.id} order by ${equitySnapshots.at} desc, ${equitySnapshots.id} desc limit 1`,
        ),
      ),
      commands: epochMs(
        scalar(
          sql`select max(greatest(${botCommands.createdAt}, ${botCommands.claimedAt}, ${botCommands.finishedAt})) from ${botCommands} where ${botCommands.sessionId} = ${sessions.id}`,
        ),
      ),
      expiredCommands: asNumber(
        scalar(
          sql`select count(*) from ${botCommands} where ${botCommands.sessionId} = ${sessions.id} and ${botCommands.status} = 'pending' and ${botCommands.expiresAt} <= now()`,
        ),
      ),
      realStatus: sessions.realStatus,
      now: asNumber(sql`round(extract(epoch from now()) * 1000)`),
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
  if (!row) return null
  return { ...row, startedAt: row.startedAt.getTime() }
}

/** La ficha que viaja en `version` y vuelve en `since`. */
export function versionToken(row: LiveVersionRow, offline: boolean, dayStart: number): string {
  const part = (v: number | null): string => (v === null ? '-' : String(v))
  return [
    part(row.market),
    part(row.heartbeat),
    part(row.settings),
    row.positions,
    row.openHash,
    part(row.equityId),
    part(row.commands),
    row.expiredCommands,
    // Los mueve `updateShield` y viajan en el libro: no dependen de que el bot también lata.
    row.protegido,
    row.baseBlindaje,
    row.realStatus ?? '-',
    // El "sin conexión" y el día cambian con el reloj aunque la base no cambie.
    offline ? 'off' : 'on',
    dayStart,
  ].join('.')
}
