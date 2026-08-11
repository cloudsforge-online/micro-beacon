/**
 * The bounded pool of accounts the journeys sign in as, instead of registering one each.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS FILE EXISTS: 15,197 ROWS IN A PRODUCTION IDENTITY TABLE TO PROVE REGISTRATION WORKS.**
 *
 * Measured on mainnet 2026-08-11 (micro-org#390), straight out of identity's database: 15,364 user
 * rows, of which 15,210 are `beacon+…@beacon.test`, growing by 2,231–2,256 a DAY — one every
 * ~38 seconds, against an estate with no real users at all. `channel_targets` in notify carried
 * 12,975 of the matching addresses. Nothing reaped any of them, because identity has no
 * account-deletion route a monitor may call: `DELETE /users/me` demands the account's own password
 * AND opens a grace window rather than removing a row, so even spending it would leave the row and
 * add a tombstone job per journey run.
 *
 * The arithmetic that produced 2,250/day is entirely beacon's own and is worth writing down,
 * because it is what this file changes. Eight registrations per scheduler cycle — `identity.signin`,
 * `identity.handoff`, `identity.register`, one each for four `ecosystem.*` journeys and a second
 * for `ecosystem.event-bus`'s bystander — at the 300s default cadence, is 8 × 12 × 24 = 2,304.
 *
 * **The registration path is still exercised, and that is not negotiable.** `identity.register`
 * still registers a real, fresh account against the real route on every one of its runs; what
 * changed is its cadence (see `REGISTER_INTERVAL_MS` in `estate.ts`) and the fact that it is now
 * the ONLY journey that registers. Everything else signs in as one of a fixed, small set of
 * accounts that were created once. Blinding the monitor to fix its own side effect would have been
 * the worse defect of the two.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A FRESHLY REGISTERED ACCOUNT CANNOT SIGN IN, WHICH IS WHY A POOL IS THE ONLY SHAPE THAT WORKS.**
 *
 * This is not a preference for fewer rows. Since identity grew email verification,
 * `POST /auth/register` answers **202 with no session at all**, and `signInRefusal` (identity's
 * `users.ts`) refuses `unverified` — so the account beacon just made is one it can do nothing with.
 * Measured against mainnet identity 2.5.19 on 2026-08-11, as a service principal:
 *
 *     POST /auth/register           202  {"verificationRequired":true, …}   — no token, no user id
 *     POST /auth/login  (that account)   403  {"error":{"code":"email_unverified", …}}
 *
 * The only thing that mints the first session is `POST /auth/email/verify`, which spends a token
 * that exists in exactly one place — the `identity.email.verification_requested` event payload, in
 * notify's outbox. Beacon does not probe notify, must not read another service's outbox, and the
 * token is a live credential that would then be in this process's memory and one careless log line
 * from disk (micro-org#371 says so in as many words). So there is no in-band way for this harness
 * to verify an account it created, and there will not be one.
 *
 * Which leaves accounts that were verified ONCE, out of band, by whoever runs the estate — and a
 * credential that arrives from the deployment is exactly what `BEACON_SERVICE_CREDENTIAL` and
 * `BEACON_HANDOFF_ORIGIN` already are. Unset is a SKIP naming the variable and the provisioning
 * step, never a fail: an estate that has not provisioned the pool has not demonstrated a broken
 * product. `scripts/provision-journey-accounts.md` is the procedure.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **JSON, NOT `a=b,c=d`, AND THAT IS A CORRECTION RATHER THAN A PREFERENCE.**
 *
 * `BEACON_TARGETS` is a comma-separated list because a URL cannot contain a comma. A PASSWORD can
 * contain anything at all — it is opaque bytes chosen by whoever provisioned the account — so a
 * delimiter-separated list has a class of legal value it silently mangles, and the symptom is a
 * monitor that cannot sign in for a reason nobody reading the variable can see. JSON has no such
 * class. `targets.ts`'s strict-rather-than-lenient argument is inherited in full: every malformed
 * entry throws, because a pool that quietly parsed to fewer accounts than it names would skip
 * journeys for a typo and report the skip as an estate fact.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { accessToken, call, stringField, type Json } from './calls.ts'
import type { JourneyContext } from './journeys.ts'

/** Thrown for a malformed pool. `env.ts` re-raises it as an `EnvError`, so its callers see one type. */
export class PoolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PoolError'
  }
}

