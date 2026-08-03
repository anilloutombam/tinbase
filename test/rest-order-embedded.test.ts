import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers.js'

/**
 * Ordering top-level rows by a to-one embedded column, PostgREST's
 * `order=relation(column)` (supabase-js `.order('relation(column)')`). The term
 * used to be taken as a literal column name and reached Postgres verbatim,
 * failing as 42703 (#79).
 */
let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

/** Author names in the order the rows came back, for a posts query. */
async function authorOrder(query: string): Promise<string[]> {
  const res = await env.backend.fetch(
    new Request(`http://localhost:54321/rest/v1/${query}`, {
      headers: { apikey: env.backend.serviceRoleKey, Authorization: `Bearer ${env.backend.serviceRoleKey}` },
    })
  )
  expect(res.status).toBe(200)
  const rows = (await res.json()) as { authors: { name: string } | null }[]
  return rows.map((r) => r.authors?.name ?? '(null)')
}

describe('order by an embedded to-one column', () => {
  it('orders ascending by the related column', async () => {
    const names = await authorOrder('posts?select=title,authors(name)&order=authors(name)')
    expect(names).toEqual([...names].sort())
  })

  it('orders descending', async () => {
    const asc = await authorOrder('posts?select=title,authors(name)&order=authors(name).asc')
    const desc = await authorOrder('posts?select=title,authors(name)&order=authors(name).desc')
    expect(desc).toEqual([...asc].reverse())
  })

  it('works through supabase-js .order()', async () => {
    const { data, error } = await env.admin
      .from('posts')
      .select('title, authors(name)')
      .order('authors(name)')
    expect(error).toBeNull()
    const names = (data as unknown as { authors: { name: string } | null }[]).map((r) => r.authors?.name ?? '')
    expect(names).toEqual([...names].sort())
  })

  it('combines with a top-level order term, related key first', async () => {
    const res = await env.backend.fetch(
      new Request(
        'http://localhost:54321/rest/v1/posts?select=title,authors(name)&order=authors(name).asc&order=title.desc',
        {
          headers: { apikey: env.backend.serviceRoleKey, Authorization: `Bearer ${env.backend.serviceRoleKey}` },
        }
      )
    )
    expect(res.status).toBe(200)
    const rows = (await res.json()) as { title: string; authors: { name: string } | null }[]
    const keys = rows.map((r) => [r.authors?.name ?? '', r.title] as const)
    // ascending by author, then descending by title within each author
    const expected = [...keys].sort((a, b) => (a[0] === b[0] ? b[1].localeCompare(a[1]) : a[0].localeCompare(b[0])))
    expect(keys).toEqual(expected)
  })

  it('honours nullslast on the related column', async () => {
    const res = await env.backend.fetch(
      new Request('http://localhost:54321/rest/v1/posts?select=title,authors(name)&order=authors(name).asc.nullslast', {
        headers: { apikey: env.backend.serviceRoleKey, Authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    expect(res.status).toBe(200)
  })

  it('rejects ordering by a to-many relationship', async () => {
    // authors -> posts is to-many, so there is no single value per author row
    const res = await env.backend.fetch(
      new Request('http://localhost:54321/rest/v1/authors?select=name,posts(title)&order=posts(title)', {
        headers: { apikey: env.backend.serviceRoleKey, Authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('to-many')
  })

  it('reports an unknown relationship rather than passing it to Postgres', async () => {
    const res = await env.backend.fetch(
      new Request('http://localhost:54321/rest/v1/posts?select=title&order=nosuchtable(name)', {
        headers: { apikey: env.backend.serviceRoleKey, Authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    // PGRST200, not a raw 42703 from Postgres
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('PGRST200')
  })

  it('still rejects a genuinely unknown plain column', async () => {
    const res = await env.backend.fetch(
      new Request('http://localhost:54321/rest/v1/posts?select=title&order=nosuchcolumn', {
        headers: { apikey: env.backend.serviceRoleKey, Authorization: `Bearer ${env.backend.serviceRoleKey}` },
      })
    )
    expect(res.status).toBe(400)
  })
})
