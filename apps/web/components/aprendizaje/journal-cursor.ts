import type { LogCursor } from '@/lib/queries/aprendizaje'

// El diario completo se refleja en la URL: `?diario=todo` abre la hoja con lo más
// reciente y `?diario=<at>.<id>` con la página que sigue a ese cambio (la trae el
// servidor). Sin 'use client': lo usan la página y la hoja.

export const JOURNAL_PARAM = 'diario'
export const JOURNAL_LATEST = 'todo'

export function cursorParam(cursor: LogCursor): string {
  return `${cursor.at}.${cursor.id}`
}

/** El cursor de `?diario=<at>.<id>`; null con `todo`, sin parámetro o con algo que no es un cursor. */
export function parseJournalCursor(searchParams: Record<string, string | string[] | undefined>): LogCursor | null {
  const raw = searchParams[JOURNAL_PARAM]
  const value = Array.isArray(raw) ? raw[0] : raw
  const match = value?.match(/^(\d{1,15})\.(\d{1,15})$/)
  if (!match) return null
  return { at: Number(match[1]), id: Number(match[2]) }
}