export interface PoolAccount {
  readonly email: string
  readonly password: string
}

/**
 * Which journey holds which account, as one table.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **A SLOT PER CONSUMER, NOT A CHECKOUT QUEUE, AND THE REASON IS REPLICAS.**
 *
 * `throwaway()`'s header states the hazard this must not reintroduce: two journeys sharing one
 * account move each other's balance and each other's session, and the flake that produces is
 * indistinguishable from the outage it gets reported as. A free-list would prevent that inside one
 * process and NOT between two — journey jobs are leased individually, so two replicas can be
 * running two different journeys in the same second, and each would hand out its own idea of which
 * account is free. A static assignment has no such state to disagree about: a slot belongs to one
 * consumer on every replica, for ever, because it is written here.
 *
 * `ecosystem.event-bus` holds TWO. Its last step reads one account's feed with another account's
 * token and asserts the first record is not visible — the estate's worst possible data leak if it
 * ever regresses — and that assertion is meaningless if both tokens are the same subject.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
export const POOL_SLOTS: Readonly<Record<string, number>> = Object.freeze({
  'identity.signin': 0,
  'identity.handoff': 1,
  'ecosystem.event-bus/subject': 2,
  'ecosystem.event-bus/bystander': 3,
  'ecosystem.one-activity': 4,
  'ecosystem.one-portfolio': 5,
  'ecosystem.one-account': 6,
  'ecosystem.deposit-address': 7,
})

/** How many accounts a fully-exercised deployment has to provision. Derived, never a second literal. */
export const REQUIRED_POOL_SIZE = Object.keys(POOL_SLOTS).length

/**
 * `BEACON_JOURNEY_ACCOUNTS`, parsed — in a module with no side effects, for `targets.ts`'s reason.
 *
 * An empty or absent value is an EMPTY POOL rather than an error, because "this deployment has not
 * provisioned one" is the state every developer machine and every CI run is in, and it is answered
 * with a skip at the point of use where the message can name the journey. A value that is present
 * and wrong is an error: it is somebody who meant to configure this and did not.
 */
export function parsePool(raw: string): readonly PoolAccount[] {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // The value is NOT in the message, here or anywhere below. It is a list of live passwords, and
    // an env parser that echoes what it could not read is how a credential reaches a boot log.
    throw new PoolError('BEACON_JOURNEY_ACCOUNTS is not valid JSON. It is a JSON array of {"email","password"} objects')
  }
  if (!Array.isArray(parsed)) {
    throw new PoolError('BEACON_JOURNEY_ACCOUNTS must be a JSON ARRAY of {"email","password"} objects')
  }

  const accounts: PoolAccount[] = []
  const seen = new Set<string>()
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new PoolError(`BEACON_JOURNEY_ACCOUNTS entry ${index} is not an object`)
    }
    const { email, password } = entry as { email?: unknown; password?: unknown }
    if (typeof email !== 'string' || email.length === 0 || !email.includes('@')) {
      throw new PoolError(`BEACON_JOURNEY_ACCOUNTS entry ${index} has no usable "email"`)
    }
    if (typeof password !== 'string' || password.length === 0) {
      // The entry's INDEX and nothing else. Naming the email of the account whose password is
      // missing would be harmless; naming them by position keeps every message in this parser to
      // one rule, so no later edit has to decide which half of a credential pair is safe to print.
      throw new PoolError(`BEACON_JOURNEY_ACCOUNTS entry ${index} has no usable "password"`)
    }
    // Two slots resolving to one account is the shared-account hazard `POOL_SLOTS` exists to
    // prevent, arriving through configuration instead of through code. Refused where it is one
    // line rather than in `ecosystem.event-bus`, where it would surface as a data-leak assertion
    // that cannot fail.
    if (seen.has(email)) throw new PoolError(`BEACON_JOURNEY_ACCOUNTS names ${email} twice`)
    seen.add(email)
    accounts.push({ email, password })
  }
  return Object.freeze(accounts)
}

