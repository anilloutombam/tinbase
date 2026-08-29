import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { testEngine } from './helpers.js'

let backend: TinbaseBackend

const MIGRATION = `create table notes (id serial primary key, body text);`

const sql = async (query: string, extra: Record<string, unknown> = {}) => {
  const res = await backend.fetch(
    new Request('http://localhost:54321/admin/v1/sql', {
      method: 'POST',
      headers: {
        apikey: backend.serviceRoleKey,
        authorization: `Bearer ${backend.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, ...extra }),
    })
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  backend = await createBackend({ engine: await testEngine(), migrations: [{ name: '20240101000000_notes', sql: MIGRATION }] })
})

afterAll(async () => {
  await backend.close()
})

describe('admin sql multi-statement scripts', () => {
  it('runs a script of several statements instead of failing with 42601', async () => {
    const res = await sql(`
      create table a (id int);
      insert into a values (1), (2);
      select count(*)::int as n from a;
    `)
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([{ n: 2 }])
  })

  it('returns the last statement result, and applies every statement', async () => {
    const res = await sql(`insert into notes (body) values ('one'); select body from notes;`)
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([{ body: 'one' }])

    const count = await sql(`select count(*)::int as n from notes`)
    expect(count.body.rows[0].n).toBe(1)
  })

  it('reports an empty result when the script ends on a write', async () => {
    const res = await sql(`select 1 as x; insert into notes (body) values ('two');`)
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([])
    expect(res.body.affectedRows).toBe(1)
  })

  it('surfaces an error from a later statement in the script', async () => {
    const res = await sql(`select 1; select * from nope_does_not_exist;`)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(res.body)).toMatch(/nope_does_not_exist/)
  })

  it('does not split on a semicolon inside a string, comment, or dollar-quoted body', async () => {
    const res = await sql(`select 'a;b' as s -- trailing ; comment`)
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([{ s: 'a;b' }])

    const fn = await sql(`
      create function semi() returns text as $$ begin return 'x;y'; end $$ language plpgsql;
      select semi() as v;
    `)
    expect(fn.status).toBe(200)
    expect(fn.body.rows).toEqual([{ v: 'x;y' }])
  })

  it('keeps single-statement behavior unchanged, including typed decoding', async () => {
    const res = await sql(
      `select 1 as i, true as b, 1.5::float8 as f, '{"k":1}'::jsonb as j, null as n`
    )
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([{ i: 1, b: true, f: 1.5, j: { k: 1 }, n: null }])
  })

  it('runs a script through the run-as-role path with the role applied throughout', async () => {
    const res = await sql(`select current_setting('role') as r; select current_setting('role') as r;`, {
      role: 'authenticated',
    })
    expect(res.status).toBe(200)
    expect(res.body.rows[0].r).toBe('authenticated')
  })

  it('a trailing semicolon is still a single statement', async () => {
    const res = await sql(`select 42 as answer;`)
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([{ answer: 42 }])
  })
})
