/**
 * The ecosystem journeys, driven against a fake estate — and every assertion proved to go red.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A CROSS-SERVICE JOURNEY IS THE EASIEST KIND TO FAKE, SO IT IS THE KIND THAT MOST NEEDS THIS.**
 *
 * "A fact reaches the read model" is one poll and one `assert(found)` away from a check that
 * passes whenever the feed returns anything at all, for anyone. "The two portfolio paths agree" is
 * two `undefined`s comparing equal. "The trial balance is zero" is true of a ledger that has never
 * recorded an entry. Each of those is a check that cannot fail, and each is what this file exists
 * to rule out: for every property a journey claims, the estate below is broken in exactly that one
 * way and the journey is required to report `fail`.
 *
 * The fake's answers were read off the running dev estate on 2026-08-03 — the tile shape, the
 * `status`/`reason`/`cached`/`ageMs` envelope, the record fields, `totalUsdScaled` as a string.
 * A fake that answers something no real service would answer proves the journey handles a case
 * that cannot happen.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ECOSYSTEM_DEPOSIT_ADDRESS,
  ECOSYSTEM_EVENT_BUS,
  ECOSYSTEM_ONE_ACCOUNT,
  ECOSYSTEM_ONE_ACTIVITY,
  ECOSYSTEM_ONE_PORTFOLIO,
  ECOSYSTEM_TRIAL_BALANCE,
  ecosystemJourneys,
} from './ecosystem.ts'
import { runJourney, type JourneyDefinition, type JourneyRun } from './journeys.ts'
import { fakeEstate, type FakeEstate, type FakeReply, type FakeRequest } from './testsupport.ts'
import { forgetSessions, REQUIRED_POOL_SIZE } from './pool.ts'

/** The provisioned pool, as `BEACON_JOURNEY_ACCOUNTS` would supply it. See `estate.test.ts`. */
const POOL = Array.from({ length: REQUIRED_POOL_SIZE }, (_, index) => ({
  email: `pool${index}@beacon.test`,
  password: `Pool-pass-${index}`,
}))

const SERVICES = ['identity', 'activity', 'hub-api', 'ledger', 'wallet', 'custody']

interface Record_ {
  id: string
  userId: string
  sourceEventId: string
  sourceTopic: string
  product: string
  type: string
  summary: string
}

interface Estate extends FakeEstate {
  /** Every record the fake bus has delivered, newest last. */
  readonly feed: Record_[]
  /** The portfolio payload both hub paths serve. One object, so agreement is the default. */
  portfolio: Record<string, unknown>
  /** Set to break the pass-through independently of the source. */
  hubPortfolio: Record<string, unknown> | null
  /** Every deposit assignment the fake wallet has minted, by `${userId}:${assetCode}`. */
  readonly assignments: Map<string, Record<string, unknown>>
  /** Every key the fake custody holds, by address. */
  readonly custodyKeys: Map<string, Record<string, unknown>>
  /**
   * Override custody's answer for `GET /v1/addresses/:address`.
   *
   * A knob rather than `estate.route(...)`, because the address is minted DURING the journey and
   * a test cannot name the path in advance. `authorised` is false when the request carried no
   * bearer token, so the refusal half can be broken independently of the read half.
   */
  custodyRead: ((address: string, authorised: boolean) => FakeReply) | null
}

/**
 * The assets that settle on a chain, and the chain each settles on.
 *
 * Read out of `CHAIN_FOR_ASSET` in `wallet/src/addresses.ts`, not invented: a fake that called
 * SHARD depositable would prove the journey handles a case the estate cannot produce, and a fake
 * that called EMBER undepositable would make the happy path untestable for the wrong reason.
 */
const DEPOSITABLE: ReadonlyMap<string, string> = new Map([
  ['EMBER', 'ember'],
  ['ETH', 'eth'],
  ['BTC', 'btc'],
  ['SOL', 'sol'],
  ['XRP', 'xrp'],
])

/**
 * An estate whose bus works.
 *
 * Registration appends exactly one record for the new account, attributed to identity and carrying
 * a source event id — which is what the real estate does, through an outbox row, a signed delivery
 * and an inbox insert. The fake models the OUTCOME rather than the mechanism on purpose: a journey
 * that asserted the mechanism would be asserting identity's and activity's own tests.
 */