/** Read at call time rather than at import, so a test can set it without reloading the module. */
export function pool(): readonly PoolAccount[] {
  return parsePool(process.env['BEACON_JOURNEY_ACCOUNTS'] ?? '')
}

/**
 * The account for a slot, or a skip that says what to do about its absence.
 *
 * Never returns undefined and never throws a bare error: every exit from here is either an account
 * or a `ctx.skip` whose text names the variable, the slot, and the size the pool has to reach. A
 * refusal carries its reason.
 */
export function poolAccount(ctx: JourneyContext, slot: keyof typeof POOL_SLOTS | string): PoolAccount {
  const index = POOL_SLOTS[slot]
  if (index === undefined) {
    // Not a skip. A slot name that is not in the table is this repository being wrong about itself,
    // and `pool.test.ts` proves every call site's slot resolves — so reaching this at runtime means
    // the table and the call sites have drifted and the journey is not testing what it claims.
    throw new PoolError(`no pool slot is declared for "${String(slot)}"`)
  }
  const accounts = pool()
  if (accounts.length === 0) {
    ctx.skip(
      'BEACON_JOURNEY_ACCOUNTS is not set, so this journey has no account to be. A fresh ' +
        'registration cannot be used: POST /auth/register answers 202 with no session and ' +
        'signInRefusal refuses an unverified account, so the pool has to be provisioned once, out ' +
        'of band. See scripts/provision-journey-accounts.md. micro-org#390.',
    )
  }
  const account = accounts[index]
  if (!account) {
    ctx.skip(
      `BEACON_JOURNEY_ACCOUNTS holds ${accounts.length} accounts and this journey uses slot ` +
        `${index} ("${String(slot)}"). ${REQUIRED_POOL_SIZE} are needed for every journey to run; ` +
        'a shorter pool is not shared out, because two journeys on one account move each other’s ' +
        'balance and each other’s session. See scripts/provision-journey-accounts.md.',
    )
  }
  return account as PoolAccount
}

export interface PoolSession {
  readonly token: string
  readonly userId: string
  readonly account: PoolAccount
}

interface CachedSession {
  readonly token: string
  readonly userId: string
  /** Epoch millis at which this token stops being usable, already reduced by `EXPIRY_MARGIN_MS`. */
  readonly notAfter: number
}

/**
 * How early a cached token is treated as spent.
 *
 * Sixty seconds. A journey may hold a token for the whole of its 90s deadline, and a token that
 * expires mid-journey produces a 401 from a downstream service — which every assertion here reads
 * as "hub-api refused a valid session", i.e. the product broken, at whichever step happened to be
 * running. That misattribution is the entire cost of getting this wrong, and one extra sign-in per
 * token lifetime is the entire cost of getting it wrong the other way.
 */
export const EXPIRY_MARGIN_MS = 60_000

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SESSION CACHE, AND WHY IT IS NOT THE MODULE-SCOPE STATE THIS REPOSITORY BANS.**
 *
 * `jobs.ts` bans module-scope TIMERS, and says why: a `setInterval` in module scope means two
 * replicas do the work twice, and the estate's predecessor had three of them. This is not that. It
 * schedules nothing, it recurs on nothing, and two replicas holding two caches produce two
 * sign-ins for one account rather than two runs of one job — the accounts are separate per slot, so
 * there is no row anywhere that two replicas would fight over.
 *
 * It exists for a limit that is real and was measured: identity throttles `POST /auth/login` to
 * **10 per 60s per source address** (its `LIMITS` table) and every journey in this process shares
 * one address. Signing in per slot per cycle is eight logins inside a twelve-second burst, plus the
 * two `identity.signin` makes itself — which is the same self-inflicted 429 the registration
 * ceiling block in `calls.ts` describes at length, moved one route across. Cached, it is eight
 * logins per token lifetime instead of eight per cycle.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const sessions = new Map<number, CachedSession>()

