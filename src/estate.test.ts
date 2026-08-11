/**
 * The six per-service journeys, driven against a fake estate that answers what the real one does.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE WERE NO TESTS HERE UNTIL 2026-08-03, AND TWO OF THE SIX COULD ONLY EVER FAIL.**
 *
 * `identity.signin` posted `{ email, password }` to a route whose contract reads `identifier`, and
 * `identity.handoff` posted `{}` to a route that requires `redirectOrigin` and redeemed without the
 * `Origin` header the redemption route demands. Both are CRITICAL, so the release gate refused
 * every release — for the monitor's own defect, reported as the product being broken.
 *
 * Neither would have been caught by the obvious test. "The journey posts the body the journey was
 * written to post" is the client test this estate has already been bitten by: it asserts the code
 * agrees with itself. What catches it is a fake that answers **what the real service answers**,
 * including the 400 — so the shapes below were read off the running dev estate, and off
 * `@cloudsforge/contracts-auth`'s `validateLogin`, rather than invented.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every case follows the same shape, and the second half is the half that matters: run it green,
 * then break exactly one thing and prove it goes RED, at the named step, as a `fail` rather than
 * an `error`. A guard nobody has watched fail is a guard nobody knows the state of.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ESTATE_REACHABLE,
  IDENTITY_CHALLENGE,
  IDENTITY_HANDOFF,
  IDENTITY_REGISTER,
  IDENTITY_SIGNIN,
  REGISTER_INTERVAL_MS,
  MARKET_CATALOGUE,
  WORLDS_REGISTRY,
} from './estate.ts'
import { MAX_REGISTER_WAIT_MS, REGISTER_RETRY_MARGIN_MS, registerRetryMs } from './calls.ts'
import { runJourney, type JourneyDefinition, type JourneyRun } from './journeys.ts'
import { fakeEstate, type FakeEstate, type FakeHandler, type FakeRequest } from './testsupport.ts'
import { forgetSessions, POOL_SLOTS, REQUIRED_POOL_SIZE } from './pool.ts'

/**
 * The healthy registration handler, so a test can refuse the first attempt and then delegate.
 *
 * Throws rather than returning undefined: a test that silently got no handler would install a
 * wrapper around nothing and assert against a 404, which reads as the journey being broken.
 */
function registerHandlerOf(estate: FakeEstate): FakeHandler {
  const handler = estate.handlerFor('POST /auth/register')
  if (!handler) throw new Error('the fake estate has no POST /auth/register handler')
  return handler
}

const SERVICES = ['identity', 'market', 'worlds', 'ledger', 'hub-api', 'activity']

/** The origin `IDENTITY_HANDOFF_ORIGINS` would name. Set per test, never left set. */
const ORIGIN = 'https://hub.cloudsforge.test'

interface Account {
  readonly id: string
  readonly email: string
  readonly handle: string
  readonly password: string
  /**
   * Whether the address has been confirmed.
   *
   * Modelled rather than waved through, because it is the whole of what changed in identity: a
   * fresh registration is unverified and `signInRefusal` refuses it, so a fake that let a new
   * account sign in would let every journey below pass against a shape the estate stopped serving.
   * Which is exactly what this fake did until 2026-08-11.
   */
  readonly verified: boolean
}

/**
 * The provisioned pool, as the deployment would supply it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THESE ACCOUNTS ARE VERIFIED AND A REGISTERED ONE IS NOT, AND THAT ASYMMETRY IS THE FIXTURE.**
 *
 * `BEACON_JOURNEY_ACCOUNTS` names accounts somebody created and confirmed once, out of band, which
 * is the only kind of account that can sign in. Every journey that used to register to obtain a
 * session now signs in as one of these; `identity.register` still registers, and what it asserts is
 * that the account it just made can NOT sign in.
 *
 * Eight, because `POOL_SLOTS` declares eight and `pool.test.ts` proves that number is the one the
 * call sites need. A shorter fixture here would make the journeys skip and every assertion below
 * would pass by never running.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const POOL = Array.from({ length: REQUIRED_POOL_SIZE }, (_, index) => ({
  email: `pool${index}@beacon.test`,
  password: `Pool-pass-${index}`,
}))

/**
 * The user id the fake gives a pool member, as ONE function.
 *
 * A test that stubs `/auth/me` has to answer for the account the journey actually signed in as, and
 * hard-coding the id in each stub would make every one of them a second copy of a fact this file
 * already states. The copies would then be right until the fake changed shape, at which point the
 * stub would answer for a subject that does not exist and the test would report the journey broken.
 */
function poolUserId(slot: number): string {
  return `019fc4ba-0b1e-7000-9000-${String(slot).padStart(12, '0')}`
}

/**
 * An estate that behaves like the real one.
 *
 * The password check, the `identifier` field, the origin binding and the single-use code are all
 * modelled, because each of them is a property a journey asserts and a fake that waved them
 * through would let the journey pass without exercising anything.
 */
