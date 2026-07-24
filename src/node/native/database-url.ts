/**
 * External-Postgres engine: point tinbase's REST/Auth/Storage at a Postgres you
 * already run, via `--database-url` / `createBackend({ databaseUrl })`. A thin
 * DbEngine over PgWireClient (TCP + cleartext/md5/SCRAM auth), reusing the same
 * engine machinery as the embedded native engine.
 *
 * The target is treated as shared/pre-existing: bootstrap runs idempotently and
 * never assumes exclusive ownership or an empty database. (TLS/sslmode, realtime
 * CDC, RLS-role provisioning edge cases, and pooling are follow-ups.)
 */
import type { DbEngine } from '../../db/engine.js'
import { PgWireClient } from './wire.js'
import { buildWireEngine } from './wire-engine.js'

export interface ParsedConnectionString {
  host: string
  port: number
  user: string
  password?: string
  database: string
}

/** Parse a `postgres://user:pass@host:port/dbname` connection string. */
export function parseConnectionString(raw: string): ParsedConnectionString {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid database URL: ${raw}`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`unsupported database URL scheme "${url.protocol}" (expected postgres:// or postgresql://)`)
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) throw new Error(`database URL is missing a database name: ${raw}`)
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? parseInt(url.port, 10) : 5432,
    user: url.username ? decodeURIComponent(url.username) : 'postgres',
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database,
  }
}

export interface DatabaseUrlEngineOptions {
  databaseUrl: string
  log?: (msg: string) => void
}

export async function createDatabaseUrlEngine(opts: DatabaseUrlEngineOptions): Promise<DbEngine> {
  const conn = parseConnectionString(opts.databaseUrl)
  opts.log?.(`connecting to external postgres at ${conn.host}:${conn.port}/${conn.database} as ${conn.user}`)
  const connect = () =>
    PgWireClient.connect({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
    })
  return buildWireEngine({ connect })
}
