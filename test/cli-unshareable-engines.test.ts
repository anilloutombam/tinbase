import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The wasm and pgmem engines cannot be joined by a second process, and used to say
 * nothing about it. What happened instead was worse than the native engine's lock
 * error:
 *
 * - wasm: `migrate` reported success while two PGlite instances wrote the same
 *   directory. The ledger recorded the migration as applied but its table was
 *   missing, and re-running `migrate` could never repair that, because the ledger
 *   already said applied. Only `db reset` recovered, losing the data.
 * - pgmem: `migrate` reported success against its own throwaway in-memory database,
 *   leaving the running server untouched. A no-op that claimed to have worked.
 *
 * Both now refuse while a server is up, keyed off the marker `start` writes.
 */
const CLI = join(process.cwd(), 'dist', 'cli.js')
const BUILT = existsSync(CLI)

/** Run expecting a non-zero exit; returns combined output. */
function failing(dir: string, engine: string, ...args: string[]): string {
  try {
    execFileSync('node', [CLI, ...args, '--dir', dir, '--engine', engine], { encoding: 'utf8', stdio: 'pipe' })
    return '__SUCCEEDED__'
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

for (const engine of ['wasm', 'pgmem'] as const) {
  describe.skipIf(!BUILT)(`cli against a running ${engine} server`, () => {
    let dir: string
    let server: ChildProcess | undefined
    let port: number

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `tb-${engine}-`))
      mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
      writeFileSync(join(dir, 'supabase', 'migrations', '001_init.sql'), 'create table notes (id text primary key);')

      port = 54500 + (engine === 'wasm' ? 1 : 2) + (process.pid % 50)
      server = spawn('node', [CLI, 'start', '--dir', dir, '--engine', engine, '--port', String(port)], {
        stdio: 'ignore',
      })
      for (let i = 0; i < 120; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/rest/v1/`)
          if (res.status > 0) break
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      writeFileSync(join(dir, 'supabase', 'migrations', '002_add.sql'), 'create table tags (id text primary key);')
    }, 240000)

    afterAll(async () => {
      server?.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 2500))
      server?.kill('SIGKILL')
    })

    it('records that a server is running', () => {
      expect(existsSync(join(dir, '.tinbase', 'server.json'))).toBe(true)
    })

    for (const cmd of [['migrate'], ['status'], ['inspect'], ['db', 'reset']]) {
      it(`refuses ${cmd.join(' ')} rather than pretending it worked`, { timeout: 120000 }, () => {
        const out = failing(dir, engine, ...cmd)
        expect(out).not.toBe('__SUCCEEDED__')
        expect(out).toContain(`Cannot run ${cmd.join(' ')}`)
        expect(out).toContain(engine)
      })
    }

    it('leaves the running server serving', { timeout: 120000 }, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rest/v1/`)
      expect(res.status).toBeGreaterThan(0)
    })
  })
}