async function healthyEstate(): Promise<FakeEstate> {
  const estate = await fakeEstate(SERVICES)
  const accounts = new Map<string, Account>()
  const byToken = new Map<string, Account>()
  const codes = new Map<string, { account: Account; origin: string; used: boolean }>()
  let next = 0

  const issue = (account: Account): string => {
    const token = `tok_${account.id}_${next++}`
    byToken.set(token, account)
    return token
  }
  const bearer = (req: { headers: Readonly<Record<string, string>> }): Account | null => {
    const header = req.headers['authorization'] ?? ''
    if (!header.startsWith('Bearer ')) return null
    return byToken.get(header.slice(7)) ?? null
  }

  // The pool, already confirmed, exactly as a provisioned deployment would hold it.
  for (const [index, member] of POOL.entries()) {
    accounts.set(member.email, {
      id: poolUserId(index),
      email: member.email,
      handle: `pool${index}`,
      password: member.password,
      verified: true,
    })
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **202 WITH NO SESSION. THIS ANSWERED 201 WITH ONE, AND THAT IS WHY THE SUITE WAS GREEN WHILE
   * SEVEN JOURNEYS FAILED ON MAINNET EVERY FIVE MINUTES.**
   *
   * micro-org#371's finding, and it is about this file more than about the journeys: identity
   * stopped issuing a session at registration, beacon went on demanding one, and beacon's own tests
   * could not see it because the fake served the shape the journeys expected rather than the shape
   * the estate serves. A check that cannot fail, pointed at an integration boundary.
   *
   * The body below is copied from a real response, taken from mainnet identity 2.5.19 on
   * 2026-08-11 as a service principal:
   *
   *     202 {"verificationRequired":true,"email":"beacon+…@beacon.test",
   *          "status":"Check your email for a verification link. It expires in 24 hours and works once."}
   *
   * `flipRegisterTo201` below turns this back, and a test asserts the journey REDDENS when it does.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  estate.route('POST /auth/register', (req) => {
    const email = String(req.body['email'] ?? '')
    const handle = String(req.body['handle'] ?? '')
    const password = String(req.body['password'] ?? '')
    if (!email || !handle || !password) return { status: 400, body: { error: { code: 'bad_request' } } }
    if (accounts.has(email)) return { status: 409, body: { error: { code: 'conflict' } } }
    const account: Account = { id: `019fc4ba-0b1e-7000-8fd4-${String(next).padStart(12, '0')}`, email, handle, password, verified: false }
    accounts.set(email, account)
    return {
      status: 202,
      // The NORMALISED address, which is what identity echoes and what the journey asserts on.
      body: { verificationRequired: true, email: email.toLowerCase(), status: 'Check your email for a verification link. It expires in 24 hours and works once.' },
    }
  })

  // The real contract: `identifier`, never `email`, and a 400 that does not say which of the two
  // was wrong. See `@cloudsforge/contracts-auth` `validateLogin`.
  estate.route('POST /auth/login', (req) => {
    const identifier = req.body['identifier']
    const password = req.body['password']
    if (typeof identifier !== 'string' || identifier === '' || typeof password !== 'string' || password === '') {
      return { status: 400, body: { error: { code: 'bad_request', message: 'an identifier and a password are required' } } }
    }
    const account = accounts.get(identifier)
    if (!account || account.password !== password) {
      return { status: 401, body: { error: { code: 'unauthenticated' } } }
    }
    // 403 and `email_unverified`, not 401. identity separates "that credential is wrong" from "that
    // credential is right and the address is unproved", and `identity.register` asserts the second
    // of those by code — a fake that answered 401 here would let that assertion pass while proving
    // the opposite of what it says.
    if (!account.verified) {
      return { status: 403, body: { error: { code: 'email_unverified', message: 'confirm your email address before signing in' } } }
    }
    return { status: 200, body: { accessToken: issue(account), refreshToken: 'r', expiresIn: 900, user: { id: account.id, email: account.email, handle: account.handle } } }
  })

  estate.route('GET /auth/me', (req) => {
    const account = bearer(req)
    if (!account) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    return { status: 200, body: { user: { id: account.id, email: account.email, handle: account.handle }, session: { id: 's', amr: ['pwd'] }, organisations: [] } }
  })

  estate.route('POST /auth/handoff', (req) => {
    const account = bearer(req)
    if (!account) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    const origin = req.body['redirectOrigin']
    if (typeof origin !== 'string' || origin === '') {
      return { status: 400, body: { error: { code: 'bad_request', message: 'redirectOrigin is required' } } }
    }
    if (origin !== ORIGIN) return { status: 403, body: { error: { code: 'forbidden' } } }
    const code = `code_${next++}`
    codes.set(code, { account, origin, used: false })
    return { status: 201, body: { code, expiresInSeconds: 60 } }
  })

  estate.route('POST /auth/handoff/redeem', (req) => {
    const code = req.body['code']
    if (typeof code !== 'string' || code === '') {
      return { status: 400, body: { error: { code: 'bad_request', message: 'code is required' } } }
    }
    const origin = req.headers['origin']
    if (!origin) return { status: 400, body: { error: { code: 'bad_request', message: 'an Origin header is required' } } }
    const entry = codes.get(code)
    if (!entry || entry.used || entry.origin !== origin) {
      return { status: 401, body: { error: { code: 'unauthenticated' } } }
    }
    codes.set(code, { ...entry, used: true })
    return { status: 200, body: { accessToken: issue(entry.account), refreshToken: 'r', expiresIn: 900, user: { id: entry.account.id, email: entry.account.email, handle: entry.account.handle } } }
  })

  // A deployment with no Turnstile account — every developer machine, CI, and the estate until the
  // secret and the site key are put on the host. `identity/src/env.ts` decides `required` from
  // whether it holds BOTH, so this is the answer the fake estate gives and the challenged variant
  // below is what overrides it. micro-org#361.
  estate.route('GET /auth/challenge', () => ({
    status: 200,
    body: { required: false, provider: 'turnstile', siteKey: null, action: 'signup' },
  }))

  estate.route('GET /v1/listings', () => ({ status: 200, body: { listings: [] } }))
  estate.route('GET /v1/collections', () => ({ status: 200, body: { collections: [] } }))
  estate.route('GET /v1/titles', () => ({ status: 200, body: { titles: [] } }))
  estate.route('GET /livez', () => ({ status: 200, body: { status: 'live' } }))

  return estate
}

async function run(definition: JourneyDefinition, estate: FakeEstate): Promise<JourneyRun> {
  return runJourney(definition, { targets: estate.targets, deadlineMs: 20_000 })
}

/** Asserts the run failed, at the step named, as a product failure rather than a harness one. */
function assertFailedAt(result: JourneyRun, step: string): void {
  assert.equal(
    result.status,
    'fail',
    `expected a product failure, got ${result.status}: ${String(result.error)}`,
  )
  assert.equal(result.failedStep, step, `failed at "${String(result.failedStep)}"`)
}

async function withEstate(body: (estate: FakeEstate) => Promise<void>): Promise<void> {
  const estate = await healthyEstate()
  // The pool is configuration, so it is set per test and never left set — the same treatment
  // `ORIGIN` and the service credential get in this file. `forgetSessions` matters as much: the
  // token cache is keyed on slot and would otherwise carry a token minted against the PREVIOUS
  // test's fake estate into the next one, where the port is different and the token is unknown.
  process.env['BEACON_JOURNEY_ACCOUNTS'] = JSON.stringify(POOL)
  forgetSessions()
  try {
    await body(estate)
  } finally {
    delete process.env['BEACON_JOURNEY_ACCOUNTS']
    forgetSessions()
    await estate.close()
  }
}

/** The same estate with no pool provisioned, for the skip-with-a-reason cases. */
async function withoutPool(body: (estate: FakeEstate) => Promise<void>): Promise<void> {
  await withEstate(async (estate) => {
    delete process.env['BEACON_JOURNEY_ACCOUNTS']
    forgetSessions()
    await body(estate)
  })
}

/* ------------------------------------------------------------------ identity.register */

test('identity.register passes against a healthy estate', async () => {
  await withEstate(async (estate) => {
    const result = await run(IDENTITY_REGISTER, estate)
    assert.equal(result.status, 'pass', String(result.error))
  })
})

test('THE MUTATION: identity.register goes red when registration mints a session again', async () => {
  await withEstate(async (estate) => {
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THIS IS THE TEST micro-org#371 ASKS FOR BY NAME, AND THE ONE THAT DID NOT EXIST.**
     *
     * The ticket's requirement, verbatim: "flipping the fake's status to 201 has to redden the
     * test, or the fake is still the thing being tested." That is what this does — the fake is put
     * back to exactly the body it served before 2026-08-11, and the journey must fail.
     *
     * Why it matters more than the status: 201-with-a-session is not a stale shape, it is the
     * DEFECT. It signed in an address nobody had proved control of, and the owner reported both
     * halves from the live product — "i didn't receive any registration email and i was able to
     * login directly". A journey that accepted either status would go green on the day identity
     * regressed, which is precisely how this one went green while mainnet failed every cycle.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    estate.route('POST /auth/register', (req) => ({
      status: 201,
      body: {
        accessToken: 'tok_regression',
        refreshToken: 'r',
        expiresIn: 900,
        user: { id: 'u', email: String(req.body['email']), handle: String(req.body['handle']) },
      },
    }))
    const result = await run(IDENTITY_REGISTER, estate)
    assertFailedAt(result, 'register')
    assert.match(String(result.error), /expected 202 from \/auth\/register, got 201/)
  })
})

test('identity.register goes red when a 202 still carries a session', async () => {
  await withEstate(async (estate) => {
    // The subtler half, and the one a status check alone would walk straight past: identity keeps
    // the 202 and puts the token back in the body. Every "did it answer 202" assertion in the
    // estate passes, and an unverified address is signed in again.
    estate.route('POST /auth/register', (req) => ({
      status: 202,
      body: { verificationRequired: true, email: String(req.body['email']).toLowerCase(), accessToken: 'tok_sneaky' },
    }))
    const result = await run(IDENTITY_REGISTER, estate)
    assertFailedAt(result, 'the response carries no session')
    assert.match(String(result.error), /THE ABSENCE OF A SESSION IS THE POINT OF THIS ROUTE/)
  })
})

test('identity.register goes red when an unverified account is allowed to sign in', async () => {
  await withEstate(async (estate) => {
    // The security property the 202 exists to create, asserted from the other end. Kills the
    // mutation "drop the unverified check from signInRefusal": registration would still answer 202
    // with no session, every assertion above would still pass, and the account would be usable
    // without its address ever being proved — which is the whole defect, reintroduced silently.
    estate.route('POST /auth/login', () => ({
      status: 200,
      body: { accessToken: 'tok', refreshToken: 'r', expiresIn: 900, user: { id: 'u' } },
    }))
    const result = await run(IDENTITY_REGISTER, estate)
    assertFailedAt(result, 'the account cannot sign in until the address is confirmed')
  })
})

test('identity.register goes red when the refusal is a 403 for some OTHER reason', async () => {
  await withEstate(async (estate) => {
    // A suspended account is also refused, and also with a 403. Reading any 403 as proof that
    // verification is enforced would let this step report the feature working on a deployment
    // where registration stored nothing at all.
    estate.route('POST /auth/login', () => ({
      status: 403,
      body: { error: { code: 'account_suspended', message: 'this account is suspended' } },
    }))
    const result = await run(IDENTITY_REGISTER, estate)
    assertFailedAt(result, 'the account cannot sign in until the address is confirmed')
    assert.match(String(result.error), /not\s+email_unverified/)
  })
})

test('identity.register REGISTERS EXACTLY ONE ACCOUNT PER RUN', async () => {
  await withEstate(async (estate) => {
    const result = await run(IDENTITY_REGISTER, estate)
    assert.equal(result.status, 'pass', String(result.error))
    /*
     * The row count, as an assertion. micro-org#390's measurement was 2,231 permanent identity rows
     * a day from a monitor proving registration works, and this journey is now the only thing in
     * beacon that creates one.
     *
     * **Kills the mutation "register again in the no-session step".** That is the natural way to
     * write a second assertion about a response — call the helper again — it passes every other
     * test in this file, and it silently doubles the only remaining source of rows. It was in the
     * first draft of this change.
     */
    const registrations = estate.requests.filter((request) => request.path === '/auth/register')
    assert.equal(registrations.length, 1)
  })
})

test('identity.register runs at its OWN cadence, not the estate default', () => {
  // A floor of thirty minutes: 48 rows a day instead of 288. The number is asserted here rather
  // than only in `jobs.test.ts` because it is the whole reason this journey is allowed to keep
  // registering at all, and a later edit that deleted the field would otherwise be caught by
  // nothing — `intervalMs` is optional, so its absence typechecks.
  assert.equal(IDENTITY_REGISTER.intervalMs, REGISTER_INTERVAL_MS)
  assert.equal(REGISTER_INTERVAL_MS, 1_800_000)
})

test('identity.signin and identity.handoff SKIP, with the runbook named, when no pool is provisioned', async () => {
  await withoutPool(async (estate) => {
    // Not a fail. An estate that has not provisioned the pool has not demonstrated a broken
    // product, and a fail here would open an incident against identity for a deploy step nobody
    // has run. Kills "assert 200 and let it fail", which is what the old registration path did on
    // mainnet for a whole day once the register shape changed.
    for (const journey of [IDENTITY_SIGNIN, IDENTITY_HANDOFF]) {
      process.env['BEACON_HANDOFF_ORIGIN'] = ORIGIN
      try {
        const result = await run(journey, estate)
        assert.equal(result.status, 'skip', `${journey.name}: ${String(result.error)}`)
        assert.match(String(result.error), /BEACON_JOURNEY_ACCOUNTS/)
      } finally {
        delete process.env['BEACON_HANDOFF_ORIGIN']
      }
    }
  })
})

test('identity.signin SIGNS IN FOR REAL on every run, and never serves a cached token', async () => {
  await withEstate(async (estate) => {
    // A sign-in journey that reused a pool session would be the estate's favourite defect: a check
    // that cannot fail, guarding the one route it is named after. Kills "use poolSession here too",
    // which is the tidier-looking edit and would leave this journey asserting nothing about
    // /auth/login at all on any run after the first.
    await run(IDENTITY_SIGNIN, estate)
    const before = estate.requests.filter((request) => request.path === '/auth/login').length
    const result = await run(IDENTITY_SIGNIN, estate)
    assert.equal(result.status, 'pass', String(result.error))
    const after = estate.requests.filter((request) => request.path === '/auth/login').length
    // Two per run: the correct password, then the wrong one.
    assert.equal(after - before, 2)
  })
})

test('identity.register goes red when /auth/me stops requiring a token', async () => {
  await withEstate(async (estate) => {
    // The regression this step exists for. A monitor that only ever checks the happy path cannot
    // tell an authenticated endpoint from an open one.
    estate.route('GET /auth/me', () => ({ status: 200, body: { user: { id: 'anyone' } } }))
    const result = await run(IDENTITY_REGISTER, estate)
    assertFailedAt(result, 'an unauthenticated read is refused')
  })
})

test('identity.register treats a rate limit as a skip, never as a failure', async () => {
  await withEstate(async (estate) => {
    // `retry-after: 1` rather than a bare 429, so this asserts the skip without also asserting a
    // five-second wait. That the wait happens at all is the next test's job.
    estate.route('POST /auth/register', () => ({
      status: 429,
      headers: { 'retry-after': '1' },
      body: { error: { code: 'too_many_requests' } },
    }))
    const result = await run(IDENTITY_REGISTER, estate)
    // The estate protecting itself is not the estate being broken, and a skip is not green
    // either — the gate refuses on it.
    assert.equal(result.status, 'skip')
  })
})

/* ------------------------------------------------- the registration ceiling, and waiting it out */

/**
 * These five are the regression suite for the defect described at the top of `calls.ts`.
 *
 * On the live estate `identity.register` and `identity.signin` — both CRITICAL — skipped
 * `registration is rate limited` on ten consecutive cycles, opening a SEV2 against each and
 * refusing every release. Nothing was wrong with identity: one Beacon scheduler cycle makes seven
 * registrations against a ceiling of five per minute per address, and `listRegistered` order is
 * alphabetical, so `ecosystem.*` spent the whole allowance before `identity.*` was reached.
 *
 * The first two fail against the code as it stood, which skipped on the first 429 without ever
 * asking identity when to come back.
 */
test('identity.register RETRIES ONCE after a 429, honouring identity’s own retry-after', async () => {
  await withEstate(async (estate) => {
    const healthy = estate.requests.length
    let attempts = 0
    const original = registerHandlerOf(estate)
    estate.route('POST /auth/register', (req) => {
      attempts += 1
      // Exactly the first attempt is refused, which is the live shape: the window rolls over and
      // the second lands. `retry-after: 1` keeps the test at a second rather than at identity's
      // real ~48.
      if (attempts === 1) {
        return { status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 'rate_limited' } } }
      }
      return original(req)
    })
    const result = await run(IDENTITY_REGISTER, estate)
    assert.equal(result.status, 'pass', String(result.error))
    assert.equal(attempts, 2, 'the journey must come back exactly once, not give up and not loop')
    assert.ok(estate.requests.length > healthy)
  })
})