async function healthyEstate(): Promise<Estate> {
  const base = await fakeEstate(SERVICES)
  const feed: Record_[] = []
  const byToken = new Map<string, { id: string; handle: string; email: string }>()
  let next = 0

  const portfolio: Record<string, unknown> = {
    totalUsdScaled: '0',
    totalUsd: '0',
    pricedAt: null,
    pricingComplete: true,
    holdings: [],
    allocation: [],
    shards: '0',
    ember: '0',
  }

  const assignments = new Map<string, Record<string, unknown>>()
  const custodyKeys = new Map<string, Record<string, unknown>>()

  const estate: Estate = Object.assign(base, {
    feed,
    portfolio,
    hubPortfolio: null,
    assignments,
    custodyKeys,
    custodyRead: null as Estate['custodyRead'],
  })

  const bearer = (req: FakeRequest): { id: string; handle: string; email: string } | null => {
    const header = req.headers['authorization'] ?? ''
    return header.startsWith('Bearer ') ? (byToken.get(header.slice(7)) ?? null) : null
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **A SIGN-IN IS WHAT COMMITS A FACT HERE NOW, AND REGISTRATION COMMITS NOTHING A JOURNEY CAN USE.**
   *
   * This fake answered `201` with a session and pushed a feed record, so five ecosystem journeys
   * passed against a shape identity has not served since it grew email verification — measured on
   * mainnet 2026-08-11, where all five were failing on every cycle while this suite was green
   * (micro-org#371). Registration answers 202 with no session and the account it creates cannot
   * sign in, so it is modelled that way and nothing below uses it.
   *
   * The feed record moves to `POST /auth/login`, which is honest about the estate rather than
   * convenient: `identity.session.created` is published in the same transaction as the session row
   * (identity's `sessions.ts`), activity classifies it, and it is the fact `ecosystem.event-bus`
   * now waits for. A NEW record per sign-in, because that journey asserts the record did not exist
   * before it acted — the assertion that stops a reused account turning the bus check into a check
   * that cannot fail.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  base.route('POST /auth/register', (req) => {
    const email = String(req.body['email'] ?? '')
    const handle = String(req.body['handle'] ?? '')
    if (!email || !handle) return { status: 400, body: { error: { code: 'bad_request' } } }
    return {
      status: 202,
      body: { verificationRequired: true, email: email.toLowerCase(), status: 'Check your email for a verification link.' },
    }
  })

  base.route('POST /auth/login', (req) => {
    const identifier = String(req.body['identifier'] ?? '')
    const member = POOL.find((entry) => entry.email === identifier)
    if (!member || member.password !== String(req.body['password'] ?? '')) {
      return { status: 401, body: { error: { code: 'unauthenticated' } } }
    }
    const id = `019fc4ba-0b1e-7000-9000-${String(POOL.indexOf(member)).padStart(12, '0')}`
    const handle = `pool${POOL.indexOf(member)}`
    const token = `tok_${next++}`
    byToken.set(token, { id, handle, email: member.email })
    feed.push({
      id: `rec_${next}`,
      userId: id,
      sourceEventId: `evt_${next}`,
      sourceTopic: 'identity.session.created',
      product: 'identity',
      type: 'security.session_created',
      summary: 'Signed in.',
    })
    return {
      status: 200,
      body: { accessToken: token, refreshToken: 'r', expiresIn: 900, user: { id, handle, email: member.email } },
    }
  })

  base.route('GET /auth/me', (req) => {
    const account = bearer(req)
    if (!account) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    return { status: 200, body: { user: { id: account.id, handle: account.handle, email: account.email }, session: { id: 's' } } }
  })

  const page = (req: FakeRequest): { records: Record_[]; nextCursor: string | null } => {
    const account = bearer(req)
    const limit = Number(req.query.get('limit') ?? '20')
    const mine = feed.filter((record) => record.userId === account?.id)
    const slice = mine.slice(0, limit)
    return { records: slice, nextCursor: slice.length < mine.length ? `cur_${slice.length}` : null }
  }

  base.route('GET /feed', (req) => {
    if (!bearer(req)) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    return { status: 200, body: page(req) }
  })

  base.route('GET /v1/dashboard', (req) => {
    const account = bearer(req)
    if (!account) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    return {
      status: 200,
      body: {
        userId: account.id,
        generatedAt: new Date().toISOString(),
        tiles: { portfolio: { status: 'ok', upstream: 'ledger', reason: null, cached: false, ageMs: null, data: estate.portfolio } },
      },
    }
  })

  base.route('GET /v1/portfolio', (req) => {
    if (!bearer(req)) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    return {
      status: 200,
      body: { portfolio: { status: 'ok', upstream: 'ledger', reason: null, cached: true, ageMs: 32, data: estate.hubPortfolio ?? estate.portfolio } },
    }
  })

  base.route('GET /v1/activity', (req) => {
    if (!bearer(req)) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    const answer = page(req)
    return { status: 200, body: { ...answer, status: 'ok', reason: null, cached: false, ageMs: null } }
  })

  base.route('POST /service-tokens/exchange', (req) => {
    const header = req.headers['authorization'] ?? ''
    if (!header.startsWith('Bearer cfsc_')) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    return { status: 201, body: { token: 'svc_tok', jti: 'j', service: 'beacon', scopes: ['ledger:read'], expiresIn: 600 } }
  })

  /* -------------------------------------------------- wallet and custody, as they really answer
   *
   * Every shape below was read off the running dev estate on 2026-08-04, through the gateway, with
   * a user's own token — `POST pay.<apex>/v1/deposits {"assetCode":"EMBER"}` → 201
   * `{assignment:{id,userId,assetCode,chain,network,walletId,address,custodyKeyUrn,status,
   * assignedAt,rotatedAt,supersedesId,watchedAt}}`, and `GET vault.<apex>/v1/addresses/:address`
   * → 200 `{key:{address,chain,family,purpose,network,scheme,derivationPath,status,keyVersion,
   * createdAt,exportedAt}}`. Custody's own route publishes neither `userId` nor `orderId`
   * (`custody/src/server.ts`, the comment above `GET /v1/addresses/:address`), so the fake does
   * not either — a fake that served them would let a journey assert something it cannot see.
   */

  const mint = (userId: string, assetCode: string, chain: string): Record<string, unknown> => {
    const n = next++
    const address = `0x${n.toString(16).padStart(40, 'a')}`
    const assignmentId = `019fcc6f-2da8-7000-8ee0-${String(n).padStart(12, '0')}`
    custodyKeys.set(address, {
      address,
      chain,
      family: 'evm',
      purpose: 'deposit',
      network: 'testnet',
      scheme: 'hd_bip44',
      derivationPath: "m/44'/1'/0'/0/0",
      status: 'active',
      keyVersion: 1,
      createdAt: new Date().toISOString(),
      exportedAt: null,
    })
    // Custody's real read route is `GET /v1/addresses/:address` and the fake router matches exact
    // paths, so the route is installed as the address is minted. The journey learns the address
    // from wallet's reply, exactly as a client does.
    base.route(`GET /v1/addresses/${address}`, (req) => {
      const authorised = (req.headers['authorization'] ?? '').startsWith('Bearer ')
      if (estate.custodyRead) return estate.custodyRead(address, authorised)
      // Custody answers 404 rather than 401/403 to a caller who does not own the key — "a 403
      // confirms the address exists". An unauthenticated caller never gets that far.
      if (!authorised) return { status: 401, body: { error: { code: 'unauthenticated' } } }
      const key = custodyKeys.get(address)
      if (!key) return { status: 404, body: { error: { code: 'not_found' } } }
      return { status: 200, body: { key } }
    })
    return {
      id: assignmentId,
      userId,
      assetCode,
      chain,
      network: 'testnet',
      walletId: `019fcc6f-2f49-7000-97d2-${String(n).padStart(12, '0')}`,
      address,
      custodyKeyUrn: `cf:custody:key:${chain}:testnet:${address}`,
      status: 'active',
      assignedAt: new Date().toISOString(),
      rotatedAt: null,
      supersedesId: null,
      watchedAt: new Date().toISOString(),
    }
  }

  base.route('POST /v1/deposits', (req) => {
    const account = bearer(req)
    if (!account) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    const assetCode = String(req.body['assetCode'] ?? '').toUpperCase()
    const chain = DEPOSITABLE.get(assetCode)
    if (!chain) {
      return {
        status: 400,
        body: {
          error: {
            code: 'not_depositable',
            message: `${assetCode} does not settle on a chain and has no deposit address`,
          },
        },
      }
    }
    // Find-or-create, which is `assignDepositAddress`'s own shape and — because custody honours no
    // idempotency key — the ONLY thing that stops a retry minting a second address.
    const key = `${account.id}:${assetCode}`
    const existing = assignments.get(key)
    if (existing) return { status: 201, body: { assignment: existing } }
    const assignment = mint(account.id, assetCode, chain)
    assignments.set(key, assignment)
    return { status: 201, body: { assignment } }
  })

  base.route('GET /v1/deposits', (req) => {
    const account = bearer(req)
    if (!account) return { status: 401, body: { error: { code: 'unauthenticated' } } }
    return {
      status: 200,
      body: {
        assignments: [...assignments.values()].filter((a) => a['userId'] === account.id),
      },
    }
  })

  base.route('GET /trial-balance', (req) => {
    if (!(req.headers['authorization'] ?? '').startsWith('Bearer ')) {
      return { status: 401, body: { error: { code: 'unauthenticated' } } }
    }
    return {
      status: 200,
      body: { assets: [{ assetCode: 'SHARD', debits: '10', credits: '10', delta: '0' }], balanced: true, totalAbsoluteDelta: '0', entryCount: 4, postingCount: 8 },
    }
  })

  return estate
}

async function run(definition: JourneyDefinition, estate: FakeEstate): Promise<JourneyRun> {
  return runJourney(definition, { targets: estate.targets, deadlineMs: 30_000 })
}

function assertFailedAt(result: JourneyRun, step: string): void {
  assert.equal(result.status, 'fail', `expected a product failure, got ${result.status}: ${String(result.error)}`)
  assert.equal(result.failedStep, step, `failed at "${String(result.failedStep)}" — ${String(result.error)}`)
}

async function withEstate(body: (estate: Estate) => Promise<void>): Promise<void> {
  const estate = await healthyEstate()
  // Set per test and never left set, and the cache cleared at BOTH ends: `poolSession` keys its
  // tokens on slot, so a token minted against the previous test's fake — a different port, an
  // unknown bearer there — would otherwise be handed to the next one and read as an authorisation
  // failure in whichever service the journey dialled first.
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

/* ------------------------------------------------------------------ ecosystem.event-bus */

test('ecosystem.event-bus passes when a fact crosses from identity to activity', async () => {
  await withEstate(async (estate) => {
    const result = await run(ECOSYSTEM_EVENT_BUS, estate)
    assert.equal(result.status, 'pass', String(result.error))
  })
})

test('ecosystem.event-bus goes red when the record arrives without a source event id', async () => {
  await withEstate(async (estate) => {
    // AD-11: activity is written ONLY from the event bus. A record with no source event came from
    // somewhere else, and "somewhere else" is a write path that can produce a feed entry for a
    // transaction that rolled back.
    const original = estate.feed.push
    estate.route('GET /feed', (req) => {
      const account = req.headers['authorization']?.slice(7) ?? ''
      void account
      void original
      return { status: 200, body: { records: estate.feed.map((r) => ({ ...r, sourceEventId: null })), nextCursor: null } }
    })
    assertFailedAt(await run(ECOSYSTEM_EVENT_BUS, estate), 'it arrived through the bus, not by a direct write')
  })
})

test('ecosystem.event-bus goes red when one event produced two records', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /feed', () => {
      const doubled = estate.feed.flatMap((record) => [record, { ...record, id: `${record.id}_dup` }])
      return { status: 200, body: { records: doubled, nextCursor: null } }
    })
    // The inbox dedupe on (topic, event_id) is what makes at-least-once delivery effectively-once.
    assertFailedAt(await run(ECOSYSTEM_EVENT_BUS, estate), 'the same event produced exactly one record')
  })
})

