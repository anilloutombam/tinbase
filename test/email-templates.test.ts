import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, htmlToText, renderTemplate, type MailMessage, type TinbaseBackend } from '../src/index.js'

const VARS = {
  ConfirmationURL: 'https://db.example.dev/auth/v1/verify?token=abc&type=recovery',
  Token: '123456',
  TokenHash: 'abc',
  RedirectTo: 'https://app.example.dev/reset',
  SiteURL: 'https://db.example.dev',
  Email: 'user@example.com',
}

describe('renderTemplate', () => {
  it('substitutes every documented variable, whatever the inner spacing', () => {
    const out = renderTemplate(
      '{{ .ConfirmationURL }}|{{.Token}}|{{  .TokenHash  }}|{{ .RedirectTo }}|{{ .SiteURL }}|{{ .Email }}',
      VARS
    )
    expect(out).toBe(
      [VARS.ConfirmationURL, VARS.Token, VARS.TokenHash, VARS.RedirectTo, VARS.SiteURL, VARS.Email].join('|')
    )
  })

  it('leaves an unknown placeholder as written rather than blanking it', () => {
    // A typo that renders as empty produces a link to nowhere and no clue why;
    // left intact it is visible in the delivered mail.
    expect(renderTemplate('go to {{ .ConfirmatoinURL }}', VARS)).toBe('go to {{ .ConfirmatoinURL }}')
  })

  it('leaves text without placeholders untouched', () => {
    expect(renderTemplate('<p>Hello</p>', VARS)).toBe('<p>Hello</p>')
  })
})

describe('htmlToText', () => {
  it('keeps the href, which is the point of these emails', () => {
    expect(htmlToText('<p>Hi</p><a href="https://x.test/go">Reset password</a>')).toBe(
      'Hi\nReset password: https://x.test/go'
    )
  })

  it('does not repeat the URL when the label already is the URL', () => {
    expect(htmlToText('<a href="https://x.test/go">https://x.test/go</a>')).toBe('https://x.test/go')
  })

  it('drops style and script blocks and decodes entities', () => {
    expect(htmlToText('<style>a{color:red}</style><p>A &amp; B</p><script>x()</script>')).toBe('A & B')
  })
})

describe('a project template decides what the email offers', () => {
  let backend: TinbaseBackend
  let supabase: ReturnType<typeof createClient>
  const outbox: MailMessage[] = []

  beforeAll(async () => {
    backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      siteUrl: 'https://db.example.dev',
      emailTemplates: {
        // the case this feature exists for: a project whose reset screen takes a
        // typed code and never shows a link
        recovery: {
          subject: 'Your reset code',
          content: '<p>Enter this code to reset your password:</p><p><b>{{ .Token }}</b></p>',
        },
        // ...and one that links straight at its own page instead of via /verify
        magic_link: {
          content: '<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink">Sign in</a>',
        },
      },
    })
    supabase = createClient('http://localhost:54321', backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (i, init) => backend.fetch(new Request(i, init)) },
    })
  })
  afterAll(async () => {
    await backend.close()
  })

  it('can offer the code only, with no link anywhere in the message', async () => {
    await supabase.auth.signUp({ email: 'codeonly@example.com', password: 'oldpassword1' })
    await supabase.auth.signOut()
    await supabase.auth.resetPasswordForEmail('codeonly@example.com')

    const mail = outbox[outbox.length - 1]
    expect(mail.subject).toBe('Your reset code')
    const code = mail.text.match(/\b(\d{6})\b/)![1]
    expect(mail.html).toContain(`<b>${code}</b>`)
    expect(mail.html).not.toContain('/auth/v1/verify')
    expect(mail.text).not.toContain('http')

    // and that code really does reset the password - the flow is usable
    const verified = await supabase.auth.verifyOtp({ email: 'codeonly@example.com', token: code, type: 'recovery' })
    expect(verified.error).toBeNull()
    const upd = await supabase.auth.updateUser({ password: 'newpassword2' })
    expect(upd.error).toBeNull()
    await supabase.auth.signOut()
    const relogin = await supabase.auth.signInWithPassword({
      email: 'codeonly@example.com',
      password: 'newpassword2',
    })
    expect(relogin.error).toBeNull()
    await supabase.auth.signOut()
  })

  it('can link straight at the app with token_hash, skipping /verify', async () => {
    await supabase.auth.signInWithOtp({
      email: 'direct@example.com',
      options: { emailRedirectTo: 'https://app.example.dev/welcome' },
    })
    const mail = outbox[outbox.length - 1]
    const href = mail.html!.match(/href="([^"]+)"/)![1]
    expect(href).toMatch(/^https:\/\/app\.example\.dev\/welcome\?token_hash=[^&]+&type=magiclink$/)

    // the token in that link is redeemable, which is what makes the shape work
    const tokenHash = new URL(href).searchParams.get('token_hash')!
    const verified = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'email' })
    expect(verified.error).toBeNull()
    await supabase.auth.signOut()
  })

  it('derives a text part so the message is still multipart', async () => {
    await supabase.auth.signUp({ email: 'multipart@example.com', password: 'oldpassword1' })
    await supabase.auth.signOut()
    await supabase.auth.resetPasswordForEmail('multipart@example.com')
    const mail = outbox[outbox.length - 1]
    expect(mail.text.length).toBeGreaterThan(0)
    expect(mail.text).not.toContain('<')
    expect(mail.text).toContain('Enter this code')
  })

  it('a type with no template keeps the built-in default', async () => {
    // confirmation has no override here
    const b = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      authSettings: { autoconfirm: false },
      emailTemplates: { recovery: { content: '<p>{{ .Token }}</p>' } },
    })
    try {
      const sb = createClient('http://localhost:54321', b.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (i, init) => b.fetch(new Request(i, init)) },
      })
      await sb.auth.signUp({ email: 'default@example.com', password: 'password123' })
      const mail = outbox[outbox.length - 1]
      expect(mail.subject).toBe('Confirm your email')
      expect(mail.text).toContain('/auth/v1/verify')
    } finally {
      await b.close()
    }
  })
})
