/**
 * The bounded account pool.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHAT THESE TESTS ARE FOR, STATED AS THE DEFECT THEY WOULD HAVE CAUGHT.**
 *
 * Two, and they are different in kind:
 *
 *   1. **Rows.** Beacon registered an account per journey per cycle and left 15,210 of them in
 *      identity's `users` on mainnet, growing 2,231 a day (micro-org#390). The pool is what
 *      replaces that, and a pool that silently degraded — one account shared by eight journeys,
 *      or a short pool wrapping round — would fix the row count by reintroducing the flake the
 *      whole design was written to avoid.
 *   2. **Credentials.** This is the first thing in beacon that holds passwords. Every refusal in
 *      the parser is tested to say WHAT was wrong without saying what the value was, because an
 *      env parser that echoes what it could not read is how a credential reaches a boot log.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPIRY_MARGIN_MS,
  expiryMsOf,
  forgetSessions,
  parsePool,
  POOL_SLOTS,
  poolAccount,
  poolSession,
  PoolError,
  REQUIRED_POOL_SIZE,
} from './pool.ts'
import { JourneySkip } from './journeys.ts'
import { fakeEstate, type FakeEstate } from './testsupport.ts'
import type { JourneyContext } from './journeys.ts'

const ACCOUNTS = Array.from({ length: REQUIRED_POOL_SIZE }, (_, index) => ({
  email: `pool${index}@beacon.test`,
  password: `Pool-pass-${index}`,
}))

/** Only what `poolAccount` and `poolSession` reach for. `step` and `cleanup` are never called. */
function context(signal = new AbortController().signal): JourneyContext {
  return {
    runId: 'run',
    target: (name) => `http://${name}`,
    assert(condition, message) {
      if (!condition) throw new Error(message)
    },
    skip(reason): never {
      throw new JourneySkip(reason)
    },
    cleanup() {},
    step: async (_name, fn) => fn(),
    signal,
  }
}

/** The reason string from a skip, or a failure naming what happened instead. */
async function skipReason(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof JourneySkip) return err.message
    throw err
  }
  assert.fail('expected a skip, and nothing was thrown')
}

/**
 * `async` and `await body()`, which is not incidental: a synchronous `try { return body() }` runs
 * its `finally` the moment the promise is CREATED, so the variable was deleted before any awaited
 * assertion ran and every session test skipped for an unprovisioned pool while claiming to prove
 * the cache. Found by running them.
 */
async function withPool(raw: string | null, body: () => Promise<void> | void): Promise<void> {
  if (raw === null) delete process.env['BEACON_JOURNEY_ACCOUNTS']
  else process.env['BEACON_JOURNEY_ACCOUNTS'] = raw
  forgetSessions()
  try {
    await body()
  } finally {
    delete process.env['BEACON_JOURNEY_ACCOUNTS']
    forgetSessions()
  }
}

/* ------------------------------------------------------------------ the slot table */

test('EVERY SLOT IS A DIFFERENT ACCOUNT, and the pool is exactly as big as the slots', () => {
  /*
   * ────────────────────────────────────────────────────────────────────────────────────────────
   * The hazard `throwaway()`'s header names, made an assertion: two journeys sharing one account
   * move each other's balance and each other's session, and the flake that produces is
   * indistinguishable from the outage it gets reported as.
   *
   * **Kills the mutation "give two slots the same index".** That is a one-character edit to
   * `POOL_SLOTS`, it typechecks, every other test in this file still passes, and what it produces
   * is `ecosystem.event-bus`'s data-leak assertion — one account must not read another's record —
   * silently comparing an account with itself. A check that cannot fail, guarding the estate's
   * worst possible leak.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   */
  const indices = Object.values(POOL_SLOTS)
  assert.equal(new Set(indices).size, indices.length, 'two slots resolve to one account')
  // Contiguous from zero, so `REQUIRED_POOL_SIZE` is the size a deployment actually has to
  // provision. A gap would make the largest index exceed the count and the last slot would skip
  // against a pool that satisfied the documented number.
  assert.deepEqual([...indices].sort((a, b) => a - b), [...indices.keys()])
  assert.equal(REQUIRED_POOL_SIZE, indices.length)
})