test('ecosystem.event-bus goes red when one account can read another account’s record', async () => {
  await withEstate(async (estate) => {
    // The worst failure a shared read model has, and one no per-service test sees: activity's own
    // suite proves its query is scoped; nothing proves the scope survives a second account.
    estate.route('GET /feed', () => ({ status: 200, body: { records: estate.feed, nextCursor: null } }))
    assertFailedAt(await run(ECOSYSTEM_EVENT_BUS, estate), 'the record is in that account’s feed and no other')
  })
})

test('ecosystem.event-bus goes red when nothing ever arrives', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /feed', () => ({ status: 200, body: { records: [], nextCursor: null } }))
    const result = await run(ECOSYSTEM_EVENT_BUS, estate)
    assertFailedAt(result, 'the fact reaches activity’s feed')
    // The message has to name the three places to look, because an empty feed says nothing about
    // which of the relay, the secret and the subscription row is at fault.
    assert.match(String(result.error), /relay|subscription|signing/i)
  })
})

test('THE MUTATION: ecosystem.event-bus goes red when the relay stops and the OLD records remain', async () => {
  await withEstate(async (estate) => {
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THE DEFECT THAT SWAPPING IN A REUSED ACCOUNT WOULD HAVE INTRODUCED, ASSERTED AGAINST.**
     *
     * This journey used to register a brand-new account, so "a record exists for this user id"
     * could only be true if the bus had just carried one. A pool account has been signing in for
     * weeks and its feed is already full — so the same assertion against a reused account is a
     * check that CANNOT FAIL: the first poll finds a record from days ago and reports the bus
     * healthy while the relay is stopped.
     *
     * Here the estate keeps serving every record it already had and simply stops adding new ones,
     * which is exactly what a stopped relay looks like from the outside. The journey must fail.
     *
     * **Kills the mutation "find(record => record.userId === subject.userId)"** — the obvious
     * reading, the one that was there before, and the one that would have made this journey green
     * for ever. It is the freshness half of the predicate that is load-bearing, and nothing else in
     * this file would notice its removal.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    const feed = estate.handlerFor('GET /feed')
    assert.ok(feed, 'the fake estate has no GET /feed handler')
    // Snapshot the feed as it stands, then serve that snapshot for ever. The account still has
    // history — it signs in, `/auth/me` works, every other route is healthy — and nothing new
    // arrives.
    let frozen: unknown = null
    estate.route('GET /feed', (req) => {
      const reply = feed(req)
      if (reply.status !== 200) return reply
      frozen ??= reply.body
      return { status: 200, body: frozen }
    })
    const result = await run(ECOSYSTEM_EVENT_BUS, estate)
    assertFailedAt(result, 'the fact reaches activity’s feed')
    assert.match(String(result.error), /no NEW record/)
  })
})

