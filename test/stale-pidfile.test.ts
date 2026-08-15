import { describe, expect, it } from 'vitest'
import { pidFileIsStale } from '../src/node/native/engine.js'

// postmaster.pid: line 1 is the PID, line 2 the data directory it was started
// with. Postgres refuses to start while the file names a live process, so
// deciding "is this really a running postmaster?" is what stands between a
// crashed container and a database that never opens again.

const pidFile = (pid: number, dir = '/data/db'): string =>
  `${pid}\n${dir}\n1786800000\n5432\n/tmp/sock\nlocalhost\n  5432001         0\nready   \n`

const alive = (): boolean => true
const dead = (): boolean => false

describe('pidFileIsStale', () => {
  it('keeps the file when the PID really is a postmaster for this data dir', () => {
    const describe_ = (): string => '/usr/lib/postgresql/bin/postgres -D /data/db -k /tmp/sock'
    expect(pidFileIsStale(pidFile(19), '/data/db', alive, describe_)).toBe(false)
  })

  it('treats a recycled PID as stale even though the process is alive', () => {
    // The production failure: a container is killed, restarts, and numbers its
    // processes from 1 again — so the PID in the leftover file is reissued, very
    // often to node itself. Trusting liveness alone left postgres refusing to
    // start on every boot, permanently.
    const describe_ = (): string => 'node /usr/local/bin/tinbase start --dir /data'
    expect(pidFileIsStale(pidFile(19), '/data/db', alive, describe_)).toBe(true)
  })

  it('is stale when nothing holds the PID', () => {
    const describe_ = (): string => 'irrelevant'
    expect(pidFileIsStale(pidFile(4242), '/data/db', dead, describe_)).toBe(true)
  })

  it('is stale when the file belongs to a different cluster', () => {
    const describe_ = (): string => 'postgres -D /somewhere/else'
    expect(pidFileIsStale(pidFile(19, '/somewhere/else'), '/data/db', alive, describe_)).toBe(true)
  })

  it('compares data directories by resolved path, not by string', () => {
    const describe_ = (): string => 'postgres -D /data/db'
    expect(pidFileIsStale(pidFile(19, '/data/db/'), '/data/./db', alive, describe_)).toBe(false)
  })

  it('leaves the file alone when the process cannot be identified', () => {
    // Conservative on purpose: deleting the lock of a postmaster that IS running
    // lets a second one initialise over a live database. Unknown means hands off,
    // and postgres reports the conflict itself.
    expect(pidFileIsStale(pidFile(19), '/data/db', alive, () => null)).toBe(false)
  })

  it('is stale when the PID line is missing or malformed', () => {
    const describe_ = (): string => 'postgres'
    expect(pidFileIsStale('', '/data/db', alive, describe_)).toBe(true)
    expect(pidFileIsStale('not-a-pid\n/data/db\n', '/data/db', alive, describe_)).toBe(true)
    expect(pidFileIsStale('0\n/data/db\n', '/data/db', alive, describe_)).toBe(true)
  })
})
