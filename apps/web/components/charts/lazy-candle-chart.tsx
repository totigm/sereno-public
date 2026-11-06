'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

/** `CandleChart` sin SSR: lightweight-charts dibuja en un canvas y necesita la ventana. */
export const LazyCandleChart = dynamic(() => import('./candle-chart').then((m) => m.CandleChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px] w-full desktop:h-[260px]" />,
})