/* ------------------------------------------------------------------ ecosystem.one-activity */

test('ecosystem.one-activity passes when hub-api passes the feed through unchanged', async () => {
  await withEstate(async (estate) => {
    assert.equal((await run(ECOSYSTEM_ONE_ACTIVITY, estate)).status, 'pass')
  })
})

test('ecosystem.one-activity goes red when hub-api reshapes a record', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /v1/activity', () => ({
      status: 200,
      body: {
        // One renamed key. A field-by-field comparison of the fields somebody remembered would
        // pass this; deep equality is what catches a second read model forming.
        records: estate.feed.map(({ summary, ...rest }) => ({ ...rest, description: summary })),
        nextCursor: null,
        status: 'ok',
        reason: null,
      },
    }))
    assertFailedAt(await run(ECOSYSTEM_ONE_ACTIVITY, estate), 'read the same feed through hub-api')
  })
})

test('ecosystem.one-activity goes red when hub-api re-encodes the cursor', async () => {
  await withEstate(async (estate) => {
    // Two records for whoever registered last, so `limit=1` produces a cursor to compare at all.
    // With one record both cursors are null and the assertion would be two nulls agreeing — the
    // check that cannot fail, which is why the journey returns early in that case rather than
    // pretending to have checked something.
    const mineNow = (): readonly Record_[] => {
      const last = estate.feed[estate.feed.length - 1]
      return last ? [last, { ...last, id: 'rec_extra', sourceEventId: 'evt_extra' }] : []
    }
    estate.route('GET /feed', (req) => {
      const limit = Number(req.query.get('limit') ?? '20')
      const mine = mineNow()
      const slice = mine.slice(0, limit)
      return { status: 200, body: { records: slice, nextCursor: slice.length < mine.length ? 'opaque_cursor' : null } }
    })
    estate.route('GET /v1/activity', (req) => {
      const limit = Number(req.query.get('limit') ?? '20')
      const mine = mineNow()
      const slice = mine.slice(0, limit)
      return {
        status: 200,
        body: {
          records: slice,
          // Re-encoded. The cursor is activity's keyset position and hub-api does not parse it;
          // a second cursor format is one that has to be kept in step for ever.
          nextCursor: slice.length < mine.length ? Buffer.from('opaque_cursor').toString('base64') : null,
          status: 'ok',
          reason: null,
        },
      }
    })
    assertFailedAt(await run(ECOSYSTEM_ONE_ACTIVITY, estate), 'the cursor is passed back unparsed')
  })
})