test('identity.signin recovers from a rate-limited registration too', async () => {
  await withEstate(async (estate) => {
    let attempts = 0
    const original = registerHandlerOf(estate)
    estate.route('POST /auth/register', (req) => {
      attempts += 1
      if (attempts === 1) {
        return { status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 'rate_limited' } } }
      }
      return original(req)
    })
    const result = await run(IDENTITY_SIGNIN, estate)
    assert.equal(result.status, 'pass', String(result.error))
  })
})

test('a second 429 is a SKIP and never a retry loop', async () => {
  await withEstate(async (estate) => {
    let attempts = 0
    estate.route('POST /auth/register', () => {
      attempts += 1
      return { status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 'rate_limited' } } }
    })
    const result = await run(IDENTITY_REGISTER, estate)
    assert.equal(result.status, 'skip')
    // Two, not three and not "until the deadline". A journey that ground away at a limiter until
    // its 90s deadline would report `error` — Beacon broken — for an estate that is fine.
    assert.equal(attempts, 2)
    assert.match(String(result.error), /seven registrations against a ceiling of five/)
  })
})

test('a retry-after longer than the bound is a skip rather than a wait', async () => {
  await withEstate(async (estate) => {
    let attempts = 0
    estate.route('POST /auth/register', () => {
      attempts += 1
      // 600s. A service asking for ten minutes is one a 90s journey must give up against, or the
      // wait outlives the deadline and an honest skip becomes a misleading error.
      return { status: 429, headers: { 'retry-after': '600' }, body: { error: { code: 'rate_limited' } } }
    })
    const result = await run(IDENTITY_REGISTER, estate)
    assert.equal(result.status, 'skip')
    assert.equal(attempts, 1, 'nothing should be retried when the wait would exceed the bound')
  })
})

