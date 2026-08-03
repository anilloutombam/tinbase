import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, createPgmemEngine, type TinbaseBackend } from '../src/index.js'

/**
 * The studio's table list must show a project's own tables in `public` and keep
 * tinbase's internals in `auth`/`storage`, on every engine.
 *
 * This used to fail on pg-mem, which hardcoded `table_schema: 'public'` in
 * information_schema and so reported `auth.users`, `storage.objects` and the rest
 * as living in public - 13 internal tables listed beside the project's own, none
 * of them openable. Fixed upstream in @tinbase/pg-mem 3.4.0 rather than filtered
 * out here, so these tests double as a guard on that dependency floor: if the
 * engine regresses, this is what catches it.
 */
const MIGRATION = `
create table todos (id text primary key, title text);
create table profiles (id text primary key, bio text);
`

async function tableNames(backend: TinbaseBackend, schema: string): Promise<string[]> {
  const res = await backend.fetch(
    new Request(`http://localhost:54321/admin/v1/tables?schema=${schema}`, {
      headers: { apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}` },
    })
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tables?: { name: string }[] } | { name: string }[]
  const list = Array.isArray(body) ? body : (body.tables ?? [])
  return list.map((t) => t.name)
}

for (const engineName of ['pg-mem', 'default'] as const) {
  describe(`studio table list (${engineName} engine)`, () => {
    let backend: TinbaseBackend

    beforeAll(async () => {
      const engine = engineName === 'pg-mem' ? await createPgmemEngine() : undefined
      backend = await createBackend({ engine, migrations: [{ name: 'm', sql: MIGRATION }] })
    })

    afterAll(async () => {
      await backend.close()
    })

    it('lists only the project’s own tables in public', async () => {
      expect((await tableNames(backend, 'public')).sort()).toEqual(['profiles', 'todos'])
    })

    it('does not leak tinbase’s internals into public', async () => {
      const names = await tableNames(backend, 'public')
      for (const internal of ['users', 'refresh_tokens', 'one_time_tokens', 'identities', 'buckets', 'objects', 'schema_migrations']) {
        expect(names).not.toContain(internal)
      }
    })

    it('keeps the internals browsable in their own schemas', async () => {
      const auth = await tableNames(backend, 'auth')
      expect(auth).toContain('users')
      expect(auth).toContain('refresh_tokens')
      expect(await tableNames(backend, 'storage')).toContain('objects')
    })
  })
}