test('ecosystem.one-activity goes red rather than silently comparing a degraded tile', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /v1/activity', () => ({
      status: 200,
      body: { records: [], nextCursor: null, status: 'unavailable', reason: 'activity did not answer' },
    }))
    const result = await run(ECOSYSTEM_ONE_ACTIVITY, estate)
    assertFailedAt(result, 'read the same feed through hub-api')
    // "Rendering that empty array is how an outage reads as a quiet week." The journey must say
    // it could not compare, not report the two feeds as disagreeing.
    assert.match(String(result.error), /could not reach activity/)
  })
})

/* ------------------------------------------------------------------ ecosystem.one-portfolio */

test('ecosystem.one-portfolio passes when both hub paths serve the same payload', async () => {
  await withEstate(async (estate) => {
    assert.equal((await run(ECOSYSTEM_ONE_PORTFOLIO, estate)).status, 'pass')
  })
})

test('ecosystem.one-portfolio goes red when the two paths disagree by one stale timestamp', async () => {
  await withEstate(async (estate) => {
    // The realistic failure: two caches, two TTLs, the same total, and a `pricedAt` an hour apart.
    // A journey comparing only the total would pass while the page told the reader their
    // valuation was current when it was not.
    estate.hubPortfolio = { ...estate.portfolio, pricedAt: '2026-08-02T22:00:00.000Z' }
    assertFailedAt(await run(ECOSYSTEM_ONE_PORTFOLIO, estate), 'read the portfolio on its own path')
  })
})

test('ecosystem.one-portfolio goes red when a total arrives as a JSON number', async () => {
  await withEstate(async (estate) => {
    estate.portfolio['totalUsdScaled'] = 0
    assertFailedAt(await run(ECOSYSTEM_ONE_PORTFOLIO, estate), 'read the portfolio on its own path')
  })
})

test('ecosystem.one-portfolio goes red rather than comparing two degraded tiles', async () => {
  await withEstate(async (estate) => {
    // Both unavailable, both empty, both equal. The check that cannot fail, made to fail.
    //
    // The healthy handler is WRAPPED rather than replaced, and only the tile is overwritten. A
    // replacement would have to state the subject's user id, and the journey signs in as a pool
    // account whose id this test does not know — pinning one made this test assert "the dashboard
    // is for somebody else", which is a different defect from the one it is named after and would
    // have passed for the wrong reason.
    const dashboard = estate.handlerFor('GET /v1/dashboard')
    assert.ok(dashboard, 'the fake estate has no GET /v1/dashboard handler')
    estate.route('GET /v1/dashboard', (req) => {
      const reply = dashboard(req)
      if (reply.status !== 200) return reply
      const body = reply.body as Record<string, unknown>
      return {
        status: 200,
        body: { ...body, tiles: { portfolio: { status: 'unavailable', reason: 'ledger did not answer', data: null } } },
      }
    })
    estate.route('GET /v1/portfolio', () => ({
      status: 200,
      body: { portfolio: { status: 'unavailable', reason: 'ledger did not answer', data: null } },
    }))
    const result = await run(ECOSYSTEM_ONE_PORTFOLIO, estate)
    assertFailedAt(result, 'read the portfolio tile from the dashboard')
    assert.match(String(result.error), /ledger is not answering/)
  })
})

/* ------------------------------------------------------------------ ecosystem.one-account */

test('ecosystem.one-account passes when three services resolve one token to one subject', async () => {
  await withEstate(async (estate) => {
    assert.equal((await run(ECOSYSTEM_ONE_ACCOUNT, estate)).status, 'pass')
  })
})

test('ecosystem.one-account goes red when hub resolves the token to somebody else', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /v1/dashboard', (req) => ({
      status: (req.headers['authorization'] ?? '').startsWith('Bearer ') ? 200 : 401,
      body: { userId: 'a-different-person', tiles: { portfolio: { status: 'ok', data: estate.portfolio } } },
    }))
    assertFailedAt(await run(ECOSYSTEM_ONE_ACCOUNT, estate), 'hub resolves the same subject from the same token')
  })
})

test('ecosystem.one-account goes red when hub-api stops requiring a token', async () => {
  await withEstate(async (estate) => {
    const previous = estate.requests.length
    void previous
    estate.route('GET /v1/dashboard', () => ({
      status: 200,
      body: { userId: '019fc4ba-0b1e-7000-8fd4-000000000000', tiles: { portfolio: { status: 'ok', data: estate.portfolio } } },
    }))
    const result = await run(ECOSYSTEM_ONE_ACCOUNT, estate)
    assert.equal(result.status, 'fail')
    // It fails at the subject comparison first, which is correct — but the anonymous check must
    // also be able to fire on its own, so it is proved separately below.
    assert.ok(result.failedStep !== null)
  })
})

