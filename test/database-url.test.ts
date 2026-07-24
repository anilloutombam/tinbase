import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { ensurePostgres } from '../src/node/native/engine.js'
import { PgWireClient } from '../src/node/native/wire.js'
import { parseConnectionString } from '../src/node/native/database-url.js'

const NATIVE_SUPPORTED =
  (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64')

// Launch a throwaway Postgres on TCP that requires SCRAM-SHA-256 password auth,
// so we exercise the real external-connection path (no Docker, reusing the same
// binaries the native engine downloads).
async function launchTcpPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  const installDir = await ensurePostgres()
  const bin = (n: string) => join(installDir, 'bin', n)
  const root = mkdtempSync(join(tmpdir(), 'tb-ext-'))
  const dataDir = join(root, 'pgdata') // initdb requires an empty/new dir
  const pwFile = join(root, 'pw')
  const password = 'tinbase-test-pw'
  const port = 20000 + Math.floor(Math.random() * 20000)
  writeFileSync(pwFile, password)

  execFileSync(bin('initdb'), ['-U', 'postgres', '-A', 'scram-sha-256', '--pwfile', pwFile, '-E', 'UTF8', '-D', dataDir], {
    stdio: 'pipe',
  })
  writeFileSync(
    join(dataDir, 'postgresql.conf'),
    `listen_addresses = '127.0.0.1'\nport = ${port}\npassword_encryption = scram-sha-256\nshared_buffers = 16MB\nfsync = off\nmax_connections = 20\n`,
    { flag: 'a' }
  )

  let stderr = ''
  const child: ChildProcess = spawn(bin('postgres'), ['-D', dataDir], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d).slice(-4000)))

  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`
  const conn = parseConnectionString(url)
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const c = await PgWireClient.connect(conn)
      await c.close()
      break
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`postgres did not accept TCP+SCRAM connections: ${stderr || (e as Error).message}`)
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  return {
    url,
    stop: async () => {
      child.kill('SIGINT')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.on('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe.skipIf(!NATIVE_SUPPORTED)('external Postgres (--database-url)', () => {
  let pg: { url: string; stop: () => Promise<void> }
  let backend: TinbaseBackend
  let supabase: SupabaseClient
  let admin: SupabaseClient

  beforeAll(async () => {
    pg = await launchTcpPostgres()
    backend = await createBackend({
      databaseUrl: pg.url,
      migrations: [
        {
          name: '20240101000000_ext',
          sql: `create table notes (id serial primary key, title text not null, done boolean default false);`,
        },
      ],
      seedSql: `insert into notes (title, done) values ('first', false), ('second', true);`,
    })
    const fetchAdapter: typeof fetch = (input, init) => backend.fetch(new Request(input, init))
    const opts = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchAdapter } }
    supabase = createClient('http://localhost:54321', backend.anonKey, opts)
    admin = createClient('http://localhost:54321', backend.serviceRoleKey, opts)
  }, 60_000)

  afterAll(async () => {
    await backend?.close()
    await pg?.stop()
  })

  it('connects over TCP with SCRAM auth and runs migrations/seed', async () => {
    const { data, error } = await supabase.from('notes').select('title,done').order('id')
    expect(error).toBeNull()
    expect(data).toEqual([
      { title: 'first', done: false },
      { title: 'second', done: true },
    ])
  })

  it('parses a connection string with credentials and a port', () => {
    const c = parseConnectionString('postgresql://alice:s%40cret@db.example.com:6543/app')
    expect(c).toEqual({ host: 'db.example.com', port: 6543, user: 'alice', password: 's@cret', database: 'app' })
  })

  it('supports the PostgREST write path against the external DB', async () => {
    const ins = await admin.from('notes').insert({ title: 'third' }).select().single()
    expect(ins.error).toBeNull()
    const { data } = await admin.from('notes').select('title').eq('title', 'third')
    expect(data).toEqual([{ title: 'third' }])
  })

  it('runs auth signup against the external DB', async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: 'ext@example.com',
      password: 'password123',
      email_confirm: true,
    })
    expect(error).toBeNull()
    expect(data.user?.email).toBe('ext@example.com')
  })

  it('re-bootstraps idempotently against a shared/pre-existing database', async () => {
    // opening a second backend on the same DB must not error (bootstrap is
    // idempotent) and must not re-apply tracked migrations/seed
    const b2 = await createBackend({
      databaseUrl: pg.url,
      migrations: [
        {
          name: '20240101000000_ext',
          sql: `create table notes (id serial primary key, title text not null, done boolean default false);`,
        },
      ],
      seedSql: `insert into notes (title, done) values ('first', false), ('second', true);`,
    })
    try {
      const c2 = createClient('http://localhost:54321', b2.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => b2.fetch(new Request(input, init)) },
      })
      const { data, error } = await c2.from('notes').select('title').eq('title', 'first')
      expect(error).toBeNull()
      expect(data).toHaveLength(1) // seed not duplicated on the second boot
    } finally {
      await b2.close()
    }
  })
})
