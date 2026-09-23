import { describe, expect, it } from 'vitest'
import { createBackend, type MailMessage } from '../src/index.js'

/**
 * Every auth mail is logged, whichever transport carries it.
 *
 * Only the dev inbox used to log a line, so on a real deployment - the one
 * case where /inbox is not even mounted - nothing recorded that a
 * password-reset mail had been sent, and a transport that rejected it said so
 * only in the HTTP response to the end user.
 */
async function recoverWith(mailer: { send: (m: MailMessage) => Promise<void> }) {
  const logs: string[] = []
  const backend = await createBackend({ mailer, log: (m) => logs.push(m) })
  try {
    const headers = { 'content-type': 'application/json', apikey: backend.anonKey }
    await backend.fetch(
      new Request('http://localhost:54321/auth/v1/signup', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'logged@example.com', password: 'password123' }),
      })
    )
    const res = await backend.fetch(
      new Request('http://localhost:54321/auth/v1/recover', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'logged@example.com' }),
      })
    )
    return { logs, status: res.status }
  } finally {
    await backend.close()
  }
}

describe('mail logging', () => {
  it('logs a metadata-only line for a custom transport', async () => {
    const { logs } = await recoverWith({ send: async () => {} })
    const line = logs.find((l) => l.startsWith('[mail]'))
    expect(line).toBe('[mail] to=logged@example.com subject="Reset your password"')
    // the body carries the link and the OTP - it must never reach the log
    expect(logs.join('\n')).not.toMatch(/\b\d{6}\b/)
    expect(logs.join('\n')).not.toContain('/auth/v1/verify')
  })

  it('logs the reason when the transport rejects the mail, and still fails the request', async () => {
    const { logs, status } = await recoverWith({
      send: async () => {
        throw new Error('Resend rejected mail: HTTP 403 domain is not verified')
      },
    })
    const line = logs.find((l) => l.includes('[mail] FAILED'))
    expect(line).toContain('to=logged@example.com')
    expect(line).toContain('domain is not verified')
    // the error is not swallowed: the caller still learns the send failed
    expect(status).toBe(500)
  })
})