test('ecosystem.one-account goes red when activity serves its feed without a token', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /feed', (req) => {
      const header = req.headers['authorization'] ?? ''
      if (!header.startsWith('Bearer ')) return { status: 200, body: { records: [], nextCursor: null } }
      const id = estate.feed[estate.feed.length - 1]?.userId
      return { status: 200, body: { records: estate.feed.filter((r) => r.userId === id), nextCursor: null } }
    })
    assertFailedAt(await run(ECOSYSTEM_ONE_ACCOUNT, estate), 'an unauthenticated read of each is refused')
  })
})

/* ------------------------------------------------------------------ ecosystem.trial-balance */

test('ecosystem.trial-balance passes over a journal with entries in it', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_SERVICE_CREDENTIAL'] = 'cfsc_not_a_real_credential'
    try {
      assert.equal((await run(ECOSYSTEM_TRIAL_BALANCE, estate)).status, 'pass')
    } finally {
      delete process.env['BEACON_SERVICE_CREDENTIAL']
    }
  })
})

test('ecosystem.trial-balance SKIPS over an empty journal rather than reporting green', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_SERVICE_CREDENTIAL'] = 'cfsc_not_a_real_credential'
    try {
      // Zero minus zero is zero. A ledger that has never recorded an entry answers balanced:true,
      // and a monitor that stopped there would publish a green reconciliation signal for a service
      // that has never reconciled anything.
      estate.route('GET /trial-balance', () => ({
        status: 200,
        body: { assets: [], balanced: true, totalAbsoluteDelta: '0', entryCount: 0, postingCount: 0 },
      }))
      const result = await run(ECOSYSTEM_TRIAL_BALANCE, estate)
      assert.equal(result.status, 'skip')
      assert.notEqual(result.status, 'pass')
      assert.match(String(result.error), /empty/)
    } finally {
      delete process.env['BEACON_SERVICE_CREDENTIAL']
    }
  })
})

test('ecosystem.trial-balance goes red when the journal does not balance', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_SERVICE_CREDENTIAL'] = 'cfsc_not_a_real_credential'
    try {
      estate.route('GET /trial-balance', () => ({
        status: 200,
        body: { assets: [], balanced: false, totalAbsoluteDelta: '17', entryCount: 4, postingCount: 7 },
      }))
      assertFailedAt(await run(ECOSYSTEM_TRIAL_BALANCE, estate), 'the trial balance is zero and the journal is not empty')
    } finally {
      delete process.env['BEACON_SERVICE_CREDENTIAL']
    }
  })
})

test('ecosystem.trial-balance goes red when the response has lost the balanced field', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_SERVICE_CREDENTIAL'] = 'cfsc_not_a_real_credential'
    try {
      // `undefined !== false` is exactly how a missing field reads as healthy. The assertion is
      // `=== true` for this reason and nothing else.
      estate.route('GET /trial-balance', () => ({
        status: 200,
        body: { assets: [], totalAbsoluteDelta: '0', entryCount: 4, postingCount: 8 },
      }))
      assertFailedAt(await run(ECOSYSTEM_TRIAL_BALANCE, estate), 'the trial balance is zero and the journal is not empty')
    } finally {
      delete process.env['BEACON_SERVICE_CREDENTIAL']
    }
  })
})

test('ecosystem.trial-balance goes red when the ledger serves it unauthenticated', async () => {
  await withEstate(async (estate) => {
    process.env['BEACON_SERVICE_CREDENTIAL'] = 'cfsc_not_a_real_credential'
    try {
      estate.route('GET /trial-balance', () => ({
        status: 200,
        body: { assets: [], balanced: true, totalAbsoluteDelta: '0', entryCount: 4, postingCount: 8 },
      }))
      assertFailedAt(await run(ECOSYSTEM_TRIAL_BALANCE, estate), 'an unauthenticated read of the trial balance is refused')
    } finally {
      delete process.env['BEACON_SERVICE_CREDENTIAL']
    }
  })
})

/* ------------------------------------------------------------------ ecosystem.deposit-address */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FIRST TEST BELOW IS THE ONE THIS JOURNEY EXISTS FOR.**
 *
 * `POST /v1/deposits` answered 500 on the live estate for the whole life of the service, and
 * nothing anywhere reported it. The estate below is broken in exactly that way — wallet answers
 * 500 `{"error":{"code":"internal"}}` because custody refused its own call — and the journey is
 * required to report `fail` and to name the step. Every other test here breaks ONE other property
 * and demands the same, because "a deposit address is provisioned" is otherwise one `assert(201)`
 * away from a check that passes against a route that hands out the same address to everybody.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

test('ecosystem.deposit-address passes when an address is provisioned and custody holds it', async () => {
  await withEstate(async (estate) => {
    const result = await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate)
    assert.equal(result.status, 'pass', String(result.error))
    // The journey must have MOVED something: a pass over an estate where nothing was minted would
    // be the check that cannot fail, arrived at from the fake's side instead of the journey's.
    assert.equal(estate.assignments.size, 1)
    assert.equal(estate.custodyKeys.size, 1)
  })
})

