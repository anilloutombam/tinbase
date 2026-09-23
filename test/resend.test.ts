import { describe, expect, it } from 'vitest'
import { ResendMailer, isValidFrom } from '../src/auth/resend.js'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

describe('ResendMailer', () => {
  it('posts the message to Resend with the bearer key and configured sender', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 'msg_1' })
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'Savor <noreply@rnproject.dev>', fetch })

    await mailer.send({ to: 'riya@example.com', subject: 'Reset your password', text: 'link + code' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer re_test')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: 'Savor <noreply@rnproject.dev>',
      to: ['riya@example.com'],
      subject: 'Reset your password',
      text: 'link + code',
    })
  })

  it("surfaces Resend's error without the message body", async () => {
    const { fetch } = fakeFetch(403, { name: 'validation_error', message: 'The rnproject.dev domain is not verified' })
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'noreply@rnproject.dev', fetch })

    await expect(
      mailer.send({ to: 'riya@example.com', subject: 'Reset your password', text: 'SECRET-CODE-123456' })
    ).rejects.toThrow(/HTTP 403 The rnproject.dev domain is not verified/)
    await expect(
      mailer.send({ to: 'riya@example.com', subject: 'Reset your password', text: 'SECRET-CODE-123456' })
    ).rejects.not.toThrow(/SECRET-CODE/)
  })

  it('refuses to construct without a key or with an unusable sender', () => {
    expect(() => new ResendMailer({ apiKey: '', from: 'noreply@rnproject.dev' })).toThrow(/apiKey/)
    expect(() => new ResendMailer({ apiKey: 're_test', from: 'Savor' })).toThrow(/invalid from/)
  })

  it('isValidFrom accepts bare and display-name senders', () => {
    expect(isValidFrom('noreply@rnproject.dev')).toBe(true)
    expect(isValidFrom('Savor <noreply@rnproject.dev>')).toBe(true)
    expect(isValidFrom('noreply@localhost')).toBe(false)
    expect(isValidFrom('<>')).toBe(false)
  })
})
