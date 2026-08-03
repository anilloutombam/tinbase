import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, createPgmemEngine, type TinbaseBackend } from '../src/index.js'

/**
 * pg-mem ignores the schema qualifier, so it reports tinbase's own `auth.*`,
 * `storage.*` and `supabase_migrations.*` tables as living in `public`. They
 * aren't addressable there, so the studio listed 13 internal tables that could
 * not be opened and showed an unknown row count for each. The studio drops them
 * on that engine; the real engines keep them in their own schemas.
 */
const MIGRATION = `
create table todos (id text primary key, title text);
-- deliberately a name that is NOT one of tinbase's internals, to pin that a
-- user's own tables survive the filter
create table profiles (id text primary key, bio text);
`

async function tableNames(backend: TinbaseBackend, schema: string): Promise<string[]> {
  const res = await backend.fetch(
    new Request(`http://localhost:54321/admin/v1/tables?schema=${schema}`, {
      headers: {
        apikey: backend.serviceRoleKey,
        authorization: `Bearer ${backend.serviceRoleKey}`,
      },
    })
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tables?: { name: string }[] } | { name: string }[]
  const list = Array.isArray(body) ? body : (body.tables ?? [])
  return list.map((t) => t.name)
}

describe('studio table list hides tinbase internals on the subset engine', () => {
  let backend: TinbaseBackend

  beforeAll(async () => {
    const engine = await createPgmemEngine()
    backend = await createBackend({ engine, migrations: [{ name: 'm', sql: MIGRATION }] })
  })

  afterAll(async () => {
    await backend.close()
  })

  it('lists only the project’s own tables in public', async () => {
    const names = await tableNames(backend, 'public')
    expect(names.sort()).toEqual(['profiles', 'todos'])
  })

  it('hides the internals that pg-mem misreports into public', async () => {
    const names = await tableNames(backend, 'public')
    for (const internal of ['users', 'refresh_tokens', 'one_time_tokens', 'identities', 'buckets', 'objects', 'schema_migrations']) {
      expect(names).not.toContain(internal)
    }
  })
})

describe('the real engines keep their internal schemas visible', () => {
  let backend: TinbaseBackend

  beforeAll(async () => {
    backend = await createBackend({ migrations: [{ name: 'm', sql: MIGRATION }] })
  })

  afterAll(async () => {
    await backend.close()
  })

  it('public holds only the project’s tables, as it always did', async () => {
    const names = await tableNames(backend, 'public')
    expect(names.sort()).toEqual(['profiles', 'todos'])
  })

  it('auth is still browsable - the filter is scoped to public on the subset engine', async () => {
    const names = await tableNames(backend, 'auth')
    expect(names).toContain('users')
    expect(names).toContain('refresh_tokens')
  })
})
