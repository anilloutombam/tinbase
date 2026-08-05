/**
 * A marker recording that `tinbase start` is serving a project directory.
 *
 * The native engine advertises its own server through postgres's `postmaster.pid`,
 * which is why the other commands can attach to it. The wasm (PGlite) and pgmem
 * engines publish nothing: PGlite is an in-process embedded build with no socket,
 * and pgmem holds the database purely in memory. So a second process could not
 * tell a server was running, and the results were worse than the native lock error
 * it was spared:
 *
 * - **wasm**: `migrate` reported success while two PGlite instances wrote the same
 *   directory. The migration ledger recorded the migration as applied but its table
 *   was missing, and because the ledger says applied, re-running `migrate` will
 *   never repair it. Only `db reset` recovers, which loses the data.
 * - **pgmem**: `migrate` reported success against its own throwaway in-memory
 *   database. Harmless to data, since nothing is shared, but a total no-op that
 *   claimed to have worked.
 *
 * This file closes that gap. It is written on start and removed on shutdown, and a
 * stale one (from a crash) is detected by checking the pid, so it can never wedge a
 * project permanently.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerLock {
  pid: number
  engine: string
  port: number
  /** ISO timestamp, for a human reading the file */
  startedAt: string
}

function lockPath(projectDir: string): string {
  return join(projectDir, '.tinbase', 'server.json')
}

/** Record that this process is serving `projectDir`. Best-effort: never throws. */
export function writeServerLock(projectDir: string, lock: Omit<ServerLock, 'pid' | 'startedAt'>): void {
  try {
    writeFileSync(
      lockPath(projectDir),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...lock }, null, 2) + '\n'
    )
  } catch {
    // an unwritable .tinbase is the caller's problem, not worth failing start over
  }
}

/** Remove this process's marker. Best-effort: never throws. */
export function removeServerLock(projectDir: string): void {
  try {
    rmSync(lockPath(projectDir), { force: true })
  } catch {
    // nothing useful to do on the way out
  }
}

/**
 * The live server serving `projectDir`, or null.
 *
 * Returns null for a marker whose process is gone, which is what a crashed run
 * leaves behind - otherwise a single crash would lock the project out of its own
 * CLI until someone deleted a file they have never heard of.
 */
export function readServerLock(projectDir: string): ServerLock | null {
  const path = lockPath(projectDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServerLock>
    if (typeof parsed.pid !== 'number' || !parsed.pid) return null
    if (parsed.pid === process.pid) return null // our own marker
    try {
      process.kill(parsed.pid, 0) // throws when the process is gone
    } catch {
      rmSync(path, { force: true }) // stale, clear it so this is a one-off
      return null
    }
    return {
      pid: parsed.pid,
      engine: typeof parsed.engine === 'string' ? parsed.engine : 'unknown',
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    return null // unreadable or truncated - treat as no server rather than wedging
  }
}