test('the wait is bounded whatever the header says, and clears the boundary', () => {
  // Pure, so the clamp is provable without waiting for anything.
  assert.equal(registerRetryMs('1'), 1_000 + REGISTER_RETRY_MARGIN_MS)
  assert.equal(registerRetryMs('60'), MAX_REGISTER_WAIT_MS + REGISTER_RETRY_MARGIN_MS)
  assert.equal(registerRetryMs('61'), 0, 'over the bound is a skip, not a clamped wait')
  assert.equal(
    registerRetryMs(null),
    5_000 + REGISTER_RETRY_MARGIN_MS,
    'a missing header is the ordinary case, not an error',
  )
  assert.equal(registerRetryMs('not-a-number'), 5_000 + REGISTER_RETRY_MARGIN_MS)
  assert.equal(registerRetryMs('-1'), 5_000 + REGISTER_RETRY_MARGIN_MS)
})

test('THE WAIT ALWAYS OVERSHOOTS retry-after, NEVER LANDS ON IT', () => {
  // The live failure this margin exists for: a retry that arrived 477ms before identity's window
  // reset was refused a second time, so a 45-second wait bought nothing. Every returned wait must
  // be strictly longer than what the service asked for.
  for (const seconds of ['1', '5', '30', '45', '60']) {
    assert.ok(
      registerRetryMs(seconds) > Number(seconds) * 1_000,
      `a wait of ${seconds}s must overshoot the boundary, not land on it`,
    )
  }
})

