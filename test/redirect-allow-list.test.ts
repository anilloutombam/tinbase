import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage } from '../src/index.js'
import { isAllowedRedirect, resolveRedirect } from '../src/auth/redirect.js'

/**
 * The redirect allowlist, which is what decides where an emailed link can send
 * a user. Enforced once the server binds a network-exposed host, so a deployed
 * project only reaches its own reset page if that origin is allowed - by the
 * project's `additional_redirect_urls` or by the platform's
 * TINBASE_URI_ALLOW_LIST (the CLI merges the two).
 */
describe('resolveRedirect', () => {
  const site = 'https://abc-db.example.dev'

  it('honours any well-formed URL when not enforcing (local dev)', () => {
    expect(resolveRedirect('http://localhost:8081/reset', site, [], false)).toBe('http://localhost:8081/reset')
    expect(resolveRedirect('not a url', site, [], false)).toBe(site)
  })

  it('allows same-origin targets without any allowlist entry', () => {
    expect(isAllowedRedirect(`${site}/anything`, site, [])).toBe(true)
  })

  it('falls back to the site URL for an origin that is not allowed', () => {
    // The failure this guards: the app lives on a different host than the
    // database, so without an entry the user lands on the db host instead of
    // the reset page.
    expect(resolveRedirect('https://abc-web.example.dev/reset-password.html', site, [], true)).toBe(site)
  })

  it('honours a target matched by an allowlist glob', () => {
    const allow = ['https://abc-web.example.dev/**']
    expect(resolveRedirect('https://abc-web.example.dev/reset-password.html', site, allow, true)).toBe(
      'https://abc-web.example.dev/reset-password.html'
    )
    // a different host that merely starts the same must not match
    expect(resolveRedirect('https://abc-web.example.dev.evil.test/x', site, allow, true)).toBe(site)
  })

  it('* stays within a path segment, ** crosses them', () => {
    expect(isAllowedRedirect('http://localhost:8081/reset', site, ['http://localhost:*/reset'])).toBe(true)
    expect(isAllowedRedirect('https://a.example.dev/x/y', site, ['https://a.example.dev/*'])).toBe(false)
    expect(isAllowedRedirect('https://a.example.dev/x/y', site, ['https://a.example.dev/**'])).toBe(true)
  })
})

describe('emailed recovery link honours the allowlist', () => {
  it('redirects to an allowed app origin, not the site URL', async () => {
    const outbox: MailMessage[] = []
    const backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      siteUrl: 'https://abc-db.example.dev',
      // what the platform injects for the project's own web workload
      uriAllowList: ['https://abc-web.example.dev/**'],
      // a non-loopback bind is what turns enforcement on, as in a container
      host: '0.0.0.0',
      jwtSecret: 'test-secret-at-least-32-characters-long',
    })
    try {
      const appUrl = 'https://abc-web.example.dev/reset-password.html'
      await backend.fetch(
        new Request(`https://abc-db.example.dev/auth/v1/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey },
          body: JSON.stringify({ email: 'reset@example.com', password: 'password123' }),
        })
      )
      await backend.fetch(
        new Request(`https://abc-db.example.dev/auth/v1/recover?redirect_to=${encodeURIComponent(appUrl)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey },
          body: JSON.stringify({ email: 'reset@example.com' }),
        })
      )
      const link = outbox[outbox.length - 1].text.match(/(https?:\S+verify\S+)/)?.[1]
      expect(link).toBeTruthy()

      const res = await backend.fetch(new Request(link!, { redirect: 'manual' }))
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toContain(`${appUrl}#access_token=`)
    } finally {
      await backend.close()
    }
  })

  it('falls back to the site URL when the app origin is not allowed', async () => {
    const outbox: MailMessage[] = []
    const backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      siteUrl: 'https://abc-db.example.dev',
      uriAllowList: [],
      host: '0.0.0.0',
      jwtSecret: 'test-secret-at-least-32-characters-long',
    })
    try {
      await backend.fetch(
        new Request(`https://abc-db.example.dev/auth/v1/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: backend.anonKey },
          body: JSON.stringify({ email: 'reset2@example.com', password: 'password123' }),
        })
      )
      await backend.fetch(
        new Request(
          `https://abc-db.example.dev/auth/v1/recover?redirect_to=${encodeURIComponent('https://abc-web.example.dev/reset-password.html')}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', apikey: backend.anonKey },
            body: JSON.stringify({ email: 'reset2@example.com' }),
          }
        )
      )
      const link = outbox[outbox.length - 1].text.match(/(https?:\S+verify\S+)/)?.[1]
      const res = await backend.fetch(new Request(link!, { redirect: 'manual' }))
      expect(res.headers.get('location')).toContain('https://abc-db.example.dev#access_token=')
    } finally {
      await backend.close()
    }
  })
})