test('event-bus holds two slots, because it compares two subjects', () => {
  // Named rather than left to the count above. This is the one journey whose correctness depends
  // on holding two DIFFERENT accounts at once, so it is the one whose pair is worth asserting by
  // name: a refactor that collapsed them would leave the count right and the journey wrong.
  assert.notEqual(POOL_SLOTS['ecosystem.event-bus/subject'], POOL_SLOTS['ecosystem.event-bus/bystander'])
})

/* ------------------------------------------------------------------ the parser */

test('parses a pool, and an absent variable is an empty pool rather than an error', () => {
  assert.equal(parsePool(JSON.stringify(ACCOUNTS)).length, REQUIRED_POOL_SIZE)
  // Unset, empty and whitespace all mean "this deployment has not provisioned one", which is the
  // state every developer machine and every CI run is in. It is answered with a skip at the point
  // of use, where the message can name the journey.
  assert.deepEqual(parsePool(''), [])
  assert.deepEqual(parsePool('   '), [])
})

test('A PASSWORD SURVIVES CHARACTERS A DELIMITED LIST WOULD HAVE EATEN', () => {
  /*
   * The reason this variable is JSON and `BEACON_TARGETS` is not. A URL cannot contain a comma; a
   * password is opaque bytes chosen by whoever provisioned the account and can contain anything.
   *
   * **Kills the mutation "parse it like BEACON_TARGETS", i.e. `split(',')` then `split(':')`.**
   * That reads this password as `p@ss`, signs in with the wrong credential, and the symptom is
   * eight journeys reporting that identity refuses a valid account — an incident against a working
   * service, which is the failure mode this whole file exists to avoid.
   */
  const awkward = 'p@ss,word:with=every{"delimiter"}'
  const parsed = parsePool(JSON.stringify([{ email: 'a@beacon.test', password: awkward }]))
  assert.equal(parsed[0]?.password, awkward)
})

test('refuses a malformed pool, and NEVER puts the value in the message', () => {
  const secret = 'Sup3r-secret-value'
  const cases: readonly [string, RegExp][] = [
    ['not json at all', /not valid JSON/],
    [JSON.stringify({ email: 'a@beacon.test', password: secret }), /must be a JSON ARRAY/],
    [JSON.stringify([null]), /entry 0 is not an object/],
    [JSON.stringify([{ password: secret }]), /entry 0 has no usable "email"/],
    [JSON.stringify([{ email: 'nope', password: secret }]), /entry 0 has no usable "email"/],
    [JSON.stringify([{ email: 'a@beacon.test' }]), /entry 0 has no usable "password"/],
    [JSON.stringify([{ email: 'a@beacon.test', password: '' }]), /entry 0 has no usable "password"/],
  ]
  for (const [raw, expected] of cases) {
    let thrown: unknown
    try {
      parsePool(raw)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof PoolError, `expected a PoolError for ${expected.source}`)
    assert.match((thrown as PoolError).message, expected)
    // THE ASSERTION THIS TEST IS REALLY FOR. Kills the mutation "include the offending entry in
    // the message so it can be debugged" — the helpful-looking edit that writes a live password
    // into a boot log, which the estate's own memory records as having happened twice.
    assert.ok(
      !(thrown as PoolError).message.includes(secret),
      `the refusal quoted the value: ${(thrown as PoolError).message}`,
    )
  }
})

test('refuses a pool that names one account twice', () => {
  // The shared-account hazard arriving through configuration instead of through code. Two slots
  // resolving to one account defeats `ecosystem.event-bus` exactly as a duplicated slot index
  // would, and no assertion downstream could tell the difference.
  assert.throws(
    () =>
      parsePool(
        JSON.stringify([
          { email: 'a@beacon.test', password: 'x' },
          { email: 'a@beacon.test', password: 'y' },
        ]),
      ),
    (err: unknown) => err instanceof PoolError && /names a@beacon.test twice/.test(err.message),
  )
})

/* ------------------------------------------------------------------ the skips */

