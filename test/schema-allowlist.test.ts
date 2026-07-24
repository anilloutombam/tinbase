/**
 * REST exposed-schema allowlist (`dbSchemas` / config.toml `[api].schemas`).
 *
 * PostgREST only lets anon/authenticated profile into the configured schemas
 * and answers 406 (`PGRST106`) otherwise; the service_role key reaches any
 * schema so the studio can browse cross-schema. This is a breaking security
 * boundary, so it gets direct coverage here (the happy path only proved that
 * `public` still works).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

const MIGRATION = `
create table public.widgets (id serial primary key, name text not null);
insert into public.widgets (name) values ('alpha');

create schema private_s;
create table private_s.secret_notes (id serial primary key, note text not null);
insert into private_s.secret_notes (note) values ('classified');

-- Grants so an *exposed* / service_role read actually returns rows; the 406
-- boundary is about exposure, not grants, and must fire before these matter.
grant usage on schema private_s to anon, authenticated, service_role;
grant select on all tables in schema private_s to anon, authenticated, service_role;
`

/** Build a backend + anon/service-role clients, honoring TINBASE_TEST_ENGINE=native like the shared helper. */
async function makeBackend(dbSchemas?: string[]) {
  let engine
  if (process.env.TINBASE_TEST_ENGINE === 'native') {
    const { createNativeEngine } = await import('../src/node/native/engine.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    engine = await createNativeEngine({ dataDir: join(mkdtempSync(join(tmpdir(), 'tinbase-test-')), 'pgdata') })
  }
  const backend = await createBackend({
    engine,
    dbSchemas,
    migrations: [{ name: '20240101000000_allowlist', sql: MIGRATION }],
  })
  const fetchAdapter: typeof fetch = (input, init) => backend.fetch(new Request(input, init))
  const opts = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchAdapter } }
  return {
    backend,
    anon: createClient('http://localhost:54321', backend.anonKey, opts),
    admin: createClient('http://localhost:54321', backend.serviceRoleKey, opts),
  }
}

describe('schema allowlist (default: public only)', () => {
  let backend: TinbaseBackend
  let anon: SupabaseClient
  let admin: SupabaseClient

  beforeAll(async () => {
    ;({ backend, anon, admin } = await makeBackend())
  })
  afterAll(async () => {
    await backend.close()
  })

  it('anon can read the exposed public schema', async () => {
    const { data, error } = await anon.from('widgets').select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('anon is rejected with PGRST106 when profiling into an unexposed schema', async () => {
    const { data, error } = await anon.schema('private_s').from('secret_notes').select()
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error!.code).toBe('PGRST106')
  })

  it('service_role bypasses the allowlist and reaches the unexposed schema', async () => {
    const { data, error } = await admin.schema('private_s').from('secret_notes').select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect((data![0] as { note: string }).note).toBe('classified')
  })
})

describe('schema allowlist (private_s added to dbSchemas)', () => {
  let backend: TinbaseBackend
  let anon: SupabaseClient

  beforeAll(async () => {
    ;({ backend, anon } = await makeBackend(['public', 'private_s']))
  })
  afterAll(async () => {
    await backend.close()
  })

  it('anon can now reach the newly exposed schema', async () => {
    const { data, error } = await anon.schema('private_s').from('secret_notes').select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })
})