test('the longest possible wait still fits inside the journey deadline', () => {
  // 90s is `runJourney`'s default. A wait that could exceed it would turn an honest skip into an
  // `error`, which says Beacon is broken and sends the investigation to the wrong team.
  assert.ok(MAX_REGISTER_WAIT_MS + REGISTER_RETRY_MARGIN_MS < 90_000)
})

/* ------------------------------------------------------------------ identity.signin */

test('identity.signin passes against a healthy estate', async () => {
  await withEstate(async (estate) => {
    const result = await run(IDENTITY_SIGNIN, estate)
    assert.equal(result.status, 'pass', String(result.error))
  })
})

test('identity.signin sends `identifier`, which is the field the contract reads', async () => {
  await withEstate(async (estate) => {
    await run(IDENTITY_SIGNIN, estate)
    const logins = estate.requests.filter((r) => r.path === '/auth/login')
    assert.ok(logins.length >= 2, 'the journey should attempt a good and a bad password')
    for (const login of logins) {
      // The bug, asserted directly as well as through the journey's verdict. A journey that fails
      // for the right reason is the evidence; this is the sentence somebody reads when it does.
      assert.ok(
        typeof login.body['identifier'] === 'string',
        `POST /auth/login was sent ${JSON.stringify(login.body)} — validateLogin reads "identifier"`,
      )
      assert.equal(login.body['email'], undefined, 'no route in identity has ever read `email` on login')
    }
  })
})

test('identity.signin goes red when a wrong password is accepted', async () => {
  await withEstate(async (estate) => {
    const accounts = new Map<string, string>()
    estate.route('POST /auth/register', (req) => {
      accounts.set(String(req.body['email']), String(req.body['password']))
      return { status: 201, body: { accessToken: 'tok', user: { id: 'u', handle: String(req.body['handle']) } } }
    })
    estate.route('POST /auth/login', () => ({ status: 200, body: { accessToken: 'tok' } }))
    const result = await run(IDENTITY_SIGNIN, estate)
    assertFailedAt(result, 'the wrong password is refused')
  })
})

test('identity.signin goes red on the 400 the old body produced', async () => {
  await withEstate(async (estate) => {
    // Exactly what the real identity answered every run before the fix, reproduced so the failure
    // mode is a test rather than a memory.
    estate.route('POST /auth/login', () => ({
      status: 400,
      body: { error: { code: 'bad_request', message: 'an identifier and a password are required' } },
    }))
    const result = await run(IDENTITY_SIGNIN, estate)
    assertFailedAt(result, 'sign in')
  })
})

/* ------------------------------------------------------------------ identity.handoff */

test('identity.handoff skips, with the variable named, when no origin is configured', async () => {
  await withEstate(async (estate) => {
    delete process.env['BEACON_HANDOFF_ORIGIN']
    const result = await run(IDENTITY_HANDOFF, estate)
    assert.equal(result.status, 'skip')
    assert.match(String(result.error), /BEACON_HANDOFF_ORIGIN/)
    // A skip must still block the gate, which `journeyStatusValue` and `gate.ts` enforce. Asserted
    // here so that "we made it skip" can never be mistaken for "we made it pass".
    assert.notEqual(result.status, 'pass')
  })
})

test('identity.handoff passes end to end when the origin is on the allowlist', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_HANDOFF_ORIGIN'] = ORIGIN
    try {
      const result = await run(IDENTITY_HANDOFF, estate)
      assert.equal(result.status, 'pass', String(result.error))
      const mint = estate.requests.find((r) => r.path === '/auth/handoff')
      assert.equal(mint?.body['redirectOrigin'], ORIGIN, 'the mint must carry the origin')
      const redeem = estate.requests.find((r) => r.path === '/auth/handoff/redeem')
      assert.equal(redeem?.headers['origin'], ORIGIN, 'the redemption must carry the Origin header')
    } finally {
      delete process.env['BEACON_HANDOFF_ORIGIN']
    }
  })
})

test('identity.handoff skips rather than failing when the allowlist refuses the origin', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_HANDOFF_ORIGIN'] = 'https://not-on-the-list.test'
    try {
      const result = await run(IDENTITY_HANDOFF, estate)
      // The allowlist refusing an origin is the allowlist WORKING. Reporting identity broken here
      // would open an incident against the single most important control in the hand-off.
      assert.equal(result.status, 'skip')
      assert.match(String(result.error), /IDENTITY_HANDOFF_ORIGINS/)
    } finally {
      delete process.env['BEACON_HANDOFF_ORIGIN']
    }
  })
})

