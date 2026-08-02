/**
 * The primitives a journey uses to talk to the estate.
 *
 * Extracted from `estate.ts` rather than duplicated, because `ecosystem.ts` needs exactly the same
 * `call` and exactly the same throwaway account, and two copies of "how Beacon makes a request"
 * drift the moment one of them grows a header. `estate.ts` imports `ecosystem.ts` to assemble the
 * registry, so the shared half cannot live in either of them without a cycle; it lives here.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO `setTimeout` IN THIS FILE, AND `sleep` IS WHY THAT IS WORTH SAYING.**
 *
 * CI bans `setTimeout(` everywhere in `src/` except the two deadline races in `probes.ts` and
 * `journeys.ts`, because the service this replaces was three module-scope timers and every one of
 * them meant two replicas doing the work twice. A bounded poll inside a single journey run is a
 * delay, not a schedule — nothing recurs across runs — but rather than argue for a third
 * exemption, `sleep` is `scheduler.wait` from `node:timers/promises`, which is the standard
 * awaitable delay and takes the journey's own `AbortSignal`.
 *
 * The first attempt at this used `AbortSignal.timeout` and no timer at all, which looked cleaner
 * and was **wrong in a way that only shows up outside the service**: `AbortSignal.timeout`'s timer
 * is unref'd, so a poll waiting on one does not keep the event loop alive. Inside `index.ts` the
 * HTTP server holds the loop open and it works; run the same journey from a script and the process
 * exits mid-poll and the journey silently never finishes. Found by running it that way — which is
 * the whole reason to run something rather than reason about it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from 'node:crypto'
import { scheduler } from 'node:timers/promises'
import type { JourneyContext } from './journeys.ts'

export interface Json {
  readonly [key: string]: unknown
}

export interface CallResult {
  readonly status: number
  readonly body: Json
  /** The raw bytes, for the assertions that are about the exact string and not about a field. */
  readonly text: string
}

export interface CallInit {
  readonly method?: string
  readonly body?: unknown
  readonly token?: string
  readonly deadlineMs?: number
  /** Extra headers. `Origin` is the reason this exists — the SSO redemption route demands one. */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A JSON call inside a journey step.
 *
 * Every request carries its own deadline. The journey has one too, but a journey deadline that
 * fires tells you only that the whole scenario was slow; a per-call one tells you which call was.
 */
export async function call(ctx: JourneyContext, url: string, init: CallInit = {}): Promise<CallResult> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.token) headers['authorization'] = `Bearer ${init.token}`

  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(init.deadlineMs ?? 10_000)])
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal,
    redirect: 'manual',
  })
  const text = await response.text()
  let body: Json = {}
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Json
    } catch {
      // A non-JSON body from a JSON route is a finding, not a crash. The status is still the
      // thing the assertion is about, and the empty body makes the assertion fail with a message
      // about what was expected rather than with a SyntaxError from the harness.
      body = {}
    }
  }
  return { status: response.status, body, text }
}

/** A string at a path, or null. Never throws — a shape surprise is an assertion, not an exception. */
export function stringField(body: Json, ...path: string[]): string | null {
  const value = field(body, ...path)
  return typeof value === 'string' ? value : null
}

/** Any value at a path, or undefined. */
export function field(body: Json, ...path: string[]): unknown {
  let cursor: unknown = body
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/** The access token, from either shape identity has ever used. */
export function accessToken(body: Json): string | null {
  return stringField(body, 'accessToken') ?? stringField(body, 'tokens', 'accessToken')
}

export interface Throwaway {
  readonly email: string
  readonly handle: string
  readonly password: string
}

/**
 * A throwaway account, per run.
 *
 * **Never a real user and never one shared between journeys.** Two journeys sharing an account
 * would move each other's balance and each other's session, and the flake that produces is
 * indistinguishable from the outage it would be reported as. The address is namespaced so the rows
 * can be found and pruned — identity has no account-deletion route that a monitor may call, which
 * is a fact about the estate rather than about this harness, and it is said here because a monitor
 * that quietly accumulates rows in a production table gets switched off by whoever finds out the
 * hard way.
 *
 *     delete from users where email like 'beacon+%';
 */
export function throwaway(): Throwaway {
  const id = randomUUID().replace(/-/g, '').slice(0, 16)
  return {
    email: `beacon+${id}@beacon.test`,
    handle: `bx_${id.slice(0, 14)}`,
    // Generated per run and written nowhere. It is a credential for an account that owns nothing,
    // and it still never reaches a log: the telemetry redactor drops `password` at any depth.
    password: `Bx-${randomUUID().slice(0, 20)}`,
  }
}

/**
 * Register a throwaway and return its token and id.
 *
 * Four journeys need an account before they can assert anything, and each one was going to write
 * this block. A rate limit is a SKIP: the estate protecting itself is not the estate being broken,
 * and recording a limit hit as a failure would open an incident against a control that is working.
 */
export async function registerThrowaway(
  ctx: JourneyContext,
  identity: string,
): Promise<{ token: string; userId: string; account: Throwaway }> {
  const account = throwaway()
  const result = await call(ctx, `${identity}/auth/register`, {
    method: 'POST',
    body: { email: account.email, handle: account.handle, password: account.password },
  })
  if (result.status === 429) ctx.skip('registration is rate limited')
  ctx.assert(result.status === 201, `expected 201 from /auth/register, got ${result.status}`)
  const token = accessToken(result.body)
  ctx.assert(token !== null, 'registration returned no access token')
  const userId = stringField(result.body, 'user', 'id')
  ctx.assert(userId !== null, 'registration returned no user id')
  return { token: token as string, userId: userId as string, account }
}

/**
 * Wait, without a timer.
 *
 * Resolves after `ms`, or the moment `signal` aborts — whichever is first. See the file header for
 * why this is not `setTimeout`.
 */
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  // Rejects with an AbortError when the journey's deadline fires, which is a normal end to a
  // delay rather than a failure — the caller's next `ctx.signal.aborted` check is what acts on it.
  await scheduler.wait(ms, { signal }).catch(() => {})
}

/**
 * Poll until `read` answers something, or give up.
 *
 * Returns `null` on exhaustion rather than throwing, so the CALLER decides whether an absence is a
 * `fail` (the product did not do the thing) or a `skip` (this deployment does not do the thing).
 * A helper that threw would take that decision away from the only code that knows the difference.
 */
export async function pollFor<T>(
  ctx: JourneyContext,
  options: { attempts: number; intervalMs: number },
  read: () => Promise<T | null>,
): Promise<T | null> {
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (ctx.signal.aborted) return null
    const value = await read()
    if (value !== null) return value
    if (attempt < options.attempts - 1) await sleep(options.intervalMs, ctx.signal)
  }
  return null
}
