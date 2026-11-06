import { createDirectDb, type DirectDb } from '@sereno/db'
import { migrate } from '@sereno/db/migrate'
import { databaseName } from '../../scripts/lib/db-url'

// Los tests de web que escriben en Postgres vacían tablas. Corren sólo con
// DATABASE_URL_TEST_WEB definida (sin valor por defecto) y contra una base `*_test`
// propia: los de @sereno/db usan DATABASE_URL_TEST (o `sereno_test`) y su
// `migrate.test.ts` la vacía, y un `pnpm test` en la raíz corre los dos proyectos a la vez.
export const TEST_URL = process.env.DATABASE_URL_TEST_WEB
// La base de los tests de @sereno/db (su valor por defecto está en test/repos/helpers.ts).
const DB_PACKAGE_URL = process.env.DATABASE_URL_TEST ?? 'postgresql://postgres@127.0.0.1:5499/sereno_test'

function sameDatabase(a: string, b: string): boolean {
  const [x, y] = [new URL(a), new URL(b)]
  return x.hostname === y.hostname && (x.port || '5432') === (y.port || '5432') && databaseName(a) === databaseName(b)
}

export function assertWebTestUrl(url: string, dbPackageUrl: string = DB_PACKAGE_URL): void {
  const name = databaseName(url)
  if (!name.endsWith('_test')) throw new Error(`DATABASE_URL_TEST_WEB debe apuntar a una base *_test, no a ${name}`)
  if (sameDatabase(url, dbPackageUrl)) throw new Error(`DATABASE_URL_TEST_WEB apunta a ${name}, la base de los tests de @sereno/db: usá una propia`)
}

export async function openTestDb(): Promise<DirectDb> {
  if (TEST_URL === undefined) throw new Error('Falta DATABASE_URL_TEST_WEB')
  assertWebTestUrl(TEST_URL)
  await migrate(TEST_URL)
  return createDirectDb(TEST_URL, { max: 2 })
}
