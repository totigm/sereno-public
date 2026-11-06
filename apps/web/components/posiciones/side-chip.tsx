import type { Side } from '@sereno/core'
import { Chip } from '@/components/ui/chip'
import { sideLabel } from './format'

/** "Long 5x" en el tono de ganancia, "Short 3x" en el de pérdida, como en el mockup de la Libreta. */
export function SideChip({ side, leverage }: { side: Side; leverage: number }) {
  return <Chip tone={side === 'long' ? 'gain' : 'loss'}>{sideLabel(side, leverage)}</Chip>
}
