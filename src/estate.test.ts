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
  IDENTITY_HANDOFF,
  IDENTITY_REGISTER,
  IDENTITY_SIGNIN,
  MARKET_CATALOGUE,
  WORLDS_REGISTRY,
} from './estate.ts'
import { runJourney, type JourneyDefinition, type JourneyRun } from './journeys.ts'
import { fakeEstate, type FakeEstate } from './testsupport.ts'

const SERVICES = ['identity', 'market', 'worlds', 'ledger', 'hub-api', 'activity']

/** The origin `IDENTITY_HANDOFF_ORIGINS` would name. Set per test, never left set. */
const ORIGIN = 'https://hub.cloudsforge.test'

interface Account {
  readonly id: string
  readonly email: string
  readonly handle: string
  readonly password: string
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

  estate.route('POST /auth/register', (req) => {
    const email = String(req.body['email'] ?? '')
    const handle = String(req.body['handle'] ?? '')
    const password = String(req.body['password'] ?? '')
    if (!email || !handle || !password) return { status: 400, body: { error: { code: 'bad_request' } } }
    if (accounts.has(email)) return { status: 409, body: { error: { code: 'conflict' } } }
    const account: Account = { id: `019fc4ba-0b1e-7000-8fd4-${String(next).padStart(12, '0')}`, email, handle, password }
    accounts.set(email, account)
    return { status: 201, body: { accessToken: issue(account), refreshToken: 'r', expiresIn: 900, user: { id: account.id, email, handle, status: 'active', roles: ['player'] } } }
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
    return { status: 200, body: { accessToken: issue(account), refreshToken: 'r', expiresIn: 900, user: { id: account.id, handle: account.handle } } }
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
    return { status: 200, body: { accessToken: issue(entry.account), refreshToken: 'r', expiresIn: 900, user: { id: entry.account.id, handle: entry.account.handle } } }
  })

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
  try {
    await body(estate)
  } finally {
    await estate.close()
  }
}

/* ------------------------------------------------------------------ identity.register */

test('identity.register passes against a healthy estate', async () => {
  await withEstate(async (estate) => {
    const result = await run(IDENTITY_REGISTER, estate)
    assert.equal(result.status, 'pass', String(result.error))
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
    estate.route('POST /auth/register', () => ({ status: 429, body: { error: { code: 'too_many_requests' } } }))
    const result = await run(IDENTITY_REGISTER, estate)
    // The estate protecting itself is not the estate being broken, and a skip is not green
    // either — the gate refuses on it.
    assert.equal(result.status, 'skip')
  })
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
        body: { accessToken: `replayable_${issued++}`, user: { id: 'u' } },
      }))
      // Answers for whoever registered last, so the journey's "the redeemed session is a real
      // session" step is satisfied and the run reaches the replay assertion. Breaking one property
      // at a time is the whole discipline: an estate broken in two ways proves only the first.
      estate.route('GET /auth/me', () => {
        const registered = [...estate.requests].reverse().find((r) => r.path === '/auth/register')
        return { status: 200, body: { user: { id: 'u', handle: String(registered?.body['handle']) } } }
      })
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