test('identity.handoff goes red when a redeemed code is accepted twice', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_HANDOFF_ORIGIN'] = ORIGIN
    try {
      let issued = 0
      estate.route('POST /auth/handoff/redeem', () => ({
        // A replayable code is a session anyone who saw one URL can take. THE security property.
        status: 200,
        body: { accessToken: `replayable_${issued++}`, user: { id: poolUserId(POOL_SLOTS['identity.handoff'] as number) } },
      }))
      // Answers for whoever registered last, so the journey's "the redeemed session is a real
      // session" step is satisfied and the run reaches the replay assertion. Breaking one property
      // at a time is the whole discipline: an estate broken in two ways proves only the first.
      // Answers for the account the journey signed in as — slot 1 is `identity.handoff`'s — so the
      // journey's "the redeemed session is a real session" step is satisfied and the run reaches
      // the replay assertion. Breaking one property at a time is the whole discipline: an estate
      // broken in two ways proves only the first.
      estate.route('GET /auth/me', () => ({
        status: 200,
        body: { user: { id: poolUserId(POOL_SLOTS['identity.handoff'] as number), handle: 'pool1' } },
      }))
      const result = await run(IDENTITY_HANDOFF, estate)
      assertFailedAt(result, 'the code is single use')
    } finally {
      delete process.env['BEACON_HANDOFF_ORIGIN']
    }
  })
})

test('identity.handoff goes red when the redemption issues no session', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_HANDOFF_ORIGIN'] = ORIGIN
    try {
      // 200 with no token: a redemption that consumed the code and delivered nothing. It reads as
      // success to anything that only checks the status, which is what the journey used to do.
      estate.route('POST /auth/handoff/redeem', () => ({ status: 200, body: { ok: true } }))
      const result = await run(IDENTITY_HANDOFF, estate)
      assertFailedAt(result, 'redeem it in the other product')
    } finally {
      delete process.env['BEACON_HANDOFF_ORIGIN']
    }
  })
})

/* ------------------------------------------------------------------ the read journeys */

test('market.catalogue goes red when /v1/listings answers without a listings array', async () => {
  await withEstate(async (estate) => {
    assert.equal((await run(MARKET_CATALOGUE, estate)).status, 'pass')
    // A 200 whose body is the wrong shape is the failure a status-only check cannot see.
    estate.route('GET /v1/listings', () => ({ status: 200, body: { items: [] } }))
    assertFailedAt(await run(MARKET_CATALOGUE, estate), 'read the listings')
  })
})

test('worlds.registry goes red when /v1/titles answers without a titles array', async () => {
  await withEstate(async (estate) => {
    assert.equal((await run(WORLDS_REGISTRY, estate)).status, 'pass')
    estate.route('GET /v1/titles', () => ({ status: 200, body: {} }))
    assertFailedAt(await run(WORLDS_REGISTRY, estate), 'read the title registry')
  })
})

test('estate.reachable goes red when one configured service stops answering /livez', async () => {
  await withEstate(async (estate) => {
    assert.equal((await run(ESTATE_REACHABLE, estate)).status, 'pass')
    estate.route('GET /livez', () => ({ status: 503, body: { status: 'down' } }))
    const result = await run(ESTATE_REACHABLE, estate)
    assert.equal(result.status, 'fail')
    // The step name carries the service, so two runs of the same outage read the same way. The
    // journey sorts its targets for exactly this reason.
    assert.match(String(result.failedStep), /is answering$/)
  })
})

test('estate.reachable skips a service this deployment has no address for', async () => {
  const estate = await fakeEstate(['identity'])
  estate.route('GET /livez', () => ({ status: 200, body: {} }))
  try {
    const result = await runJourney(ESTATE_REACHABLE, { targets: estate.targets })
    assert.equal(result.status, 'pass')
    // One step, not nine. A partial estate proves the part it does run, and says nothing about
    // the part it does not — which is different from saying that part is healthy.
    assert.equal(result.steps.length, 1)
  } finally {
    await estate.close()
  }
})

/* --------------------------------------- the registration challenge, and the principal bypass */

/**
 * micro-org#361: a Cloudflare Turnstile in front of `POST /auth/register`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FAKE ESTATE HAS TO BE ABLE TO REFUSE, OR NONE OF THIS PROVES ANYTHING.**
 *
 * The bypass is the whole risk here. Every journey that registers now presents a service bearer,
 * so a fake whose `/auth/register` ignored the Authorization header would let all of them pass
 * against a gate that was never there — the "check that cannot fail" this estate keeps shipping
 * (micro-org#355, #356). `challenged()` therefore models identity's actual rule: a token MINTED BY
 * THE EXCHANGE gets in, and a request with no bearer, with the long-lived credential itself, or
 * with any other string does not.
 *
 * The shapes are read off `identity/src/server.ts` — the 403 codes from `ChallengeError`, the
 * `{ required, provider, siteKey, action }` body of `GET /auth/challenge`, and the `{ token }` the
 * exchange answers with.
 *
 * NOTHING IN HERE IS A REAL CREDENTIAL OR A REAL SITE KEY. Both strings are this file's own
 * inventions; the secret that redeems a Turnstile token exists only on the mainnet host and is
 * never needed by, or present in, any beacon test.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const CREDENTIAL = 'cfsc_this_is_not_a_real_credential_it_lives_only_in_this_file'
const SITE_KEY = '0xTESTKEYnotTheRealOne'

/** Put a challenge in front of registration, and an exchange that mints the one way past it. */
function challenged(
  estate: FakeEstate,
  options: { siteKey?: string | null } = {},
): { readonly minted: readonly string[] } {
  const minted: string[] = []
  const register = registerHandlerOf(estate)

  estate.route('GET /auth/challenge', () => ({
    status: 200,
    body: {
      required: true,
      provider: 'turnstile',
      siteKey: options.siteKey === undefined ? SITE_KEY : options.siteKey,
      action: 'signup',
    },
  }))

  estate.route('POST /service-tokens/exchange', (req) => {
    if ((req.headers['authorization'] ?? '') !== `Bearer ${CREDENTIAL}`) {
      return { status: 401, body: { error: { code: 'unauthenticated' } } }
    }
    const token = `svc_${minted.length + 1}`
    minted.push(token)
    return { status: 201, body: { token, expiresIn: 600 } }
  })

  estate.route('POST /auth/register', (req) => {
    const header = req.headers['authorization'] ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    // The PRINCIPAL, not a header and not a string anybody can carry. `minted` holds only tokens
    // this exchange issued in this run, so presenting the credential itself — the mistake that
    // would leak a long-lived secret onto a public route — is refused here exactly as identity
    // refuses it.
    if (!minted.includes(bearer)) {
      return {
        status: 403,
        body: {
          error: {
            code: 'challenge_required',
            message: 'that registration did not carry a completed challenge',
          },
        },
      }
    }
    return register(req)
  })

  return { minted }
}