test('SKIPS, naming the variable, when no pool is provisioned', async () => {
  await withPool(null, async () => {
    const reason = await skipReason(() => poolAccount(context(), 'identity.signin'))
    // Kills the mutation "throw instead of skip". A throw is classed `error` by `runJourney`,
    // which says BEACON is broken and sends the investigation to the wrong team; an unprovisioned
    // deployment has not demonstrated a broken product. And a refusal carries its reason: the
    // variable and the runbook are both named, because "no accounts" tells nobody what to do.
    assert.match(reason, /BEACON_JOURNEY_ACCOUNTS/)
    assert.match(reason, /provision-journey-accounts/)
  })
})

test('SKIPS rather than sharing an account out when the pool is too short', async () => {
  await withPool(JSON.stringify(ACCOUNTS.slice(0, 2)), async () => {
    // Slot 0 is inside a two-account pool and must still work — a short pool is not a broken pool
    // for the journeys it does cover.
    assert.equal(poolAccount(context(), 'identity.signin').email, ACCOUNTS[0]?.email)

    const reason = await skipReason(() => poolAccount(context(), 'ecosystem.deposit-address'))
    /*
     * **Kills the mutation `accounts[index % accounts.length]`.** Wrapping round is the obvious
     * "make it work with fewer accounts" edit: it typechecks, it removes every skip, and it hands
     * `ecosystem.event-bus` the same account for both of its slots — turning the assertion that
     * one account cannot read another's records into a comparison of an account with itself.
     */
    assert.match(reason, /holds 2 accounts/)
    assert.match(reason, /8 are needed/)
  })
})

test('a slot no table declares THROWS rather than skipping', async () => {
  await withPool(JSON.stringify(ACCOUNTS), () => {
    // Not a skip, deliberately. A skip would report an estate fact; this is beacon being wrong
    // about itself, and a journey silently declining to run because its slot name has a typo is
    // exactly the quiet monitor this repository keeps refusing to build.
    assert.throws(
      () => poolAccount(context(), 'ecosystem.no-such-journey'),
      (err: unknown) => err instanceof PoolError && /no pool slot is declared/.test(err.message),
    )
  })
})

/* ------------------------------------------------------------------ the session cache */

interface Identity {
  readonly estate: FakeEstate
  readonly url: string
  logins(): number
}

/** An identity that answers `/auth/login` and counts how many times it was asked. */
async function identityThatCountsLogins(reply?: (email: string) => { status: number; body: unknown }): Promise<Identity> {
  const estate = await fakeEstate(['identity'])
  let logins = 0
  estate.route('POST /auth/login', (req) => {
    logins++
    const email = String(req.body['identifier'] ?? '')
    if (reply) return reply(email)
    return {
      status: 200,
      body: { accessToken: `tok_${logins}`, refreshToken: 'r', expiresIn: 900, user: { id: `u_${email}` } },
    }
  })
  return { estate, url: estate.targets.get('identity') as string, logins: () => logins }
}

test('SIGNS IN ONCE AND REUSES THE TOKEN, because identity allows ten logins a minute', async () => {
  const identity = await identityThatCountsLogins()
  try {
    await withPool(JSON.stringify(ACCOUNTS), async () => {
      const first = await poolSession(context(), identity.url, 'identity.handoff')
      const second = await poolSession(context(), identity.url, 'identity.handoff')
      assert.equal(first.token, second.token)
      /*
       * **Kills the mutation "drop the cache and sign in every time".** It is invisible in every
       * other assertion here — the journeys would all still pass — and what it produces on the
       * estate is the self-inflicted 429 the registration-ceiling block in `calls.ts` describes at
       * length, moved one route across: eight slots signing in inside a twelve-second burst,
       * against identity's limit of ten per sixty seconds per source address, plus the two
       * `identity.signin` makes itself.
       */
      assert.equal(identity.logins(), 1)
    })
  } finally {
    await identity.estate.close()
  }
})

test('`fresh` signs in AGAIN, because a cache hit commits no fact for the bus to carry', async () => {
  const identity = await identityThatCountsLogins()
  try {
    await withPool(JSON.stringify(ACCOUNTS), async () => {
      await poolSession(context(), identity.url, 'ecosystem.event-bus/subject')
      await poolSession(context(), identity.url, 'ecosystem.event-bus/subject', { fresh: true })
      // Kills "ignore the option and always serve the cache", which would leave
      // `ecosystem.event-bus` waiting out its whole deadline for an `identity.session.created`
      // that nothing emitted — reporting a broken event bus on a healthy estate.
      assert.equal(identity.logins(), 2)
    })
  } finally {
    await identity.estate.close()
  }
})

