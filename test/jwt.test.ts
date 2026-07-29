import { describe, expect, it } from 'vitest'
import { deriveApiKeys, signJwt, verifyJwt } from '../src/jwt.js'
import { DEFAULT_JWT_SECRET } from '../src/types.js'

const SECRET = 'test-secret-at-least-32-characters-long!!'

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

describe('jwt', () => {
  it('signs and verifies a valid HS256 token', async () => {
    const token = await signJwt({ sub: 'u1', role: 'authenticated' }, SECRET)
    const claims = await verifyJwt(token, SECRET)
    expect(claims?.sub).toBe('u1')
  })

  it('rejects an expired token', async () => {
    const token = await signJwt({ sub: 'u1', exp: 1 }, SECRET)
    expect(await verifyJwt(token, SECRET)).toBeNull()
  })

  it('rejects a bad signature', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET)
    expect(await verifyJwt(token, 'a-different-secret-that-is-also-32-chars')).toBeNull()
  })

  it('rejects an alg:none token (header alg is pinned to HS256)', async () => {
    // an attacker crafts a token with alg:none and no/empty signature
    const forged = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'admin', role: 'service_role' })}.`
    expect(await verifyJwt(forged, SECRET)).toBeNull()
  })

  it('rejects a token whose header claims a non-HS256 alg', async () => {
    const valid = await signJwt({ sub: 'u1' }, SECRET)
    const [, payload, sig] = valid.split('.')
    const swapped = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${payload}.${sig}`
    expect(await verifyJwt(swapped, SECRET)).toBeNull()
  })
})

describe('deriveApiKeys', () => {
  it('with the default secret, deterministic keys are byte-identical to the Supabase demo keys', async () => {
    const { anonKey, serviceRoleKey } = await deriveApiKeys(DEFAULT_JWT_SECRET)
    expect(anonKey).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
    )
    expect(serviceRoleKey).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
    )
  })

  it('deterministic keys are stable across calls for a custom secret and verify against it', async () => {
    const a = await deriveApiKeys(SECRET)
    const b = await deriveApiKeys(SECRET)
    expect(a).toEqual(b)
    expect((await verifyJwt(a.anonKey, SECRET))?.role).toBe('anon')
    expect((await verifyJwt(a.serviceRoleKey, SECRET))?.role).toBe('service_role')
  })

  it('unique mode signs fresh keys carrying an iat', async () => {
    const { anonKey } = await deriveApiKeys(SECRET, 'unique')
    const claims = await verifyJwt(anonKey, SECRET)
    expect(claims?.role).toBe('anon')
    expect(typeof claims?.iat).toBe('number')
  })
})