async function withCredential(body: () => Promise<void>): Promise<void> {
  process.env['BEACON_SERVICE_CREDENTIAL'] = CREDENTIAL
  try {
    await body()
  } finally {
    delete process.env['BEACON_SERVICE_CREDENTIAL']
  }
}

const requestsTo = (estate: FakeEstate, key: string): readonly FakeRequest[] =>
  estate.requests.filter((r) => `${r.method} ${r.path}` === key)

test('identity.registration-challenge passes when an unchallenged registration is refused', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    const result = await run(IDENTITY_CHALLENGE, estate)
    assert.equal(result.status, 'pass', String(result.error))

    // AND IT SENT NO CREDENTIAL. A journey that quietly acquired the bypass would report the gate
    // working while proving only that the bypass works, which is the one thing every OTHER journey
    // already proves.
    const posted = requestsTo(estate, 'POST /auth/register')
    assert.equal(posted.length, 1)
    assert.equal(posted[0]?.headers['authorization'], undefined,
      'the journey that exists to be refused presented a bearer')
  })
})

test('identity.registration-challenge goes red when the gate lets an unchallenged caller through', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    // The regression this journey exists for, and the only one that matters: a gate that is on
    // paper and open in fact. Every other journey would still be green here.
    estate.route('POST /auth/register', () => ({
      status: 202,
      body: { verificationRequired: true, email: 'whoever@example.test' },
    }))
    const result = await run(IDENTITY_CHALLENGE, estate)
    assertFailedAt(result, 'a registration carrying no challenge token is refused')
  })
})

test('identity.registration-challenge goes red when the refusal names the offending field', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    // Validation ran before the gate. The status and the code are both right and the route is an
    // existence oracle again: a 400 naming `handle` says whether a handle is taken, to somebody
    // who solved nothing.
    estate.route('POST /auth/register', () => ({
      status: 403,
      body: {
        error: { code: 'challenge_required', message: 'no' },
        fields: [{ field: 'handle', message: 'that handle is taken' }],
      },
    }))
    const result = await run(IDENTITY_CHALLENGE, estate)
    assertFailedAt(result, 'a registration carrying no challenge token is refused')
  })
})

test('identity.registration-challenge goes red when a required challenge publishes no site key', async () => {
  await withEstate(async (estate) => {
    challenged(estate, { siteKey: null })
    const result = await run(IDENTITY_CHALLENGE, estate)
    // A form nobody can complete. It fails at the FIRST step, because the second one would still
    // pass: a browser that cannot render a widget sends no token, and identity refuses it exactly
    // as it refuses a bot.
    assertFailedAt(result, 'identity publishes whether registration is challenged')
  })
})

test('identity.registration-challenge skips, and registers NOTHING, where there is no challenge', async () => {
  await withEstate(async (estate) => {
    const result = await run(IDENTITY_CHALLENGE, estate)
    assert.equal(result.status, 'skip', String(result.error))
    // ── THE MAIL QUOTA. ──────────────────────────────────────────────────────────────────────
    // On a deployment with no challenge this journey's own request would SUCCEED, creating an
    // account and costing one of the 250 sends a day the plan allows (micro-org#243). It must
    // therefore not be made at all, and this is the assertion that says so.
    assert.deepEqual(requestsTo(estate, 'POST /auth/register'), [],
      'a deployment with no challenge was registered against to prove a gate it does not have')
  })
})

test('identity.registration-challenge skips against an identity that predates the challenge route', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /auth/challenge', () => ({ status: 404, body: { error: { code: 'not_found' } } }))
    const result = await run(IDENTITY_CHALLENGE, estate)
    assert.equal(result.status, 'skip', String(result.error))
    assert.deepEqual(requestsTo(estate, 'POST /auth/register'), [])
  })
})

test('a registering journey presents a MINTED service token, and gets past the gate with it', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    await withCredential(async () => {
      const result = await run(IDENTITY_REGISTER, estate)
      assert.equal(result.status, 'pass', String(result.error))

      const exchanges = requestsTo(estate, 'POST /service-tokens/exchange')
      assert.equal(exchanges.length, 1, 'the token was not minted exactly once per registration')
      // No `scopes`, deliberately: identity reads an empty body as "the whole allowlist", and a
      // literal here would be read by `deploy/scripts/derive-grants.mjs` as an outbound scope
      // declaration and granted for ever. See `mintServiceToken`.
      assert.deepEqual(exchanges[0]?.body, {}, 'the exchange asked for a named scope')

      const posted = requestsTo(estate, 'POST /auth/register')
      assert.equal(posted[0]?.headers['authorization'], 'Bearer svc_1',
        'the registration did not carry the token the exchange minted')
    })
  })
})

test('the long-lived credential reaches the exchange AND NOTHING ELSE', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    await withCredential(async () => {
      const result = await run(IDENTITY_REGISTER, estate)
      assert.equal(result.status, 'pass', String(result.error))

      // The credential does not expire and is the only thing that mints tokens. Sent to any other
      // route it is a long-lived secret on a surface that did not need one — the exact failure the
      // 600-second minted token exists to avoid.
      const carrying = estate.requests
        .filter((r) => r.raw.includes(CREDENTIAL) || (r.headers['authorization'] ?? '').includes(CREDENTIAL))
        .map((r) => `${r.method} ${r.path}`)
      assert.deepEqual(carrying, ['POST /service-tokens/exchange'],
        'the long-lived credential was presented somewhere other than the exchange')
    })
  })
})

