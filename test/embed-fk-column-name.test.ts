/**
 * Embeds addressed by fk column name or fk constraint name instead of the
 * target table name, per PostgREST resolution rules. `asset:asset_id(*)` must
 * resolve the fk column `asset_id` on the base table to its target table, and
 * a constraint name works in either direction.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'

const MIGRATION = `
create table assets (id text primary key, symbol text not null);
create table signals (
  id text primary key,
  asset_id text not null references assets(id),
  direction text not null
);
-- two fks to the same target: plain table-name embed is ambiguous
create table transfers (
  id text primary key,
  from_asset_id text not null references assets(id),
  to_asset_id text not null references assets(id)
);

insert into assets values ('a1', 'BTCUSD'), ('a2', 'ETHUSD');
insert into signals values ('s1', 'a1', 'bullish'), ('s2', 'a2', 'bearish');
insert into transfers values ('t1', 'a1', 'a2');
`

let backend: TinbaseBackend
let supabase: SupabaseClient

beforeAll(async () => {
  backend = await createBackend({ migrations: [{ name: '20240101000000_fkcol', sql: MIGRATION }] })
  const fetchAdapter: typeof fetch = (input, init) => backend.fetch(new Request(input, init))
  supabase = createClient('http://localhost:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchAdapter },
  })
})
afterAll(async () => {
  await backend.close()
})

describe('embeds via fk column / constraint name', () => {
  it('aliased fk-column embed returns a single object under the alias', async () => {
    const { data, error } = await supabase.from('signals').select('*, asset:asset_id(*)').eq('id', 's1')
    expect(error).toBeNull()
    const row = data![0] as { asset: { id: string; symbol: string } }
    expect(Array.isArray(row.asset)).toBe(false)
    expect(row.asset).toEqual({ id: 'a1', symbol: 'BTCUSD' })
  })

  it('unaliased fk-column embed keys the object by the column name', async () => {
    const { data, error } = await supabase.from('signals').select('id, asset_id(symbol)').eq('id', 's2')
    expect(error).toBeNull()
    expect(data![0]).toEqual({ id: 's2', asset_id: { symbol: 'ETHUSD' } })
  })

  it('fk constraint name resolves a forward (to-one) embed', async () => {
    const { data, error } = await supabase
      .from('signals')
      .select('id, asset:signals_asset_id_fkey(symbol)')
      .eq('id', 's1')
    expect(error).toBeNull()
    expect(data![0]).toEqual({ id: 's1', asset: { symbol: 'BTCUSD' } })
  })

  it('fk constraint name resolves a reverse (to-many) embed as an array', async () => {
    const { data, error } = await supabase
      .from('assets')
      .select('id, signals:signals_asset_id_fkey(direction)')
      .eq('id', 'a1')
    expect(error).toBeNull()
    expect(data![0]).toEqual({ id: 'a1', signals: [{ direction: 'bullish' }] })
  })

  it('fk-column embeds disambiguate two fks to the same target', async () => {
    const { data, error } = await supabase
      .from('transfers')
      .select('id, from:from_asset_id(symbol), to:to_asset_id(symbol)')
      .eq('id', 't1')
    expect(error).toBeNull()
    expect(data![0]).toEqual({ id: 't1', from: { symbol: 'BTCUSD' }, to: { symbol: 'ETHUSD' } })
  })

  it('plain table-name embed on an ambiguous relationship still errors (PGRST201)', async () => {
    const { error } = await supabase.from('transfers').select('id, assets(symbol)').eq('id', 't1')
    expect(error).not.toBeNull()
    expect(error!.code).toBe('PGRST201')
  })

  it('an unknown name still reports PGRST200', async () => {
    const { error } = await supabase.from('signals').select('id, nonsense_id(*)')
    expect(error).not.toBeNull()
    expect(error!.code).toBe('PGRST200')
  })
})
