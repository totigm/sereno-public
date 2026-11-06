'use client'

import Link from 'next/link'
import { useSyncExternalStore, type MouseEvent } from 'react'
import { Band } from '@/components/status/band'
import type { JournalEntry } from '@/lib/queries/journal'
import { liquidationBandText } from './journal-text'

// Las liquidaciones ya vistas, por id de entrada del diario: la banda vuelve sólo con
// una nueva. Viven en este navegador; con otro, la banda aparece de nuevo.
const KEY = 'sereno:liquidaciones-vistas'
const CHANGED = 'sereno:liquidaciones-vistas'
const EMPTY: readonly string[] = []

let cachedRaw: string | null = null
let cachedIds: readonly string[] = EMPTY

function readSeen(): readonly string[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    return EMPTY
  }
  if (raw === cachedRaw) return cachedIds
  cachedRaw = raw
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    cachedIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : EMPTY
  } catch {
    cachedIds = EMPTY
  }
  return cachedIds
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGED, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGED, onChange)
  }
}

/** Marca como vistas esas liquidaciones (se guardan sólo las del tramo, así la lista no crece). */
export function markLiquidationsSeen(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    return
  }
  window.dispatchEvent(new Event(CHANGED))
}

/** Las liquidaciones del tramo que todavía no se tocaron; ninguna en el servidor (la banda aparece al hidratar). */
export function useUnseenLiquidations(entries: readonly JournalEntry[]): JournalEntry[] {
  const seen = useSyncExternalStore(subscribe, readSeen, () => null)
  if (seen === null) return []
  return entries.filter((e) => e.kind === 'liquidation' && !seen.includes(e.id))
}

export interface LiquidationBandProps {
  unseen: readonly JournalEntry[]
  /** Con una sola liquidación, "Ver" abre su trade; si no, `onView` abre el diario. */
  link: { href: string; onOpen: (event: MouseEvent) => void } | null
  /** Tocar "Ver": la banda se va. */
  onView: () => void
}

const VIEW = 'pressable -my-2.5 -mr-2 inline-flex min-h-11 shrink-0 items-center rounded-control px-2 font-semibold text-loss'

/** "Hubo 1 liquidación desde ayer." bajo el titular hasta que se toca (spec §11.1). */
export function LiquidationBand({ unseen, link, onView }: LiquidationBandProps) {
  return (
    <Band
      show={unseen.length > 0}
      tone="loss"
      role="status"
      action={
        link ? (
          <Link
            href={link.href}
            scroll={false}
            onClick={(event) => {
              onView()
              link.onOpen(event)
            }}
            className={VIEW}
          >
            Ver
          </Link>
        ) : (
          <button type="button" onClick={onView} className={VIEW}>
            Ver
          </button>
        )
      }
    >
      {liquidationBandText(unseen.length)}
    </Band>
  )
}
