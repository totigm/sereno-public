// `@sereno/db`: clientes Drizzle (directo, pooled o elegido por la URL), esquema
// tipado y los repositorios que usan el bot y el dashboard. El migrador va aparte,
// en `@sereno/db/migrate`, así el dashboard no carga `drizzle-orm/node-postgres/migrator`.
export * from './client'
export * from './schema'
export * from './repos'
