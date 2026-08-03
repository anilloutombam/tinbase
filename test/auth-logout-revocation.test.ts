import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeJwt, signJwt } from '../src/jwt.js'
import { DEFAULT_JWT_SECRET } from '../src/types.js'
import { createTestEnv, type TestEnv } from './helpers.js'

/**
 * Logout has to be observable server-side (#78). A signed JWT stays valid until
 * expiry, so `/auth/v1/user` consults session state - which is the entire reason
 * server code validates with `getUser(jwt)` rather than verifying locally. If
 * logout only revoked refresh tokens, it was a no-op for those callers.
 */
let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

/** A fresh client so each test gets its own session, not a shared one. */
function client() {
  return createClient('http://localhost:54321', env.backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => env.backend.fetch(new Request(input as string, init)) },
  })
}

async function userWith(token: string): Promise<number> {
  const res = await env.backend.fetch(
    new Request('http://localhost:54321/auth/v1/user', {
      headers: { apikey: env.backend.anonKey, Authorization: `Bearer ${token}` },
    })
  )
  return res.status
}

async function signedIn(email: string): Promise<{ access: string; refresh: string }> {
  await env.admin.auth.admin.createUser({ email, password: 'password1234', email_confirm: true })
  const c = client()
  const { data, error } = await c.auth.signInWithPassword({ email, password: 'password1234' })
  expect(error).toBeNull()
  return { access: data.session!.access_token, refresh: data.session!.refresh_token }
}

async function logout(token: string, scope?: string): Promise<number> {
  const url = `http://localhost:54321/auth/v1/logout${scope ? `?scope=${scope}` : ''}`
  const res = await env.backend.fetch(
    new Request(url, { method: 'POST', headers: { apikey: env.backend.anonKey, Authorization: `Bearer ${token}` } })
  )
  return res.status
}

describe('logout revokes the session server-side', () => {
  it('rejects the access token on /user after logout', async () => {
    const { access } = await signedIn('logout-basic@example.test')
    expect(await userWith(access)).toBe(200)
    expect(await logout(access, 'global')).toBe(204)
    expect(await userWith(access)).toBe(401)
  })

  it('will not let the refresh token resurrect a logged-out session', async () => {
    const { access, refresh } = await signedIn('logout-refresh@example.test')
    expect(await logout(access, 'global')).toBe(204)
    const res = await env.backend.fetch(
      new Request('http://localhost:54321/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: env.backend.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('a refresh keeps the same session, so the new token works', async () => {
    const { access, refresh } = await signedIn('logout-keepalive@example.test')
    const res = await env.backend.fetch(
      new Request('http://localhost:54321/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: env.backend.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      })
    )
    expect(res.status).toBe(200)
    const next = (await res.json()) as { access_token: string }
    // same session across refresh: a refresh is not a new login, and a new id
    // would strand the token still in the client's hands
    expect(decodeJwt(next.access_token)!.session_id).toBe(decodeJwt(access)!.session_id)
    expect(await userWith(next.access_token)).toBe(200)
  })

  it('scope=local ends only the calling session', async () => {
    const email = 'logout-local@example.test'
    await env.admin.auth.admin.createUser({ email, password: 'password1234', email_confirm: true })
    const a = await client().auth.signInWithPassword({ email, password: 'password1234' })
    const b = await client().auth.signInWithPassword({ email, password: 'password1234' })
    const first = a.data.session!.access_token
    const second = b.data.session!.access_token

    expect(await logout(first, 'local')).toBe(204)
    expect(await userWith(first)).toBe(401)
    expect(await userWith(second)).toBe(200)
  })

  it('scope=others ends every session but the calling one', async () => {
    const email = 'logout-others@example.test'
    await env.admin.auth.admin.createUser({ email, password: 'password1234', email_confirm: true })
    const a = await client().auth.signInWithPassword({ email, password: 'password1234' })
    const b = await client().auth.signInWithPassword({ email, password: 'password1234' })
    const keep = a.data.session!.access_token
    const drop = b.data.session!.access_token

    expect(await logout(keep, 'others')).toBe(204)
    expect(await userWith(keep)).toBe(200)
    expect(await userWith(drop)).toBe(401)
  })

  it('scope=global ends every session', async () => {
    const email = 'logout-global@example.test'
    await env.admin.auth.admin.createUser({ email, password: 'password1234', email_confirm: true })
    const a = await client().auth.signInWithPassword({ email, password: 'password1234' })
    const b = await client().auth.signInWithPassword({ email, password: 'password1234' })
    const first = a.data.session!.access_token
    const second = b.data.session!.access_token

    expect(await logout(first, 'global')).toBe(204)
    expect(await userWith(first)).toBe(401)
    expect(await userWith(second)).toBe(401)
  })

  it('a token with no session_id claim is unaffected by logout', async () => {
    // The studio's impersonation token carries a sub but no session, so there is
    // nothing to revoke and it has to keep working - the check is conditional on
    // the claim being present, not a blanket requirement.
    const { data } = await env.admin.auth.admin.createUser({
      email: 'logout-nosession@example.test',
      password: 'password1234',
      email_confirm: true,
    })
    const userId = data.user!.id
    const now = Math.floor(Date.now() / 1000)
    const sessionless = await signJwt(
      { iss: 'supabase', ref: 'tinbase', role: 'authenticated', sub: userId, iat: now, exp: now + 3600 },
      DEFAULT_JWT_SECRET
    )
    expect(await userWith(sessionless)).toBe(200)

    // even after a global logout for that same user
    const signedInToken = (await client().auth.signInWithPassword({
      email: 'logout-nosession@example.test',
      password: 'password1234',
    })).data.session!.access_token
    expect(await logout(signedInToken, 'global')).toBe(204)
    expect(await userWith(signedInToken)).toBe(401)
    expect(await userWith(sessionless)).toBe(200)
  })
})
