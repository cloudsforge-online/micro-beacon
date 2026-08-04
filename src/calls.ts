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
  /**
   * A response header, lower-cased, or null.
   *
   * Exists for `retry-after` and is deliberately a lookup rather than the whole `Headers` object:
   * a journey that could enumerate response headers would grow assertions about `date` and
   * `server`, which are deployment facts and not contract.
   */
  header(name: string): string | null
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
  return {
    status: response.status,
    body,
    text,
    header: (name) => response.headers.get(name),
  }
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

/* ------------------------------------------------------------------ the registration ceiling */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BEACON WAS SPENDING IDENTITY'S REGISTRATION BUDGET ON ITS NON-CRITICAL JOURNEYS AND
 * STARVING ITS CRITICAL ONES, AND THE ORDER IT DID IT IN WAS ALPHABETICAL.**
 *
 * Found on 2026-08-04 by reading `journey_runs` on the live estate rather than by reading this
 * file. `identity.register` and `identity.signin` — both CRITICAL, both gate inputs — had skipped
 * `registration is rate limited` on every single cycle since 06:37, ten cycles running, and the
 * gate had a SEV2 open against each of them and refused every release.
 *
 * The arithmetic, and it is entirely Beacon's own:
 *
 *   * `identity/src/server.ts` limits `POST /auth/register` to **5 per 60s per source address**,
 *     fixed-window, taken at dispatch. Every journey in this process shares one address.
 *   * One scheduler cycle makes **seven** registrations — five from `ecosystem.ts`
 *     (`one-account` needs two) and one each from `identity.register` and `identity.signin` —
 *     and it makes them inside a twelve-second burst.
 *   * `schedule.sync` enqueues in `listRegistered` order, which is **by name**. `ecosystem.*`
 *     sorts before `identity.*`. So the five non-critical journeys took the whole allowance and
 *     the two that gate the release got the 429, every cycle, deterministically.
 *
 * The estate was not broken and identity was not broken. The monitor was reporting the limit it
 * had itself exhausted, against a control that was working exactly as designed — and the shape of
 * the report ("SEV2, critical journey down, release refused") pointed at identity.
 *
 * **The fix is to wait, once, for exactly as long as identity itself asked.** A 429 carries
 * `retry-after`; honouring it is what a well-behaved client does, and it is the opposite of
 * weakening anything — the journey still has to register, sign in and be refused a wrong password
 * before it may report green. What is removed is Beacon's ability to report an outage it caused.
 *
 * Deliberately NOT done, and each for a reason:
 *
 *   * **Raising the limit.** It is a denial-of-service control in front of scrypt. A monitor is
 *     not a reason to widen it, and this repository cannot write that repository anyway.
 *   * **Sharing one account between journeys.** `throwaway()`'s header says why: two journeys on
 *     one account move each other's balance and each other's session, and the resulting flake is
 *     indistinguishable from the outage it gets reported as.
 *   * **Running critical journeys first.** It fixes the priority inversion and moves the 429 onto
 *     `ecosystem.*`, which would turn four green non-critical journeys into skips and take the
 *     public status page off 19-of-19. Waiting fixes it for every journey at once, so the
 *     ordering stays a latent inefficiency rather than becoming a regression.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The longest a journey will sit out a registration limit.
 *
 * Sixty seconds is identity's whole fixed window, so a wait this long cannot fail to reach the
 * next one. The bound matters more than the value: the journey deadline is 90s
 * (`journeys.ts` `runJourney`), the slowest journey that registers does ~2.7s of work either side
 * of it, and a wait that could exceed the deadline would convert a `skip` — which is honest — into
 * an `error`, which says Beacon is broken and sends the investigation to the wrong team.
 *
 * `browser/backoff.ts` clamps at 30s for the browser tier and that is not this number: it is
 * bounded by a browser fixture's own budget, not by identity's window, and 30s is short of the
 * ~48s that a burst twelve seconds into a sixty-second window actually asks for.
 */
export const MAX_REGISTER_WAIT_MS = 60_000

/**
 * How long to sit out a 429, given whatever `retry-after` said. Pure, so the clamp is provable.
 *
 * `retry-after` is in SECONDS. Anything that is not a positive finite number becomes the floor
 * rather than an error: a limiter that answers 429 without the header is within its rights, and a
 * journey that threw on one would be stricter than the specification it is reading. Returns 0 —
 * meaning "do not wait, skip now" — only when the service asked for longer than the bound, because
 * a limiter asking for more than its own window is one a journey should give up against rather
 * than sit out past its deadline.
 */
export function registerRetryMs(retryAfterHeader: string | null, floorSeconds = 5): number {
  const parsed = Number(retryAfterHeader ?? '')
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : floorSeconds
  const ms = seconds * 1_000
  return ms > MAX_REGISTER_WAIT_MS ? 0 : ms
}

/**
 * `POST /auth/register`, waiting out one rate-limit window if identity asks it to.
 *
 * Exactly one retry. Not a loop: a loop would be a journey that keeps trying until its deadline
 * and then reports `error`, and the second 429 is already the answer — the estate is registering
 * faster than it permits, which is a finding rather than something to grind through.
 *
 * A skip after the retry says so in terms an operator can act on, because "registration is rate
 * limited" was true for ten cycles and told nobody what to do about it.
 */
export async function registerAccount(
  ctx: JourneyContext,
  identity: string,
  account: Throwaway,
): Promise<CallResult> {
  const body = { email: account.email, handle: account.handle, password: account.password }
  const first = await call(ctx, `${identity}/auth/register`, { method: 'POST', body })
  if (first.status !== 429) return first

  const waitMs = registerRetryMs(first.header('retry-after'))
  if (waitMs === 0) {
    ctx.skip(
      `registration is rate limited and identity asked for longer than the ${MAX_REGISTER_WAIT_MS}ms ` +
        'this journey will wait',
    )
  }
  await sleep(waitMs, ctx.signal)
  // The deadline may have fired while waiting. Skipping here rather than issuing the retry keeps
  // the verdict a `skip`: a request on an aborted signal would throw, and `runJourney` classes a
  // throw that is neither an assertion nor a skip as an `error` — Beacon's fault, not the estate's.
  if (ctx.signal.aborted) ctx.skip('the run was abandoned while waiting out a registration limit')

  const second = await call(ctx, `${identity}/auth/register`, { method: 'POST', body })
  if (second.status === 429) {
    ctx.skip(
      `registration is rate limited after waiting ${Math.round(waitMs / 1_000)}s for identity's own ` +
        'retry-after. Beacon is registering faster than identity permits: one scheduler cycle ' +
        'makes seven registrations against a ceiling of five per minute per address.',
    )
  }
  return second
}

/**
 * Register a throwaway and return its token and id.
 *
 * Four journeys need an account before they can assert anything, and each one was going to write
 * this block. A rate limit is a SKIP: the estate protecting itself is not the estate being broken,
 * and recording a limit hit as a failure would open an incident against a control that is working.
 * It is a skip only after `registerAccount` has waited out identity's own `retry-after` once —
 * see the block above for why that wait exists and what it is not.
 */
export async function registerThrowaway(
  ctx: JourneyContext,
  identity: string,
): Promise<{ token: string; userId: string; account: Throwaway }> {
  const account = throwaway()
  const result = await registerAccount(ctx, identity, account)
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
