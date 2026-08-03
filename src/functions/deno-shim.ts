/**
 * Minimal `Deno` global shim so Supabase-style edge functions run unchanged
 * under Node/Bun. Supabase functions are written for Deno:
 *
 *   Deno.serve((req) => new Response(...))
 *   const url = Deno.env.get('SUPABASE_URL')
 *
 * Instead of starting a server, our `Deno.serve` captures the handler so the
 * FunctionsHandler can invoke it per request; `Deno.env` reads only the
 * injected SUPABASE_* vars and declared function secrets (never the host
 * process.env).
 *
 * Not resolved: `npm:` / `jsr:` / URL import specifiers and the Deno std lib -
 * a function using those needs a bundling step. Functions that stick to Web
 * APIs (fetch/Request/Response) + Deno.serve/Deno.env work as-is.
 */
type DenoHandler = (req: Request) => Response | Promise<Response>

const captured: { handler?: DenoHandler } = {}

type FunctionEnv = Record<string, string>

interface EnvStore {
  run<T>(env: FunctionEnv, fn: () => Promise<T>): Promise<T>
  getStore(): FunctionEnv | undefined
}

// The Deno global is installed once per process, but each backend (and each
// in-flight invocation) has its own function env. On Node an AsyncLocalStorage
// scopes the env to the invocation's async context, so it stays correct across
// awaits even when two invocations interleave on the event loop - a
// module-global that was swapped around `await` would let a later call
// overwrite an earlier call's env mid-flight.
//
// This module is reachable from the package root, which browser apps bundle to
// run tinbase in-page (pg-mem previews) - so it must not statically import
// `node:async_hooks`, a Node-only builtin that client bundlers refuse to
// resolve. `process.getBuiltinModule` (Node >= 22.3, within our engines range)
// loads it synchronously without an import statement bundlers can see. A
// Deno.env read outside any invocation sees an empty env.
function createEnvStore(): EnvStore {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  const hooks = proc?.getBuiltinModule?.('node:async_hooks') as typeof import('node:async_hooks') | undefined
  if (hooks?.AsyncLocalStorage) return new hooks.AsyncLocalStorage<FunctionEnv>()

  // Non-Node runtime: bind the env for the duration of the returned promise.
  // Unlike AsyncLocalStorage this can't isolate interleaved invocations from
  // each other, but browser previews invoke functions one at a time.
  let current: FunctionEnv | undefined
  return {
    getStore: () => current,
    run<T>(env: FunctionEnv, fn: () => Promise<T>): Promise<T> {
      const prev = current
      current = env
      let result: Promise<T>
      try {
        result = fn()
      } catch (e) {
        current = prev
        throw e
      }
      return Promise.resolve(result).finally(() => {
        current = prev
      })
    },
  }
}

const envStore = createEnvStore()

/**
 * Run `fn` with the shim's Deno.env bound to `env`. The binding lives in an
 * async-context store, so concurrent invocations each read their own env and
 * one backend can never observe another's (or the host's) secrets.
 */
export function runWithDenoEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return envStore.run(env, fn)
}

/** Install globalThis.Deno if we're not already running under a Deno-like runtime. */
export function installDenoShim(): void {
  const g = globalThis as Record<string, unknown> & { Deno?: unknown; __tinbaseDeno?: boolean }
  if (g.__tinbaseDeno) return
  // a real Deno runtime already provides Deno.serve - don't clobber it
  if (g.Deno && typeof (g.Deno as { serve?: unknown }).serve === 'function') return
  g.__tinbaseDeno = true
  g.Deno = {
    serve(arg1: unknown, arg2?: unknown) {
      captured.handler = (typeof arg1 === 'function' ? arg1 : arg2) as DenoHandler
      // Deno.serve returns a server; some functions `await server.finished`.
      return { finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {}, addr: { hostname: '0.0.0.0', port: 0, transport: 'tcp' } }
    },
    // Scope Deno.env to the injected SUPABASE_* vars + declared function
    // secrets only. It deliberately does NOT fall through to the host
    // process.env, so a function can't read arbitrary server-side env (cloud
    // credentials, DB URLs, etc.).
    env: {
      get: (k: string) => envStore.getStore()?.[k],
      set: (k: string, v: string) => {
        const s = envStore.getStore()
        if (s) s[k] = v
      },
      has: (k: string) => envStore.getStore()?.[k] !== undefined,
      delete: (k: string) => {
        const s = envStore.getStore()
        if (s) delete s[k]
      },
      toObject: () => ({ ...(envStore.getStore() ?? {}) }),
    },
    // enough of the surface that idiomatic functions don't crash on reference
    cwd: () => (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/',
    // a function must not be able to terminate the whole server; throw instead
    // of calling process.exit.
    exit: (code?: number) => {
      throw new Error(`Deno.exit(${code ?? 0}) called in an edge function (ignored)`)
    },
  }
}

/** Return and clear the handler captured by the most recent Deno.serve() call. */
export function takeCapturedHandler(): DenoHandler | undefined {
  const h = captured.handler
  captured.handler = undefined
  return h
}

/** Clear any handler captured by Deno.serve(), without returning it. */
export function resetCapturedHandler(): void {
  captured.handler = undefined
}
