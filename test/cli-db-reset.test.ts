import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBackend } from '../src/index.js'
import { createNativeEngine } from '../src/node/native/engine.js'

// Exercises `tinbase db reset` via the built CLI, then inspects the wasm data dir.
const CLI = join(process.cwd(), 'dist', 'cli.js')

const NATIVE_SUPPORTED =
  (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64')

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tb-reset-'))
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'supabase', 'migrations', '20240101000000_t.sql'), 'create table items (id serial primary key, name text);')
  writeFileSync(join(dir, 'supabase', 'seed.sql'), "insert into items (name) values ('a'), ('b');")
  return dir
}

describe('cli db reset', () => {
  it('wipes data and re-applies migrations + seed', { timeout: 30000 }, () => {
    if (!existsSync(CLI)) {
      // requires the built CLI; skip if dist isn't present
      return
    }
    const dir = project()
    const run = (...args: string[]) => execFileSync('node', [CLI, ...args, '--dir', dir], { encoding: 'utf8' })

    run('migrate')
    // reset should succeed and report the seed
    const out = run('db', 'reset')
    expect(out).toContain('reset complete')
    expect(out).toContain('+ seed')

    // second reset must also work (stale-state safe) and stay at the seed baseline
    const out2 = run('db', 'reset')
    expect(out2).toContain('reset complete')
  })

  // Regression: reset defaulted its data dir independently of every other
  // command, so on the native engine it wiped and rebuilt `.tinbase/db` while
  // `start`/`migrate`/`status`/`inspect` kept using `.tinbase/pgdata`. Reset
  // reported success, left the live database untouched, and quietly grew a
  // second Postgres cluster on disk (#76). Asserting on output alone missed
  // this entirely, so this checks persisted state.
  describe.skipIf(!NATIVE_SUPPORTED)('native engine data dir', () => {
    it('reset wipes the same database the other commands use', { timeout: 120000 }, async () => {
      if (!existsSync(CLI)) return
      const dir = project()
      const run = (...args: string[]) =>
        execFileSync('node', [CLI, ...args, '--dir', dir, '--engine', 'native'], { encoding: 'utf8' })

      run('migrate')

      // write a marker straight into the cluster the CLI just used
      const pgdata = join(dir, '.tinbase', 'pgdata')
      const write = await createNativeEngine({ dataDir: pgdata })
      await write.query("insert into items (name) values ('marker')")
      await write.close?.()

      run('db', 'reset')

      // the marker must be gone: reset has to have wiped THIS directory
      const read = await createNativeEngine({ dataDir: pgdata })
      const rows = await read.query<{ name: string }>('select name from items')
      await read.close?.()
      expect(rows.rows.map((r) => r.name)).not.toContain('marker')

      // and it must not have built a second cluster next door
      expect(existsSync(join(dir, '.tinbase', 'db'))).toBe(false)
    })

    it('honors an explicit --data-dir instead of silently ignoring it', { timeout: 120000 }, () => {
      if (!existsSync(CLI)) return
      const dir = project()
      const custom = join(dir, 'custom-pg')
      execFileSync('node', [CLI, 'migrate', '--dir', dir, '--engine', 'native', '--data-dir', custom], {
        encoding: 'utf8',
      })
      // the cluster lives where asked, not at the default
      expect(existsSync(join(custom, 'PG_VERSION'))).toBe(true)
      expect(existsSync(join(dir, '.tinbase', 'pgdata'))).toBe(false)
    })
  })

  it('unknown db subcommand exits non-zero', { timeout: 15000 }, () => {
    if (!existsSync(CLI)) return
    const dir = project()
    let failed = false
    try {
      execFileSync('node', [CLI, 'db', 'frobnicate', '--dir', dir], { stdio: 'pipe' })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})