test('two slots do not share a cached session', async () => {
  const identity = await identityThatCountsLogins()
  try {
    await withPool(JSON.stringify(ACCOUNTS), async () => {
      const subject = await poolSession(context(), identity.url, 'ecosystem.event-bus/subject')
      const bystander = await poolSession(context(), identity.url, 'ecosystem.event-bus/bystander')
      // Kills "key the cache on nothing", i.e. a single cached session for the whole process — the
      // simplest possible cache, and the one that hands the leak assertion two identical tokens.
      assert.notEqual(subject.token, bystander.token)
      assert.notEqual(subject.userId, bystander.userId)
    })
  } finally {
    await identity.estate.close()
  }
})

test('an UNVERIFIED pool account skips with the step that was missed, not with a status code', async () => {
  const identity = await identityThatCountsLogins(() => ({
    status: 403,
    body: { error: { code: 'email_unverified', message: 'confirm your email address before signing in' } },
  }))
  try {
    await withPool(JSON.stringify(ACCOUNTS), async () => {
      const reason = await skipReason(() => poolSession(context(), identity.url, 'identity.signin'))
      // The one mistake the provisioning procedure invites: the accounts get created and nobody
      // spends the verification link. Kills "let it fall through to the 200 assertion", whose
      // message is "expected 200 from /auth/login, got 403" — a sentence that sends the reader to
      // identity rather than to the runbook, for a mistake identity did not make.
      assert.match(reason, /never confirmed its address/)
      assert.match(reason, /provision-journey-accounts/)
    })
  } finally {
    await identity.estate.close()
  }
})

test('a rate-limited sign-in is a SKIP, because a limit working is not the estate broken', async () => {
  const identity = await identityThatCountsLogins(() => ({ status: 429, body: {} }))
  try {
    await withPool(JSON.stringify(ACCOUNTS), async () => {
      const reason = await skipReason(() => poolSession(context(), identity.url, 'identity.signin'))
      assert.match(reason, /rate limited/)
    })
  } finally {
    await identity.estate.close()
  }
})

/* ------------------------------------------------------------------ the expiry arithmetic */

test('an expiry identity did not quote is treated as already spent', () => {
  assert.equal(expiryMsOf({ expiresIn: 900 }), 900_000)
  /*
   * Every one of these is a response that lost, mangled or never carried `expiresIn`, and all of
   * them come back as one margin — which, after `poolSession` subtracts the margin, is zero, so the
   * next call signs in again.
   *
   * **Kills the mutation "default to fifteen minutes when it is missing".** That caches a token for
   * a lifetime identity never quoted, and the failure it produces is a 401 from whichever service
   * the journey dialled next — read by every assertion downstream as "hub-api refused a valid
   * session", i.e. the product broken, at a step that has nothing to do with it.
   */
  for (const body of [{}, { expiresIn: 0 }, { expiresIn: -1 }, { expiresIn: 'soon' }, { expiresIn: null }]) {
    assert.equal(expiryMsOf(body as Record<string, unknown>), EXPIRY_MARGIN_MS, JSON.stringify(body))
  }
})

test('the cache expires EARLY, never late', async () => {
  // A token good for exactly one margin is cached for zero milliseconds, so the second call signs
  // in again rather than handing a journey a token that dies inside its own 90s deadline.
  const identity = await identityThatCountsLogins((email) => ({
    status: 200,
    body: { accessToken: 'tok', expiresIn: EXPIRY_MARGIN_MS / 1_000, user: { id: `u_${email}` } },
  }))
  try {
    await withPool(JSON.stringify(ACCOUNTS), async () => {
      await poolSession(context(), identity.url, 'identity.handoff')
      await poolSession(context(), identity.url, 'identity.handoff')
      // Kills "add the margin instead of subtracting it" — a sign flip that typechecks, passes the
      // reuse test above, and hands out tokens up to a minute after they stop working.
      assert.equal(identity.logins(), 2)
    })
  } finally {
    await identity.estate.close()
  }
})
