/**
 * Auth email templates, in GoTrue's shape.
 *
 * A project supplies HTML per email type and decides what the message offers -
 * the link, the 6-digit code, both, or a `?token_hash=` URL straight to its own
 * page - by choosing which variables it interpolates. That is the same contract
 * as Supabase's dashboard templates, so a project can move between the two
 * without rewriting its mail.
 *
 * Without a template the built-in default is used, so this is opt-in.
 */

/** The email types a project can override. Keys match Supabase's config.toml. */
export type EmailTemplateName = 'recovery' | 'magic_link' | 'confirmation' | 'invite' | 'email_change'

/** One override: the body, and optionally the subject line. */
export interface EmailTemplate {
  /** HTML body with `{{ .Variable }}` placeholders. */
  content?: string
  /** Subject line; the built-in default is used when absent. */
  subject?: string
}

export type EmailTemplates = Partial<Record<EmailTemplateName, EmailTemplate>>

/**
 * Values a template may interpolate, named as GoTrue names them.
 *
 * `ConfirmationURL` is the ready-made link through `/auth/v1/verify`, which
 * redirects on to the app. `TokenHash` is the raw token behind it, for a
 * template that would rather link straight at its own page
 * (`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`) and call
 * `verifyOtp` there - the shape that survives being opened on a different
 * device. `Token` is the 6-digit code, for a code-entry screen.
 */
export interface TemplateVars {
  ConfirmationURL: string
  Token: string
  TokenHash: string
  RedirectTo: string
  SiteURL: string
  Email: string
}

/** `{{ .Name }}`, tolerating any inner spacing, as Go's template syntax does. */
const PLACEHOLDER = /\{\{\s*\.(\w+)\s*\}\}/g

/**
 * Substitute `{{ .Var }}` placeholders.
 *
 * An unknown name is left as written rather than blanked: a typo then shows up
 * in the delivered mail instead of silently producing a link to nowhere.
 * Values are inserted verbatim - a template is operator-supplied HTML, and the
 * values are URLs and codes this server just minted.
 */
export function renderTemplate(content: string, vars: TemplateVars): string {
  return content.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name as keyof TemplateVars]) : whole
  )
}

/**
 * A plain-text companion for an HTML template, so the message is still
 * multipart: some clients prefer text, and a text part is one of the things
 * spam filters look for.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // keep the href of a link, which is the whole point of these emails
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return text && !text.includes(href) ? `${text}: ${href}` : href
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
