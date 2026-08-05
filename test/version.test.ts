import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TINBASE_VERSION } from '../src/types.js'

/**
 * TINBASE_VERSION is served from `/rest/v1/` and `/auth/v1/health`, so a stale
 * value misreports the running version to callers. It cannot be read from
 * package.json at runtime because the single-binary build has none, so it is
 * duplicated - and it drifted, sitting at 0.9.0 while the package reached 0.12.x.
 * This turns that silent drift into a failing test.
 */
describe('version', () => {
  it('stays in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
    expect(TINBASE_VERSION).toBe(pkg.version)
  })
})

describe('isNewerVersion', () => {
  it('detects a newer release', async () => {
    const { isNewerVersion } = await import('../src/cli.js')
    expect(isNewerVersion('0.12.3', '0.12.2')).toBe(true)
    expect(isNewerVersion('0.13.0', '0.12.2')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.12.2')).toBe(true)
  })

  it('does not nag about the same or older', async () => {
    const { isNewerVersion } = await import('../src/cli.js')
    expect(isNewerVersion('0.12.2', '0.12.2')).toBe(false)
    expect(isNewerVersion('0.12.1', '0.12.2')).toBe(false)
    expect(isNewerVersion('0.9.0', '0.12.2')).toBe(false)
  })

  it('compares numerically, not as strings', async () => {
    const { isNewerVersion } = await import('../src/cli.js')
    // the string comparison trap: '0.9.0' > '0.12.0' lexically
    expect(isNewerVersion('0.9.0', '0.12.0')).toBe(false)
    expect(isNewerVersion('0.12.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.10.0')).toBe(false)
  })

  it('ignores prerelease tags rather than mis-ranking them', async () => {
    const { isNewerVersion } = await import('../src/cli.js')
    expect(isNewerVersion('0.13.0-beta.1', '0.12.2')).toBe(true)
    expect(isNewerVersion('0.12.2-beta.1', '0.12.2')).toBe(false)
  })

  it('treats garbage as no update rather than throwing', async () => {
    const { isNewerVersion } = await import('../src/cli.js')
    expect(isNewerVersion('', '0.12.2')).toBe(false)
    expect(isNewerVersion('latest', '0.12.2')).toBe(false)
    expect(isNewerVersion('0.12.2', 'not-a-version')).toBe(false)
  })
})
