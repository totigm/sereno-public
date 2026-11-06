import type { LivePayload } from '@/lib/live/types'
import type { SettingsEditor } from './use-settings-editor'

/** Lo que recibe cada sección de Ajustes. */
export interface SectionProps {
  editor: SettingsEditor
  /** Replay o simulación archivada: se muestran los valores, sin controles. */
  readOnly: boolean
  /** El estado en vivo del shell (abiertas, libro, bot, comandos). */
  live: LivePayload
}