/** For tests, and for nothing else: there is no route and no job that clears this. */
export function forgetSessions(): void {
  sessions.clear()
}

/**
 * Sign in as the slot's account, reusing the token from last time while it is still good.
 *
 * A 403 is separated from every other refusal on purpose. `email_unverified` means the pool was
 * provisioned but never verified, which is the one mistake the provisioning procedure invites and
 * the one whose default message ("expected 200 from /auth/login") sends the reader to identity
 * instead of to the runbook.
 */
export async function poolSession(
  ctx: JourneyContext,
  identity: string,
  slot: keyof typeof POOL_SLOTS | string,
  options: {
    /**
     * Sign in even when a good token is already cached.
     *
     * For the one caller whose subject is the sign-in itself: `ecosystem.event-bus` needs a fact
     * COMMITTED IN IDENTITY on this run, and a cache hit commits nothing — no session row, no
     * outbox row, nothing for the relay to carry. It would then wait out its whole deadline for an
     * event nobody emitted and report a broken bus on a working estate.
     */
    readonly fresh?: boolean
  } = {},
): Promise<PoolSession> {
  const account = poolAccount(ctx, slot)
  const index = POOL_SLOTS[slot] as number

  const cached = sessions.get(index)
  if (!options.fresh && cached && cached.notAfter > Date.now()) {
    return { token: cached.token, userId: cached.userId, account }
  }

  const result = await call(ctx, `${identity}/auth/login`, {
    method: 'POST',
    // `identifier`, NOT `email`. See `identity.signin` in `estate.ts`: contracts-auth's
    // `validateLogin` has never read `email`, and posting it made a CRITICAL journey answer 400 on
    // every run for as long as it existed.
    body: { identifier: account.email, password: account.password },
  })

  if (result.status === 429) {
    ctx.skip(
      'sign-in is rate limited (identity allows 10 per minute per source address, and every ' +
        'journey in this process shares one). The pool exists so that this is rare; if it is not, ' +
        'the session cache is not being hit.',
    )
  }
  if (result.status === 403) {
    const code = stringField(result.body as Json, 'error', 'code')
    if (code === 'email_unverified') {
      ctx.skip(
        `the pool account in slot ${index} ("${String(slot)}") has never confirmed its address, so ` +
          'identity refuses to sign it in. Provisioning creates the account; VERIFYING it is the ' +
          'second half and is the step that gets missed. See scripts/provision-journey-accounts.md.',
      )
    }
    ctx.skip(
      `identity refused the pool account in slot ${index} ("${String(slot)}") with ${String(code)}. ` +
        'That is an account state — suspended, locked or pending deletion — and not something ' +
        'this journey can put right by retrying.',
    )
  }
  ctx.assert(
    result.status === 200,
    `expected 200 signing in as the pool account for "${String(slot)}", got ${result.status}`,
  )

  const token = accessToken(result.body)
  ctx.assert(token !== null, `signing in as the pool account for "${String(slot)}" returned no access token`)
  const userId = stringField(result.body, 'user', 'id')
  ctx.assert(userId !== null, `signing in as the pool account for "${String(slot)}" returned no user id`)

  sessions.set(index, {
    token: token as string,
    userId: userId as string,
    notAfter: Date.now() + expiryMsOf(result.body) - EXPIRY_MARGIN_MS,
  })
  return { token: token as string, userId: userId as string, account }
}

/**
 * How long identity says the token is good for, in millis, floored so a cache entry can never
 * outlive its token.
 *
 * A response that omits `expiresIn`, or carries something that is not a positive finite number, is
 * treated as ONE margin — which after the subtraction above is zero, so the next call signs in
 * again. Trusting a default here would be caching a token for a lifetime identity never quoted,
 * and the failure mode of that is a 401 attributed to whichever service the journey dialled next.
 */
export function expiryMsOf(body: Json): number {
  const raw = (body as { expiresIn?: unknown }).expiresIn
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return EXPIRY_MARGIN_MS
  return seconds * 1_000
}
