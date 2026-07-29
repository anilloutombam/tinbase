/**
 * Minimal HS256 JWT implementation on WebCrypto.
 * Works in Node (>=18) and browsers - no dependencies.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  )
}

/** Standard + Supabase/GoTrue claims carried in an access token. Open-ended: any extra claims are preserved. */
export interface JwtClaims {
  [key: string]: unknown
  sub?: string
  role?: string
  exp?: number
  iat?: number
  iss?: string
  aud?: string
  email?: string
  /** authenticator assurance level: 'aal1' (single-factor) or 'aal2' (MFA-verified) */
  aal?: string
  /** authentication methods references, e.g. [{ method: 'password' | 'totp', timestamp }] */
  amr?: { method: string; timestamp: number }[]
}

/** Sign claims as an HS256 JWT. */
export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)))
  const data = `${header}.${payload}`
  const key = await hmacKey(secret, 'sign')
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return `${data}.${bytesToBase64Url(new Uint8Array(sig))}`
}

/** Verifies signature and expiry. Returns claims, or null when invalid. */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  try {
    // Pin the algorithm to HS256 - reject alg:"none" and any alg-swap attempt
    // rather than relying on the HMAC verify to fail.
    const head = JSON.parse(decoder.decode(base64UrlToBytes(header))) as { alg?: string; typ?: string }
    if (head.alg !== 'HS256') return null
    const key = await hmacKey(secret, 'verify')
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature) as BufferSource,
      encoder.encode(`${header}.${payload}`)
    )
    if (!valid) return null
    const claims = JSON.parse(decoder.decode(base64UrlToBytes(payload))) as JwtClaims
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

/** Expiry claim (2032-11-11) shared by all deterministic dev keys — the same value Supabase's local demo keys use. */
export const DEMO_KEY_EXP = 1983812996

/**
 * Derive the anon/service_role API keys for a backend.
 *
 * `'deterministic'` (local dev): signs the same fixed claims Supabase's local
 * stack uses (`iss: "supabase-demo"`, `exp` {@link DEMO_KEY_EXP}), so the keys
 * are stable across restarts and machines — with the default secret they are
 * byte-identical to the well-known Supabase demo keys, so a `.env.local` can be
 * committed and shared.
 *
 * `'unique'` (production): signs fresh claims with `iat` = now and a 10-year
 * expiry, so every start yields distinct keys.
 */
export async function deriveApiKeys(
  jwtSecret: string,
  mode: 'deterministic' | 'unique' = 'deterministic'
): Promise<{ anonKey: string; serviceRoleKey: string }> {
  if (mode === 'unique') {
    const now = Math.floor(Date.now() / 1000)
    const exp = now + 10 * 365 * 24 * 3600
    return {
      anonKey: await signJwt({ iss: 'supabase', ref: 'tinbase', role: 'anon', iat: now, exp }, jwtSecret),
      serviceRoleKey: await signJwt({ iss: 'supabase', ref: 'tinbase', role: 'service_role', iat: now, exp }, jwtSecret),
    }
  }
  return {
    anonKey: await signJwt({ iss: 'supabase-demo', role: 'anon', exp: DEMO_KEY_EXP }, jwtSecret),
    serviceRoleKey: await signJwt({ iss: 'supabase-demo', role: 'service_role', exp: DEMO_KEY_EXP }, jwtSecret),
  }
}

/** Decode without verification (for introspection/debugging only). */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(decoder.decode(base64UrlToBytes(parts[1])))
  } catch {
    return null
  }
}

/** A URL-safe random token (base64url of `bytes` CSPRNG bytes). Used for refresh/one-time/link tokens. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return bytesToBase64Url(buf)
}