test('THE ORIGINAL DEFECT: ecosystem.deposit-address goes red when POST /v1/deposits answers 500', async () => {
  await withEstate(async (estate) => {
    // Verbatim what the estate served until 2026-08-04, recorded in `conformance`'s micro-wallet
    // header: wallet threw `CustodyRefusedError` on `POST http://custody:4000/v1/addresses → 400`
    // because it sent no `orderId`, nothing caught it, and the generic handler served `internal`.
    estate.route('POST /v1/deposits', () => ({
      status: 500,
      body: { error: { code: 'internal', message: 'the request could not be completed' } },
    }))
    assertFailedAt(await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate), 'provision a deposit address')
  })
})

test('ecosystem.deposit-address goes red when wallet answers 201 with no address', async () => {
  await withEstate(async (estate) => {
    // A 201 carrying nothing to send money to is a funding page with an empty box on it, and a
    // journey that asserted only the status would call it green.
    const inner = estate.handlerFor('POST /v1/deposits')!
    estate.route('POST /v1/deposits', (req) => {
      const reply = inner(req)
      if (reply.status !== 201) return reply
      const body = reply.body as { assignment: Record<string, unknown> }
      return { status: 201, body: { assignment: { ...body.assignment, address: '' } } }
    })
    assertFailedAt(await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate), 'provision a deposit address')
  })
})

test('ecosystem.deposit-address goes red when the address belongs to a different account', async () => {
  await withEstate(async (estate) => {
    const inner = estate.handlerFor('POST /v1/deposits')!
    estate.route('POST /v1/deposits', (req) => {
      const reply = inner(req)
      if (reply.status !== 201) return reply
      const body = reply.body as { assignment: Record<string, unknown> }
      // One missing predicate in a find-or-create is how a funding page shows somebody else's
      // address, which is the worst outcome this route has.
      return { status: 201, body: { assignment: { ...body.assignment, userId: 'someone-else' } } }
    })
    assertFailedAt(await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate), 'provision a deposit address')
  })
})

test('ecosystem.deposit-address goes red when the URN names an address other than the one served', async () => {
  await withEstate(async (estate) => {
    const inner = estate.handlerFor('POST /v1/deposits')!
    estate.route('POST /v1/deposits', (req) => {
      const reply = inner(req)
      if (reply.status !== 201) return reply
      const body = reply.body as { assignment: Record<string, unknown> }
      return {
        status: 201,
        body: {
          assignment: {
            ...body.assignment,
            custodyKeyUrn: 'cf:custody:key:ember:testnet:0x0000000000000000000000000000000000000000',
          },
        },
      }
    })
    // The URN is the handle settlement and the export ceremony use to reach the key. One that
    // names a different address is a row that dereferences to somebody else's key.
    assertFailedAt(await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate), 'provision a deposit address')
  })
})

test('THE SEAM: ecosystem.deposit-address goes red when custody does not hold the address', async () => {
  await withEstate(async (estate) => {
    // Wallet inventing an address, or filing one custody never minted, is invisible from wallet's
    // own suite and from custody's — which is exactly why this journey is in this file. The whole
    // original defect lived in this seam.
    estate.custodyRead = () => ({ status: 404, body: { error: { code: 'not_found' } } })
    assertFailedAt(await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate), 'custody holds the key that address names')
  })
})

test('ecosystem.deposit-address goes red when custody holds the address for another purpose', async () => {
  await withEstate(async (estate) => {
    estate.custodyRead = (address) => ({
      status: 200,
      // `purpose` is one of the five fields custody compares before it signs. A deposit address
      // filed under `settlement` is a key the sweep will refuse for ever.
      body: { key: { ...estate.custodyKeys.get(address), purpose: 'settlement' } },
    })
    assertFailedAt(await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate), 'custody holds the key that address names')
  })
})

test('ecosystem.deposit-address goes red when custody serves a key unauthenticated', async () => {
  await withEstate(async (estate) => {
    estate.custodyRead = (address, authorised) => {
      void authorised
      return { status: 200, body: { key: estate.custodyKeys.get(address) } }
    }
    assertFailedAt(
      await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate),
      'an unauthenticated read of the key is refused',
    )
  })
})

test('ecosystem.deposit-address goes red when asking twice mints a second address', async () => {
  await withEstate(async (estate) => {
    // On the estate as deployed, wallet's find-or-create is the ONLY thing standing between a
    // retried provision and a second address nobody was told about: `custody_keys` there carries
    // no `idempotency_key` column, whatever `custody/src/keys.ts` now does with one. The estate
    // below therefore models the deployed shape, and the journey asserts the OUTCOME, so it keeps
    // its meaning when custody's second guard ships and when a third replaces both.
    //
    // The find-or-create is removed rather than the reply forged: the estate below still mints a
    // GENUINE second custody key on the second ask, which is what losing the check really does.
    // Forging a second address custody does not hold would fail at the previous step instead and
    // would prove nothing about this one.
    const inner = estate.handlerFor('POST /v1/deposits')!
    estate.route('POST /v1/deposits', (req) => {
      estate.assignments.clear()
      return inner(req)
    })
    assertFailedAt(
      await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate),
      'asking again returns the same address, not a second one',
    )
  })
})

test('ecosystem.deposit-address goes red when the assignment is not listed back', async () => {
  await withEstate(async (estate) => {
    // Provisioned and not readable is a user who cannot find the address they were just given.
    estate.route('GET /v1/deposits', () => ({ status: 200, body: { assignments: [] } }))
    assertFailedAt(await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate), 'the assignment is listed back')
  })
})

