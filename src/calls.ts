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
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE `.test` IN THAT ADDRESS IS LOAD-BEARING. IT IS NOT A NAMING CONVENTION.**
 *
 * Every registration below makes identity emit `identity.email.verification_requested`, and
 * `notify` turns that into a verification mail. `notify/src/reserved.ts` declines to open the mail
 * channel for a domain RFC 6761 §6 reserves — `.test`, `.example`, `.invalid`, `.localhost` — so
 * this address is dropped before a delivery row is written and costs nothing.
 *
 * Move it to a domain that could resolve and the estate's outbound mail stops, measurably and
 * within minutes. The numbers, taken on the estate on 2026-08-07 (micro-org#243): this function
 * ran ~95 times an hour, the provider's plan allows 250 messages a DAY, `max_attempts` is 6, and
 * the 250 were gone before anybody was awake. 1,839 sends failed that day against 89 that
 * succeeded, and 4,483 verification tokens had been issued across the two networks with **zero**
 * ever consumed. The refusal arrives as `SMTP 535`, which reads as a credentials failure and was
 * diagnosed as one twice.
 *
 * `calls.test.ts` asserts this — on the source of every file here that mints an address, not just
 * on this line — because the comment is advice and the test is the guarantee.
 *
 * **What this costs the probe, stated rather than implied.** These journeys prove that
 * registration works end to end: identity accepts the account, emits the event, notify maps it to
 * a notification, and the in-app delivery arrives and is asserted on. They have never proved that
 * mail LEAVES the estate — nothing here reads a mailbox and no verification token has ever been
 * consumed by a probe, before this rule or after it. So the reserved domain gave up no assertion.
 * What it gave up is an accident: while these registrations were spending the allowance, a total
 * mail failure would eventually have shown up as beacon's own volume drying up. That was never a
 * check, it was a side effect, and it is replaced by one that does not cost mail —
 * `notify_deliveries_awaiting_allowance`, which notify publishes for exactly this.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **COMING BACK AT EXACTLY `retry-after` RACES THE WINDOW BOUNDARY, AND LOSES.**
 *
 * The first version of this waited precisely what the header asked and was STILL refused, on the
 * live estate, every cycle. The trace:
 *
 *   * identity's window opened at 08:03:53.203 and reset at 08:04:53.203.
 *   * `identity.register` was refused at 08:04:08.2 and told `retry-after: 45`.
 *   * It came back at 08:04:52.726 — **477ms before the reset** — and was refused again.
 *
 * `retry-after` is a whole number of seconds standing in for a millisecond deadline, so the value
 * a client receives has already been rounded, and the client's own timer, the request's flight
 * time and the two clocks each add their own error. Arriving on the nose is arriving inside the
 * old window about half the time — and a retry that lands one window too early is worth strictly
 * less than no retry at all, because it costs 45 seconds to learn nothing.
 *
 * Two seconds, not two hundred milliseconds: the cost of overshooting is two idle seconds inside
 * a 90s deadline, and the cost of undershooting is the entire wait wasted and a CRITICAL journey
 * reporting a skip. The asymmetry is not close.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const REGISTER_RETRY_MARGIN_MS = 2_000

/**
 * How long to sit out a 429, given whatever `retry-after` said. Pure, so the clamp is provable.
 *
 * `retry-after` is in SECONDS. Anything that is not a positive finite number becomes the floor
 * rather than an error: a limiter that answers 429 without the header is within its rights, and a
 * journey that threw on one would be stricter than the specification it is reading.
 *
 * Returns 0 — meaning "do not wait, skip now" — only when the service asked for longer than
 * `MAX_REGISTER_WAIT_MS`, because a limiter asking for more than its own window is one a journey
 * should give up against rather than sit out past its deadline. The bound is applied to what the
 * SERVICE asked for; the margin is then added on top, so the longest this can return is
 * `MAX_REGISTER_WAIT_MS + REGISTER_RETRY_MARGIN_MS` — 62s against a 90s deadline.
 */
export function registerRetryMs(retryAfterHeader: string | null, floorSeconds = 5): number {
  const parsed = Number(retryAfterHeader ?? '')
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : floorSeconds
  const ms = seconds * 1_000
  return ms > MAX_REGISTER_WAIT_MS ? 0 : ms + REGISTER_RETRY_MARGIN_MS
}

/**
 * The long-lived credential this deployment was given, or null when it was given none.
 *
 * Read at call time rather than at import, so a test can set it without reloading the module.
 * `estate-bootstrap.sh` §5b mints it under the name `BEACON_IDENTITY_CREDENTIAL` and
 * `compose/docker-compose.estate.yml` passes it in under this one; the deploy is where those two
 * names are joined, and the compose comment says so at length.
 */
export function serviceCredential(): string | null {
  const value = process.env['BEACON_SERVICE_CREDENTIAL']?.trim()
  return value && value.length > 0 ? value : null
}

/**
 * Mint a short-lived service token from that credential, or say there is none to mint from.
 *
 * A token rather than an injected one, for the reason `deploy/README.md` records: identity issues
 * service tokens with a 600-second TTL and nothing re-mints one, so anything holding an injected
 * token starts answering 401 ten minutes after the estate came up.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE BODY IS EMPTY, AND THAT IS TWO DECISIONS RATHER THAN AN OMISSION.**
 *
 * identity's exchange route treats `scopes` as OPTIONAL — `readJson` answers `{}` for an empty
 * body, and the route's own comment calls that the common case: "a token provider that wants its
 * whole allowlist for the default lifetime sends nothing at all."
 *
 *   1. **This path needs a PRINCIPAL, not a permission.** identity skips the registration
 *      challenge for a caller whose claims are a service's and consults no scope while doing it
 *      (`challengeBypass` in `identity/src/server.ts`). Asking for a named scope here would be
 *      asking for a permission nothing on this path reads.
 *   2. **A `scopes:` literal here would permanently widen beacon's grant.**
 *      `deploy/scripts/derive-grants.mjs` reads the `scopes:` body of a
 *      `POST /service-tokens/exchange` call FROM THE TEXT, and for beacon that seam is its entire
 *      outbound declaration — see the long note in `ecosystem.ts`. Whatever were written here
 *      would land in `IDENTITY_SERVICE_TOKEN_GRANTS` and stay there, granted for a request that
 *      never uses it. The empty body contributes nothing to that seam, which is the correct
 *      contribution.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function mintServiceToken(
  ctx: JourneyContext,
  identity: string,
): Promise<string | null> {
  const credential = serviceCredential()
  if (credential === null) return null

  const result = await call(ctx, `${identity}/service-tokens/exchange`, {
    method: 'POST',
    // The credential goes in the Authorization header; identity shape-checks its prefix before it
    // touches the database.
    token: credential,
  })
  ctx.assert(
    result.status === 201 || result.status === 200,
    `expected 2xx from /service-tokens/exchange, got ${result.status} — ${result.text.slice(0, 200)}`,
  )
  const minted = stringField(result.body, 'token') ?? accessToken(result.body)
  ctx.assert(minted !== null, 'the exchange returned no token')
  return minted as string
}

/**
 * identity's two 403 challenge refusals, by code — `ChallengeError` in `identity/src/server.ts`.
 *
 * `challenge_required` is "nothing was sent"; `challenge_failed` is "something was and it did not
 * hold". Both are 403 and neither is anything beacon can put right by trying again: nothing in this
 * process can complete a Turnstile puzzle.
 *
 * `challenge_unavailable` is deliberately NOT here. It is 503, it means Cloudflare could not be
 * reached, and identity fails closed — so it is a state in which no real person can open an account
 * either. That is a red journey, not a skip, and letting it fall through to the caller's status
 * assertion is what makes it one.
 */
const CHALLENGE_REFUSALS: ReadonlySet<string> = new Set(['challenge_required', 'challenge_failed'])

function challengeRefusal(result: CallResult): string | null {
  if (result.status !== 403) return null
  const code = stringField(result.body, 'error', 'code')
  return code !== null && CHALLENGE_REFUSALS.has(code) ? code : null
}

/**
 * Turn a challenge refusal into the right verdict, and hand anything else straight back.
 *
 * The two cases are genuinely different and collapsing them would misattribute both:
 *
 *   * **No credential.** Beacon was never excused the challenge, so being refused by it is the
 *     gate working. A `skip` naming the deploy step — never a `fail`, which would open an incident
 *     against identity for doing exactly what it was configured to do.
 *   * **A credential, and still refused.** The service-principal bypass is broken. That is a real
 *     defect and it is identity's, so it fails here with a message that says which of the two it
 *     is, rather than surfacing as "expected 202, got 403" three frames up.
 */
function afterChallenge(ctx: JourneyContext, result: CallResult, token: string | null): CallResult {
  const code = challengeRefusal(result)
  if (code === null) return result

  if (token === null) {
    ctx.skip(
      `identity requires a solved registration challenge (${code}) and beacon holds no service ` +
        'credential to be excused it. Set BEACON_IDENTITY_CREDENTIAL on the host — compose passes ' +
        'it in as BEACON_SERVICE_CREDENTIAL — and this journey registers again. micro-org#361.',
    )
  }
  ctx.assert(
    false,
    `identity answered ${code} to a registration presented by a SERVICE PRINCIPAL. The bypass is ` +
      'the principal and not a header, so this is an expired or revoked credential, or identity no ' +
      'longer excusing a service token on the register path — neither is fixed by retrying. ' +
      'micro-org#361.',
  )
  return result
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
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE CHALLENGE BYPASS IS THE PRINCIPAL. THERE IS NOTHING HERE FOR ANYONE TO COPY.**
 *
 * micro-org#361 puts a Cloudflare Turnstile in front of registration, and beacon cannot solve one:
 * a Turnstile is a proof that a browser did some work, and there is no browser on this path. So
 * identity excuses a caller who authenticates as a SERVICE — a bearer minted above from a
 * credential this container holds and nothing else does.
 *
 * It is deliberately not a magic header, a shared bypass string or an IP allowlist. Each of those
 * three is a credential in the ordinary sense and none of them can be kept: a header name and its
 * value are visible to anything that watches one request, a shared string ships in whatever
 * artefact holds it, and a source address is spoofable and is shared with every other container on
 * the network. A bearer expires in ten minutes and is minted per run from a credential that lives
 * only in the environment of this process.
 *
 * A deployment with no challenge is unaffected — the token is presented, and identity's register
 * route does not care about a bearer it has no reason to look at.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function registerAccount(
  ctx: JourneyContext,
  identity: string,
  account: Throwaway,
): Promise<CallResult> {
  const body = { email: account.email, handle: account.handle, password: account.password }
  // Minted once and reused across the retry below. The TTL is 600s and the longest this waits is
  // 62s, so a second mint would buy nothing and cost identity another exchange.
  const token = await mintServiceToken(ctx, identity)
  const post = (): Promise<CallResult> =>
    call(ctx, `${identity}/auth/register`, {
      method: 'POST',
      body,
      ...(token === null ? {} : { token }),
    })

  const first = await post()
  if (first.status !== 429) return afterChallenge(ctx, first, token)

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

  const second = await post()
  if (second.status === 429) {
    ctx.skip(
      `registration is rate limited after waiting ${Math.round(waitMs / 1_000)}s for identity's own ` +
        'retry-after. Beacon is registering faster than identity permits: one scheduler cycle ' +
        'makes seven registrations against a ceiling of five per minute per address.',
    )
  }
  return afterChallenge(ctx, second, token)
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
