import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { installMatchMedia, resetMedia } from './media'

installMatchMedia()

afterEach(() => {
  cleanup()
  resetMedia()
})
