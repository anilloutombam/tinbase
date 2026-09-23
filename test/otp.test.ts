import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend, type MailMessage } from '../src/index.js'

let backend: TinbaseBackend
let supabase: ReturnType<typeof createClient>
const outbox: MailMessage[] = []

const lastCode = () => outbox[outbox.length - 1].text.match(/code is (\d{6})|use code (\d{6})/)?.slice(1).find(Boolean)
const lastLink = () => outbox[outbox.length - 1].text.match(/(http\S+verify\S+)/)?.[1]

beforeAll(async () => {
  backend = await createBackend({ mailer: { send: async (m) => void outbox.push(m) } })
  supabase = createClient('http://localhost:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
  })
})

afterAll(async () => {
  await backend.close()
})

describe('otp / magic links / recovery', () => {
  it('signInWithOtp mails a code and verifyOtp returns a session', async () => {
    const { error } = await supabase.auth.signInWithOtp({ email: 'otp@example.com' })
    expect(error).toBeNull()
    expect(outbox.length).toBeGreaterThan(0)
    const code = lastCode()!
    expect(code).toMatch(/^\d{6}$/)

    const verified = await supabase.auth.verifyOtp({ email: 'otp@example.com', token: code, type: 'email' })
    expect(verified.error).toBeNull()
    expect(verified.data.session?.access_token).toBeTruthy()
    expect(verified.data.user?.email).toBe('otp@example.com')
    await supabase.auth.signOut()
  })

  it('expired/invalid codes are rejected', async () => {
    await supabase.auth.signInWithOtp({ email: 'otp2@example.com' })
    const bad = await supabase.auth.verifyOtp({ email: 'otp2@example.com', token: '000000', type: 'email' })
    expect(bad.error).not.toBeNull()
  })

  it('magic link redeems via GET and redirects with tokens in the hash', async () => {
    await supabase.auth.signInWithOtp({ email: 'link@example.com' })
    const link = lastLink()!
    const res = await backend.fetch(new Request(`${link}&redirect_to=http://app.local/welcome`, { redirect: 'manual' }))
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toContain('http://app.local/welcome#access_token=')
    expect(location).toContain('refresh_token=')
  })

  it('password recovery flow resets the password', async () => {
    await supabase.auth.signUp({ email: 'reset@example.com', password: 'oldpassword1' })
    await supabase.auth.signOut()

    const { error } = await supabase.auth.resetPasswordForEmail('reset@example.com')
    expect(error).toBeNull()
    const code = lastCode()!

    const verified = await supabase.auth.verifyOtp({ email: 'reset@example.com', token: code, type: 'recovery' })
    expect(verified.error).toBeNull()

    const upd = await supabase.auth.updateUser({ password: 'newpassword2' })
    expect(upd.error).toBeNull()
    await supabase.auth.signOut()

    const relogin = await supabase.auth.signInWithPassword({ email: 'reset@example.com', password: 'newpassword2' })
    expect(relogin.error).toBeNull()
    await supabase.auth.signOut()
  })

  it('recovery for unknown email answers 200 without mailing or creating a user', async () => {
    // GoTrue parity: the response must not reveal whether the address has an account
    const before = outbox.length
    const { error } = await supabase.auth.resetPasswordForEmail('ghost@example.com')
    expect(error).toBeNull()
    expect(outbox.length).toBe(before)
    const login = await supabase.auth.signInWithOtp({ email: 'ghost@example.com', options: { shouldCreateUser: false } })
    expect(login.error).not.toBeNull()
  })

  it('recovery link carries redirectTo and lands there with a recovery session', async () => {
    await supabase.auth.signUp({ email: 'redirect@example.com', password: 'oldpassword1' })
    await supabase.auth.signOut()

    const { error } = await supabase.auth.resetPasswordForEmail('redirect@example.com', {
      redirectTo: 'http://app.local/reset-password',
    })
    expect(error).toBeNull()
    const link = lastLink()!
    expect(link).toContain(`redirect_to=${encodeURIComponent('http://app.local/reset-password')}`)

    const res = await backend.fetch(new Request(link, { redirect: 'manual' }))
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toContain('http://app.local/reset-password#access_token=')
    expect(location).toContain('type=recovery')
  })

  describe('pkce flow', () => {
    // A second client on flowType 'pkce' - what Supabase's SSR/Next.js helpers
    // default to. It keeps its code verifier in memory storage across the
    // resetPasswordForEmail -> exchangeCodeForSession round trip.
    let pkce: ReturnType<typeof createClient>
    beforeAll(() => {
      pkce = createClient('http://localhost:54321', backend.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, flowType: 'pkce' },
        global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
      })
    })

    const followLink = async (link: string) => {
      const res = await backend.fetch(new Request(link, { redirect: 'manual' }))
      expect(res.status).toBe(303)
      return new URL(res.headers.get('location')!)
    }

    it('recovery link yields ?code= and exchangeCodeForSession resets the password', async () => {
      await supabase.auth.signUp({ email: 'pkce@example.com', password: 'oldpassword1' })
      await supabase.auth.signOut()

      const { error } = await pkce.auth.resetPasswordForEmail('pkce@example.com', {
        redirectTo: 'http://app.local/reset-password',
      })
      expect(error).toBeNull()

      const landed = await followLink(lastLink()!)
      expect(landed.origin + landed.pathname).toBe('http://app.local/reset-password')
      expect(landed.hash).toBe('') // no tokens in the fragment
      const code = landed.searchParams.get('code')!
      expect(code).toBeTruthy()

      const exchanged = await pkce.auth.exchangeCodeForSession(code)
      expect(exchanged.error).toBeNull()
      expect(exchanged.data.session?.access_token).toBeTruthy()
      expect(exchanged.data.user?.email).toBe('pkce@example.com')

      const upd = await pkce.auth.updateUser({ password: 'newpassword2' })
      expect(upd.error).toBeNull()
      await pkce.auth.signOut()

      const relogin = await supabase.auth.signInWithPassword({ email: 'pkce@example.com', password: 'newpassword2' })
      expect(relogin.error).toBeNull()
      await supabase.auth.signOut()
    })

    it('auth code is single-use and bound to the verifier', async () => {
      await pkce.auth.signInWithOtp({ email: 'pkce-otp@example.com', options: { emailRedirectTo: 'http://app.local/cb' } })
      const code = (await followLink(lastLink()!)).searchParams.get('code')!

      // wrong verifier: a fresh pkce client never generated this challenge
      const stranger = createClient('http://localhost:54321', backend.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, flowType: 'pkce' },
        global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
      })
      await stranger.auth.signInWithOtp({ email: 'stranger@example.com' }) // seeds a verifier
      const stolen = await stranger.auth.exchangeCodeForSession(code)
      expect(stolen.error).not.toBeNull()

      // the failed attempt burnt the code; the rightful client can't use it either
      const replay = await pkce.auth.exchangeCodeForSession(code)
      expect(replay.error).not.toBeNull()
    })

    it('typing the 6-digit code still returns a session directly', async () => {
      await pkce.auth.signInWithOtp({ email: 'pkce-code@example.com' })
      const verified = await pkce.auth.verifyOtp({ email: 'pkce-code@example.com', token: lastCode()!, type: 'email' })
      expect(verified.error).toBeNull()
      expect(verified.data.session?.access_token).toBeTruthy()
      await pkce.auth.signOut()
    })
  })

  it('signup confirmation and magic-link emails carry emailRedirectTo', async () => {
    await supabase.auth.signInWithOtp({
      email: 'otp-redirect@example.com',
      options: { emailRedirectTo: 'http://app.local/welcome' },
    })
    expect(lastLink()).toContain(`redirect_to=${encodeURIComponent('http://app.local/welcome')}`)
  })
})
