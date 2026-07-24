/**
 * Coerce a value that may already be a JS array or may be a raw Postgres array
 * literal string (`{a,b,"c d"}`) into a string array. The native wire decoder
 * maps common array OIDs to JS arrays, but exotic element types (or a different
 * engine) can surface the raw literal - normalizing here keeps catalog views
 * (roles, index lists, trigger events, enum values) from calling array methods
 * on a string.
 */
export function pgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (v == null ? '' : String(v)))
  if (typeof value !== 'string') return value == null ? [] : [String(value)]
  const s = value.trim()
  if (!(s.startsWith('{') && s.endsWith('}'))) return s === '' ? [] : [s]
  const inner = s.slice(1, -1)
  if (inner === '') return []
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quoted) {
      if (c === '\\') {
        cur += inner[++i] ?? ''
      } else if (c === '"') {
        quoted = false
      } else {
        cur += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out.map((x) => (x === 'NULL' ? '' : x))
}