test('a registering journey SKIPS, rather than failing, when it holds no credential to be excused with', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    // No credential in the environment: `withCredential` is deliberately not used.
    const result = await run(IDENTITY_REGISTER, estate)
    // The gate refusing a caller who solved nothing is the gate WORKING. Reporting it as a failure
    // would open an incident against identity for doing what it was configured to do — and the
    // reason names the variable an operator sets to fix it.
    assert.equal(result.status, 'skip', String(result.error))
    assert.match(String(result.error), /BEACON_IDENTITY_CREDENTIAL/)
    assert.deepEqual(requestsTo(estate, 'POST /service-tokens/exchange'), [],
      'an exchange was attempted with no credential to exchange')
  })
})

test('a registering journey goes RED when a service principal is refused too', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    // The bypass itself is broken: a credential exists, a token was minted, and identity refused
    // it anyway. Nothing a retry fixes, and it must not read as "registration is challenged" —
    // that would be a skip, and a skip here would hide the estate's registration being shut.
    estate.route('POST /auth/register', () => ({
      status: 403,
      body: { error: { code: 'challenge_failed', message: 'that registration challenge was not accepted' } },
    }))
    await withCredential(async () => {
      const result = await run(IDENTITY_REGISTER, estate)
      assertFailedAt(result, 'register')
      assert.match(String(result.error), /SERVICE PRINCIPAL/)
    })
  })
})

test('a deployment with no challenge is registered against exactly as it was before', async () => {
  await withEstate(async (estate) => {
    const result = await run(IDENTITY_REGISTER, estate)
    assert.equal(result.status, 'pass', String(result.error))
    // No credential, no challenge: not one extra request, and not one extra header. The feature
    // being off has to leave this path byte-for-byte as it was.
    assert.deepEqual(requestsTo(estate, 'POST /service-tokens/exchange'), [])
    const posted = requestsTo(estate, 'POST /auth/register')
    assert.equal(posted.length, 1)
    assert.equal(posted[0]?.headers['authorization'], undefined)
  })
})

test('identity.registration-challenge goes red when the 403 is some OTHER refusal', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    // 403, and nothing to do with a challenge. If the journey accepted any 403 it would report the
    // gate proven while registration was in fact shut for a completely different reason — a green
    // that means "something said no", which is not what this journey claims to have found out.
    estate.route('POST /auth/register', () => ({
      status: 403,
      body: { error: { code: 'forbidden', message: 'registration is closed' } },
    }))
    const result = await run(IDENTITY_CHALLENGE, estate)
    assertFailedAt(result, 'a registration carrying no challenge token is refused')
  })
})

test('identity.registration-challenge goes red when /auth/challenge answers without `required`', async () => {
  await withEstate(async (estate) => {
    // The shape changed and the flag went missing. Read as "not required" this journey would skip
    // for ever, which is the worst outcome available: the gate stops being measured and the board
    // says so in a colour nobody reads.
    estate.route('GET /auth/challenge', () => ({
      status: 200,
      body: { provider: 'turnstile', siteKey: SITE_KEY, action: 'signup' },
    }))
    const result = await run(IDENTITY_CHALLENGE, estate)
    assertFailedAt(result, 'identity publishes whether registration is challenged')
  })
})

test('a Turnstile OUTAGE fails the registering journey, and is never mistaken for a refusal', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    // identity fails closed when it cannot reach `siteverify` (503 `challenge_unavailable`), which
    // means NOBODY can register — a real, total outage of the estate's front door. It arrives on
    // the same route, in the same envelope, as the 403 a bot gets, and the temptation is to file it
    // with the other challenge codes and skip. That would be the outage's perfect hiding place: a
    // skip is not a page. Only the two 403 codes are refusals; this one is left to the caller's own
    // status assertion and goes red.
    estate.route('POST /auth/register', () => ({
      status: 503,
      body: { error: { code: 'challenge_unavailable', message: 'the challenge provider could not be reached' } },
    }))
    await withCredential(async () => {
      const result = await run(IDENTITY_REGISTER, estate)
      assertFailedAt(result, 'register')
      assert.doesNotMatch(String(result.error), /SERVICE PRINCIPAL/,
        'an outage was reported as the service bypass being broken')
    })
  })
})

test('identity.registration-challenge goes red when registration is refused by something that is not the gate', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    // A 500. The journey's claim is precise — "the gate refused a caller who solved nothing" — and
    // any-4xx-or-worse would let a broken route stand in for the gate and report it proven. Half of
    // this estate's registration failures have been 500s from a wedged upstream, so this is not a
    // hypothetical status to be tolerant about.
    estate.route('POST /auth/register', () => ({
      status: 500,
      body: { error: { code: 'internal_error', message: 'no' } },
    }))
    const result = await run(IDENTITY_CHALLENGE, estate)
    assertFailedAt(result, 'a registration carrying no challenge token is refused')
    // AND IT SAYS THE STATUS WAS WRONG. Red is not enough here, because a tolerant status check
    // (`>= 400`) still goes red — on the CODE — and hands the reader "expected the refusal code
    // challenge_required, got internal_error", which reads as a bug in identity's challenge and
    // sends whoever is on call into the wrong file. The route is simply down.
    assert.match(String(result.error), /not 403/,
      'a 500 was reported as a challenge-code mismatch rather than as the wrong status')
  })
})

test('the RETRY after a rate limit carries the bearer too', async () => {
  await withEstate(async (estate) => {
    challenged(estate)
    await withCredential(async () => {
      // The first attempt is refused with identity's own `retry-after`; the second must be the
      // same request. It was not, before micro-org#361: the retry was a second literal `call` with
      // its own body and no token, so the bypass would have applied to the first attempt only and
      // every rate-limited cycle would have reported registration broken.
      const gated = registerHandlerOf(estate)
      let attempts = 0
      estate.route('POST /auth/register', (req) => {
        attempts += 1
        if (attempts === 1) {
          return { status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 'too_many_requests' } } }
        }
        return gated(req)
      })

      const result = await run(IDENTITY_REGISTER, estate)
      assert.equal(result.status, 'pass', String(result.error))
      const posted = requestsTo(estate, 'POST /auth/register')
      assert.equal(posted.length, 2)
      assert.equal(posted[1]?.headers['authorization'], 'Bearer svc_1',
        'the retry was sent without the service bearer the first attempt carried')
    })
  })
})
