/**
 * Deno.env is scoped per invocation via AsyncLocalStorage. This pins the
 * isolation guarantee: two invocations that interleave on the event loop each
 * read their own env, and a read outside any invocation sees nothing. A
 * module-global env swapped around `await` would fail the interleaving case.
 */
import { describe, expect, it } from 'vitest'
import { installDenoShim, runWithDenoEnv } from '../src/functions/deno-shim.js'

installDenoShim()
const denoEnv = (globalThis as { Deno: { env: { get(k: string): string | undefined } } }).Deno.env

describe('Deno.env isolation', () => {
  it('keeps each invocation env separate across interleaved awaits', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5))

    const a = runWithDenoEnv({ SECRET: 'A' }, async () => {
      await tick() // yield so B can run and set the (old) global in a naive impl
      const mid = denoEnv.get('SECRET')
      await tick()
      return [mid, denoEnv.get('SECRET')]
    })
    const b = runWithDenoEnv({ SECRET: 'B' }, async () => {
      await tick()
      const mid = denoEnv.get('SECRET')
      await tick()
      return [mid, denoEnv.get('SECRET')]
    })

    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual(['A', 'A'])
    expect(rb).toEqual(['B', 'B'])
  })

  it('reads nothing outside any invocation', () => {
    expect(denoEnv.get('SECRET')).toBeUndefined()
  })
})
