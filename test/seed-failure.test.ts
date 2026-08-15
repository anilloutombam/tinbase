import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

// A seed that fails must never take the server down. Seeding re-runs whenever
// seed.sql's hash changes, so an edited seed meets a database that already
// holds the old rows; and if a migration failed, the seed references tables
// that were never created. In production both crashed tinbase at startup and
// left the project permanently unreachable, even though the schema was applied
// and every request would have been served correctly.

const T = 30_000

let backend: TinbaseBackend | null = null
afterEach(async () => {
  if (backend) await backend.close()
  backend = null
})

const MIGRATION = {
  name: '20240101000000_notes',
  sql: `create table notes (id text primary key, title text);`,
}

describe('a failing seed leaves the server up', () => {
  it(
    'serves the schema when the seed collides with rows that already exist',
    async () => {
      const seedSql = `insert into notes (id, title) values ('a', 'first');`
      backend = await createBackend({ migrations: [MIGRATION], seedSql })
      const first = await backend.db.query(`select count(*)::int as n from notes`)
      expect(first.rows[0].n).toBe(1)

      // Re-running the same seed on the same database is what a hash change
      // does: the rows are already there, so it fails on the primary key.
      const applied = await backend.migrate([MIGRATION], `${seedSql} -- edited`)

      expect(applied).not.toContain('seed.sql')
      const after = await backend.db.query(`select count(*)::int as n from notes`)
      expect(after.rows[0].n).toBe(1) // rolled back, not doubled
    },
    T
  )

  it(
    'starts when the seed references a table that does not exist',
    async () => {
      backend = await createBackend({
        migrations: [MIGRATION],
        seedSql: `insert into menu_items (id) values ('x');`,
      })

      // The database is up and the schema that DID apply is queryable.
      const res = await backend.db.query(`select count(*)::int as n from notes`)
      expect(res.rows[0].n).toBe(0)
    },
    T
  )

  it(
    'does not record the hash, so a corrected seed applies on the next start',
    async () => {
      backend = await createBackend({
        migrations: [MIGRATION],
        seedSql: `insert into nope (id) values ('x');`,
      })

      const fixed = await backend.migrate([MIGRATION], `insert into notes (id) values ('ok');`)
      expect(fixed).toContain('seed.sql')
      const res = await backend.db.query(`select id from notes`)
      expect(res.rows.map((r: { id: string }) => r.id)).toEqual(['ok'])
    },
    T
  )
})
