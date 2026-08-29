import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { testEngine } from './helpers.js'

let backend: TinbaseBackend

const FK_MIGRATION = `
create table parent (id int primary key);
create table child (id int primary key, parent_id int not null references parent(id));
`

const sql = async (query: string, extra: Record<string, unknown> = {}) => {
  const res = await backend.fetch(
    new Request('http://localhost:54321/admin/v1/sql', {
      method: 'POST',
      headers: {
        apikey: backend.serviceRoleKey,
        authorization: `Bearer ${backend.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, ...extra }),
    })
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  backend = await createBackend({
    engine: await testEngine(),
    migrations: [{ name: '20240101000000_fk', sql: FK_MIGRATION }],
    vaultKey: 'test-vault-key-000',
  })
})

afterAll(async () => {
  await backend.close()
})

describe('admin sql session isolation', () => {
  it('does not leak a SET into a later request', async () => {
    await sql(`set session_replication_role = 'replica'`)
    const after = await sql(`select current_setting('session_replication_role') as role`)
    expect(after.body.rows[0].role).toBe('origin')
  })

  it('still enforces foreign keys after a leaked session_replication_role', async () => {
    await sql(`set session_replication_role = 'replica'`)
    const orphan = await sql(`insert into child (id, parent_id) values (1, 999)`)
    expect(orphan.status).toBe(409)
    expect(JSON.stringify(orphan.body)).toMatch(/foreign key|violates/i)

    const rows = await sql(`select id from child`)
    expect(rows.body.rows).toEqual([])
  })

  it('does not leak a SET made inside the run-as-role path', async () => {
    await sql(`set session_replication_role = 'replica'`, { role: 'authenticated' })
    const after = await sql(`select current_setting('session_replication_role') as role`)
    expect(after.body.rows[0].role).toBe('origin')
  })

  it('does not leak SET ROLE onto the shared connection', async () => {
    await sql(`set role anon`)
    const after = await sql(`select current_user as who`)
    expect(after.body.rows[0].who).not.toBe('anon')
  })

  // `reset all` clears custom GUCs, and the vault key lives only in this
  // session - resetting without restoring it would silently break decryption.
  it('keeps the vault key working after a session reset', async () => {
    await sql(`set session_replication_role = 'replica'`)
    const key = await sql(`select current_setting('app.settings.vault_key', true) as k`)
    expect(key.body.rows[0].k).toBe('test-vault-key-000')

    await sql(`select 1`)
    const secret = await sql(`select vault.create_secret('hunter2', 'sql-session-test') as id`)
    expect(secret.status).toBe(200)
    const read = await sql(
      `select decrypted_secret as s from vault.decrypted_secrets where name = 'sql-session-test'`
    )
    expect(read.body.rows[0].s).toBe('hunter2')
  })
})
