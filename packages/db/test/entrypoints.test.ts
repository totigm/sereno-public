import { describe, expect, it } from 'vitest'
import * as main from '@sereno/db'
import * as migrator from '@sereno/db/migrate'

// El dashboard importa `@sereno/db`: la entrada principal no arrastra el migrador
// (`drizzle-orm/node-postgres/migrator`, `node:url`), que vive en su subruta.
describe('entradas de @sereno/db', () => {
  it('la principal trae clientes, esquema y repos, pero no el migrador', () => {
    expect(main).toHaveProperty('createDbFromUrl')
    expect(main).toHaveProperty('createRepos')
    expect(main).not.toHaveProperty('migrate')
    expect(main).not.toHaveProperty('MIGRATIONS_FOLDER')
  })

  it('@sereno/db/migrate expone el migrador', () => {
    expect(migrator.migrate).toBeTypeOf('function')
    expect(migrator.MIGRATIONS_FOLDER).toMatch(/migrations$/)
  })
})
