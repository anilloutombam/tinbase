/**
 * One-to-one embed cardinality (issue #65). A reverse embed is normally
 * one-to-many (JSON array), but when the foreign key on the target is a unique
 * key (its PK or a UNIQUE constraint) the relationship is one-to-one and
 * PostgREST serializes it as a single object, not an array.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

const MIGRATION = `
create table sites (id uuid primary key, name text);
-- fk IS the pk -> one-to-one
create table site_meta (site_id uuid primary key references sites(id), note text);
-- fk has a standalone UNIQUE constraint -> one-to-one
create table site_config (id serial primary key, site_id uuid unique references sites(id), theme text);
-- plain fk (not unique) -> one-to-many
create table events (id serial primary key, site_id uuid references sites(id), kind text);

insert into sites values
  ('00000000-0000-0000-0000-000000000001', 'alpha'),
  ('00000000-0000-0000-0000-000000000002', 'beta');
insert into site_meta values ('00000000-0000-0000-0000-000000000001', 'hello');
insert into site_config (site_id, theme) values ('00000000-0000-0000-0000-000000000001', 'dark');
insert into events (site_id, kind) values
  ('00000000-0000-0000-0000-000000000001', 'view'),
  ('00000000-0000-0000-0000-000000000001', 'click');
`

let backend: TinbaseBackend
let supabase: SupabaseClient

beforeAll(async () => {
  backend = await createBackend({ migrations: [{ name: '20240101000000_embed', sql: MIGRATION }] })
  const fetchAdapter: typeof fetch = (input, init) => backend.fetch(new Request(input, init))
  supabase = createClient('http://localhost:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchAdapter },
  })
})
afterAll(async () => {
  await backend.close()
})

describe('one-to-one embeds (issue #65)', () => {
  it('fk-is-pk reverse embed returns a single object', async () => {
    const { data, error } = await supabase.from('sites').select('id,site_meta(note)').eq('name', 'alpha')
    expect(error).toBeNull()
    const meta = (data![0] as { site_meta: unknown }).site_meta
    expect(Array.isArray(meta)).toBe(false)
    expect(meta).toEqual({ note: 'hello' })
  })

  it('fk-with-unique-constraint reverse embed returns a single object', async () => {
    const { data, error } = await supabase.from('sites').select('id,site_config(theme)').eq('name', 'alpha')
    expect(error).toBeNull()
    const cfg = (data![0] as { site_config: unknown }).site_config
    expect(Array.isArray(cfg)).toBe(false)
    expect(cfg).toEqual({ theme: 'dark' })
  })

  it('one-to-one embed with no related row is null', async () => {
    const { data, error } = await supabase.from('sites').select('id,site_meta(note)').eq('name', 'beta')
    expect(error).toBeNull()
    expect((data![0] as { site_meta: unknown }).site_meta).toBeNull()
  })

  it('a genuine one-to-many reverse embed still returns an array', async () => {
    const { data, error } = await supabase.from('sites').select('id,events(kind)').eq('name', 'alpha')
    expect(error).toBeNull()
    const events = (data![0] as { events: unknown }).events
    expect(Array.isArray(events)).toBe(true)
    expect((events as unknown[]).length).toBe(2)
  })
})
