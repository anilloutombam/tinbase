/**
 * Shared SQL statement splitter.
 *
 * Used by the pg-mem engine (which runs a script one statement at a time) and
 * by the admin SQL editor (which needs to know whether a script holds more than
 * one command before choosing a protocol).
 */
/**
 * Split SQL into statements on top-level `;`. Respects $tag$…$tag$ dollar-quoted
 * blocks, '…' string literals ('' escapes), "…" quoted identifiers, and both
 * -- line and /* block *​/ comments - so a `;` inside any of those never splits.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  let dollarTag: string | null = null
  while (i < sql.length) {
    const ch = sql[i]
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        cur += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      cur += ch
      i++
      continue
    }
    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      cur += sql.slice(i, end)
      i = end
      continue
    }
    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? sql.length : close + 2
      cur += sql.slice(i, end)
      i = end
      continue
    }
    // '…' string literal or "…" quoted identifier ('' / "" escapes)
    if (ch === `'` || ch === '"') {
      const q = ch
      cur += ch
      i++
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) { cur += q + q; i += 2; continue }
          cur += q
          i++
          break
        }
        cur += sql[i]
        i++
      }
      continue
    }
    const m = ch === '$' ? sql.slice(i).match(/^\$[a-zA-Z_]*\$/) : null
    if (m) {
      dollarTag = m[0]
      cur += dollarTag
      i += dollarTag.length
      continue
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
