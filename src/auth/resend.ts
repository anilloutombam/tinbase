/**
 * Resend transport for auth emails (magic links, OTP codes, password recovery).
 *
 * The production counterpart of {@link import('./inbox.js').InboxMailer}: where the
 * inbox keeps messages in memory for local development, this hands each one to
 * Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Configured from the CLI via `TINBASE_RESEND_API_KEY` + `TINBASE_MAIL_FROM`; when
 * either is missing the inbox stays in place, so a misconfigured deploy fails
 * loudly at startup rather than silently swallowing every reset email.
 */
import type { MailMessage, Mailer } from '../types.js'

export interface ResendMailerOptions {
  apiKey: string
  /** RFC 5322 sender, e.g. `Savor <noreply@rnproject.dev>`. The domain must be verified in Resend. */
  from: string
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch
  /** Override the API endpoint (tests, proxies). */
  endpoint?: string
}

/** A `from` address needs at least a mailbox@domain; a display name around it is optional. */
export function isValidFrom(from: string): boolean {
  const addr = from.match(/<([^>]+)>\s*$/)?.[1] ?? from
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr.trim())
}

export class ResendMailer implements Mailer {
  private readonly fetch: typeof fetch
  private readonly endpoint: string

  constructor(private readonly opts: ResendMailerOptions) {
    if (!opts.apiKey) throw new Error('ResendMailer: apiKey is required')
    if (!isValidFrom(opts.from)) throw new Error(`ResendMailer: invalid from address "${opts.from}"`)
    this.fetch = opts.fetch ?? globalThis.fetch
    this.endpoint = opts.endpoint ?? 'https://api.resend.com/emails'
  }

  async send(msg: MailMessage): Promise<void> {
    const res = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: this.opts.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    })
    if (!res.ok) {
      // Surface Resend's reason (unverified domain, bad key, rate limit) without
      // echoing the message body, which carries the OTP / link.
      let detail = ''
      try {
        const body = (await res.json()) as { message?: string; name?: string }
        detail = body.message ?? body.name ?? ''
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`Resend rejected mail to ${msg.to}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
    }
  }
}