test('ecosystem.deposit-address goes red when an asset with no chain is given an address', async () => {
  await withEstate(async (estate) => {
    const inner = estate.handlerFor('POST /v1/deposits')!
    estate.route('POST /v1/deposits', (req) => {
      if (String(req.body['assetCode'] ?? '') !== 'EMBER') {
        // A Shard deposit address would be an address on no chain — money sent to a place that
        // cannot credit it. The refusal is the feature.
        return inner({ ...req, body: { assetCode: 'EMBER' } })
      }
      return inner(req)
    })
    assertFailedAt(
      await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate),
      'an asset that does not settle on a chain is refused',
    )
  })
})

test('ecosystem.deposit-address goes red when an anonymous caller can provision an address', async () => {
  await withEstate(async (estate) => {
    const inner = estate.handlerFor('POST /v1/deposits')!
    estate.route('POST /v1/deposits', (req) => {
      if (!(req.headers['authorization'] ?? '').startsWith('Bearer ')) {
        return { status: 201, body: { assignment: { id: 'x', address: '0x00' } } }
      }
      return inner(req)
    })
    assertFailedAt(
      await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate),
      'an unauthenticated provision is refused',
    )
  })
})

test('ecosystem.deposit-address SKIPS rather than fails when the estate runs no custody', async () => {
  await withEstate(async (estate) => {
    // A journey pointed at a service this deployment does not run has demonstrated nothing, which
    // is what skip means. It is never green — the metric emits 0.5 and the objective counts it
    // against the journey exactly as a failure would.
    const targets = new Map(estate.targets)
    targets.delete('custody')
    const result = await runJourney(ECOSYSTEM_DEPOSIT_ADDRESS, { targets, deadlineMs: 30_000 })
    assert.equal(result.status, 'skip', String(result.error))
    assert.match(String(result.error), /custody/)
  })
})

test('ecosystem.deposit-address mints ONE address per run, whatever else it asks for', async () => {
  await withEstate(async (estate) => {
    assert.equal((await run(ECOSYSTEM_DEPOSIT_ADDRESS, estate)).status, 'pass')
    // The accumulation budget, asserted rather than described. This journey runs every five
    // minutes for ever; one custody key per run is the number its header commits to, and the
    // second `POST /v1/deposits` it makes is precisely what proves that number is one and not two.
    assert.equal(estate.custodyKeys.size, 1)
  })
})

/* ------------------------------------------------------------------ the registry itself */

test('the trial-balance journey is ABSENT without a credential, not declared and skipping', () => {
  const without = ecosystemJourneys({}).map((j) => j.name)
  assert.ok(!without.includes('ecosystem.trial-balance'))
  const with_ = ecosystemJourneys({ BEACON_SERVICE_CREDENTIAL: 'cfsc_x' }).map((j) => j.name)
  assert.ok(with_.includes('ecosystem.trial-balance'))
  // The rule this repository holds: a declared-but-skipping journey refuses every release for
  // ever, and a gate that refuses everything is a gate that gets switched off within a week.
  assert.equal(with_.length, without.length + 1)
})

test('every ecosystem journey has a stable name and a public product group', () => {
  const names = ecosystemJourneys({ BEACON_SERVICE_CREDENTIAL: 'cfsc_x' }).map((j) => j.name)
  assert.deepEqual(new Set(names).size, names.length)
  for (const journey of ecosystemJourneys({ BEACON_SERVICE_CREDENTIAL: 'cfsc_x' })) {
    assert.match(journey.name, /^ecosystem\./)
    // Never a service name: the public projection publishes the group verbatim, and the service
    // this replaces leaked `pay.rates` onto a pre-auth page exactly this way.
    assert.match(journey.productGroup, /^[A-Z]/)
  }
})

/* ------------------------------------------------------------------ the ten-minute cliff */

test('an expired service token is an ERROR, not a failure — doc 22 §4.1', async () => {
  await withEstate(async (estate) => {
    // What the dev estate really answered eleven minutes after estate-bootstrap.sh ran, on the
    // first live run of this journey. The environment expired; the product did not, and an
    // incident opened against a working estate every eleventh minute is how a monitor gets muted.
    estate.route('GET /v1/activity', () => ({
      status: 200,
      body: { records: [], nextCursor: null, status: 'unavailable', reason: 'activity answered 401' },
    }))
    const result = await run(ECOSYSTEM_ONE_ACTIVITY, estate)
    assert.equal(result.status, 'error', `expected an error, got ${result.status}: ${String(result.error)}`)
    assert.match(String(result.error), /ten-minute cliff/)
    // Still blocks the gate. `error` routes the investigation elsewhere; it does not excuse it.
    assert.notEqual(result.status, 'pass')
  })
})

test('a degraded tile that is NOT an authorisation failure stays a product failure', async () => {
  await withEstate(async (estate) => {
    estate.route('GET /v1/activity', () => ({
      status: 200,
      body: { records: [], nextCursor: null, status: 'unavailable', reason: 'connect ECONNREFUSED' },
    }))
    const result = await run(ECOSYSTEM_ONE_ACTIVITY, estate)
    // The distinction has to cut both ways, or "environment expired" becomes the excuse for every
    // outage the estate has.
    assert.equal(result.status, 'fail', String(result.error))
  })
})
