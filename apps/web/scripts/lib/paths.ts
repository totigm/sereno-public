import { fileURLToPath } from 'node:url'

// Rutas fijas de las herramientas: no dependen del directorio desde el que se las llame.
export const REPO_DIR = fileURLToPath(new URL('../../../..', import.meta.url))
export const ENV_LOCAL_PATH = fileURLToPath(new URL('../../.env.local', import.meta.url))
