/**
 * Ecosystem journeys — the seams between services, which no service can test.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHAT MAKES A JOURNEY BELONG HERE.**
 *
 * Every service in this estate has its own suite, and those suites are good: they run against a
 * real Postgres, they prove their own constraints fire, and they are the right place for every
 * rule the service owns. What none of them can do — what none of them is even able to express —
 * is assert something about **two services at once**.
 *
 * `micro-identity` can prove it writes an outbox row in the same transaction as the user.
 * `micro-activity` can prove it dedupes on `(topic, event_id)`. Neither can prove that a fact
 * committed in identity arrives in activity's read model, because doing so needs both processes,
 * the relay job between them, the shared signing secret, and a subscription row in a third place.
 * That composition is exactly where this estate's defects have been: a route the event bus exists
 * to call answering 401 to the event bus (`activity/src/server.ts`, the `POST /ingest` comment),
 * a producer sending `version: 1` where the contract wanted `"1.0"` (`ledger/src/outbox.ts`), a
 * gateway routing to an upstream nothing brings up. Every one of those passed both services' own
 * tests.
 *
 * So the rule for this file is: **if one service's test suite could assert it, it does not belong
 * here.** A journey here must need at least two processes to be wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The specification these are built against
 *
 * `docs/ecosystem/01-product-vision.md` §2 states eleven things that must be true for this to be
 * one platform rather than nine applications sharing a name, and
 * `docs/ecosystem/17-definition-of-done.md` §7 names, per statement, the demonstration that would
 * prove it. `claims.ts` in this repository is that table as data, mapping each of the eleven to
 * the journey that moves it — or to the named, cited reason no journey can. A journey added here
 * without a claim it moves fails `claims.test.ts`.
 *
 * ## Why only five are declared unconditionally
 *
 * The same rule `estate.ts` already holds itself to: **only journeys that actually exercise
 * something are declared.** Everything below either runs today against the dev estate — verified
 * by running it, not by reading a document — or is absent with its blocker named in `claims.ts`.
 * A declared-but-skipping journey refuses every release for ever and the gate gets switched off; a
 * declared-but-faked one reports green and makes the gate a lie.
 *
 * `ecosystem.trial-balance` is the one conditional case, and it is conditional on a **credential**
 * rather than on a missing feature: `ECOSYSTEM_JOURNEYS` includes it only when
 * `BEACON_SERVICE_CREDENTIAL` is set.
 *
 * That paragraph used to end "Beacon cannot hold one today — `IDENTITY_SERVICE_TOKEN_GRANTS` names
 * thirteen services and `beacon` is not among them". **It does now**, and the deploy step it was
 * waiting for has happened: the map in `deploy/compose/docker-compose.estate.yml` carries
 * `"beacon":["ledger:read"]` — derived, not hand-written, from the `scopes:` literal below — and
 * the beacon service block passes `BEACON_SERVICE_CREDENTIAL: ${BEACON_IDENTITY_CREDENTIAL:-}`.
 * Corrected 2026-08-10, while adding the service-token bypass for micro-org#361, which reads the
 * same credential through `serviceCredential()` in `calls.ts` and would have been designed around
 * a blocker that no longer exists.
 *
 * ## Every route below was read out of the service that serves it
 *
 *   POST /auth/register                 identity/src/server.ts
 *   GET  /auth/me                       identity/src/server.ts
 *   POST /service-tokens/exchange       identity/src/server.ts
 *   GET  /feed                          activity/src/server.ts
 *   GET  /v1/dashboard                  hub-api/src/server.ts
 *   GET  /v1/portfolio                  hub-api/src/server.ts
 *   GET  /v1/activity                   hub-api/src/server.ts
 *   GET  /trial-balance                 ledger/src/server.ts
 *   POST /v1/deposits                   wallet/src/server.ts
 *   GET  /v1/deposits                   wallet/src/server.ts
 *   GET  /v1/addresses/:address         custody/src/server.ts
 *
 * A method and a path rather than a line number, for the reason `estate.ts` sets out at length: a
 * line number is a claim about a file that any edit to an earlier part of that file silently
 * falsifies, asserted from a repository that cannot see the file at all.
 */

import {
  accessToken,
  call,
  field,
  pollFor,
  serviceCredential,
  stringField,
  type Json,
} from './calls.ts'
import { GROUPS } from './groups.ts'
import { poolSession } from './pool.ts'
import type { JourneyContext, JourneyDefinition } from './journeys.ts'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/* ------------------------------------------------------------------ shared shapes */

/** One activity record, as `activity/src/server.ts` puts it on the wire. */
interface FeedRecord {
  readonly id: string
  readonly userId: string | null
  readonly sourceEventId: string | null
  readonly sourceTopic: string | null
  readonly product: string | null
  readonly type: string
  readonly raw: Json
}

function toRecord(value: unknown): FeedRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Json
  const id = stringField(raw, 'id')
  const type = stringField(raw, 'type')
  if (id === null || type === null) return null
  return {
    id,
    userId: stringField(raw, 'userId'),
    sourceEventId: stringField(raw, 'sourceEventId'),
    sourceTopic: stringField(raw, 'sourceTopic'),
    product: stringField(raw, 'product'),
    type,
    raw,
  }
}

function records(body: Json): readonly FeedRecord[] {
  const list = field(body, 'records')
  if (!Array.isArray(list)) return []
  return list.map(toRecord).filter((record): record is FeedRecord => record !== null)
}

/**
 * The ten-minute cliff, classified.
 *
 * `deploy/README.md` records it: identity issues service tokens with a 600-second TTL
 * (`identity/src/tokens.ts`) and nothing re-mints one, so ten minutes after
 * `scripts/estate-bootstrap.sh` every service-to-service call in the estate starts answering 401.
 * It is not hypothetical — `ecosystem.one-activity` hit it on its first live run, eleven minutes
 * after the estate came up, and reported hub-api's activity tile as `unavailable (activity
 * answered 401)`.
 *
 * Doc 22 §4.1 already decided how to classify it and this is that decision in code: **a 401 from a
 * service token is an `error`, not a `fail`.** The environment expired; the product did not. A
 * `fail` would open an incident against a working estate every eleventh minute, and collapsing the
 * two would train everybody to ignore both.
 *
 * A plain `Error` is thrown rather than `ctx.assert`, because that is precisely what the harness
 * turns into `error` — see the three rules in `journeys.ts`.
 */
function refuseIfEnvironmentExpired(reason: string | null, where: string): void {
  if (reason === null) return
  if (!/\b40[13]\b|unauthori[sz]ed|forbidden/i.test(reason)) return
  throw new Error(
    `${where}: an upstream answered with an authorisation failure ("${reason}"). This is almost ` +
      `certainly the ten-minute cliff — identity issues service tokens with a 600-second TTL and ` +
      `nothing re-mints one, so re-run deploy/scripts/estate-bootstrap.sh. Reported as an ERROR ` +
      `rather than a failure on purpose: the environment expired, the product did not.`,
  )
}

/**
 * How long the bus is given to carry one fact.
 *
 * Measured, not guessed: against the dev estate on 2026-08-03 a registration reached activity's
 * feed in 610ms. Twelve attempts at 750ms is sixteen times that, which is generous enough that a
 * slow relay tick is not a failure and tight enough that a broken bus is reported inside one
 * journey deadline rather than by the deadline itself — a timeout says "slow", and the useful
 * message here is "it never arrived".
 */
const BUS = { attempts: 12, intervalMs: 750 } as const

/* ------------------------------------------------------------------ 1. the event bus */

/**
 * A fact committed in one service arrives in another's read model, through the real bus.
 *
 * **This is the journey that proves the estate is an estate.** Registration commits a user row and
 * an outbox row in one transaction (identity's `withOutbox`), a leased relay job signs the exact
 * bytes and POSTs them to `activity`'s `/ingest`, activity verifies the MAC over the raw body
 * before parsing it, inserts `(topic, event_id)` into its inbox, and only the insert that won runs
 * the handler. Six mechanisms in two processes, none of which either service's suite can put
 * together.
 *
 * The third step is the one that is easy to leave out and is worth as much as the first two: the
 * record must be in the right person's feed and **not** in anyone else's. A read model built from
 * a shared bus is one missing predicate away from being the estate's worst data leak, and a
 * journey that only ever reads its own feed cannot see it.
 */
export const ECOSYSTEM_EVENT_BUS: JourneyDefinition = {
  name: 'ecosystem.event-bus',
  title: 'A fact committed in one service reaches another service’s read model',
  productGroup: GROUPS.account,
  // `activity`, the CONSUMER. identity is dialled first, but only to commit the fact; what this
  // journey waits for is the fact arriving in activity's read model, so a red here is delivery
  // having stopped and activity is the end of that pipe.
  service: 'activity',
  // Not critical, deliberately, and this is a decision rather than an oversight. A critical
  // journey refuses every release from the moment it is declared, and this one has no history in
  // any deployment yet. It is promoted to critical when it has run on a schedule long enough for
  // its own flake rate to be a known number rather than an assumption. Until then it blocks a
  // release only by failing, which is the signal it is here to give.
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const activity = ctx.target('activity')

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THE FACT HAS TO BE COMMITTED *NOW*, AND SWAPPING IN A REUSED ACCOUNT NEARLY BROKE THAT.**
     *
     * This journey used to register an account and then look for a record carrying that account's
     * user id. Registration is no longer a thing beacon may do eight times a cycle (`pool.ts`), and
     * the obvious substitution — a pool account plus the same `userId` lookup — is a **check that
     * cannot fail**: a pool account has been signing in for weeks, its feed is already full, and
     * the very first poll would find a record from days ago and report the bus healthy while the
     * relay was stopped. That is the estate's recurring defect class, and it would have been
     * introduced by a change made to close a different one.
     *
     * So the fact is a SIGN-IN rather than a registration. `identity.session.created` is published
     * in the same transaction as the session row (identity's `sessions.ts`, through `withOutbox`)
     * and activity classifies it (`classify.ts`), so it exercises every mechanism the registration
     * did — outbox, leased relay, MAC over the raw body, inbox dedupe on `(topic, event_id)` — and
     * commits no permanent user row to do it.
     *
     * And freshness is asserted rather than assumed: the feed is read BEFORE the sign-in and the
     * ids are remembered, so what this waits for is a record that **did not exist a moment ago**.
     * A stopped relay now fails this journey within one deadline instead of passing it for ever.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    const before = await ctx.step('read the feed before the fact exists', async () => {
      // The cached session, deliberately: this read is positioning, not the fact. Forcing a fresh
      // sign-in here would commit the very event the next step is about to wait for, and this
      // journey would then be racing itself.
      const seed = await poolSession(ctx, identity, 'ecosystem.event-bus/subject')
      const result = await call(ctx, `${activity}/feed?limit=50`, { token: seed.token })
      ctx.assert(result.status === 200, `expected 200 from activity /feed, got ${result.status}`)
      return new Set(records(result.body).map((record) => record.id))
    })

    const subject = await ctx.step('commit a fact in identity', () =>
      // `fresh`, which is the whole step. A cached token would mean no new session row, no outbox
      // row and nothing for the bus to carry — and the poll below would then be waiting for an
      // event nothing had emitted, reporting a broken bus on a working estate.
      poolSession(ctx, identity, 'ecosystem.event-bus/subject', { fresh: true }),
    )

    const arrived = await ctx.step('the fact reaches activity’s feed', async () => {
      const found = await pollFor(ctx, BUS, async () => {
        const result = await call(ctx, `${activity}/feed?limit=50`, { token: subject.token })
        ctx.assert(result.status === 200, `expected 200 from activity /feed, got ${result.status}`)
        return (
          records(result.body).find(
            (record) => record.userId === subject.userId && !before.has(record.id),
          ) ?? null
        )
      })
      ctx.assert(
        found !== null,
        `a session was committed in identity and no NEW record for that account reached activity ` +
          `within ${(BUS.attempts * BUS.intervalMs) / 1000}s. The relay, the signing secret and ` +
          `the subscription rows in identity's event_subscriptions are the three places to look.`,
      )
      return found as FeedRecord
    })

    await ctx.step('it arrived through the bus, not by a direct write', async () => {
      // AD-11: activity is written ONLY from the event bus. A record with no source event id
      // came from somewhere else, and "somewhere else" is a write path that can produce a feed
      // entry for a transaction that rolled back.
      ctx.assert(
        arrived.sourceEventId !== null && arrived.sourceEventId.length > 0,
        `the record carries no sourceEventId, so nothing proves it came from an outbox row`,
      )
      ctx.assert(
        arrived.sourceTopic !== null && arrived.sourceTopic.startsWith('identity.'),
        `the record's sourceTopic is ${String(arrived.sourceTopic)}; the producer was identity`,
      )
      ctx.assert(
        arrived.product === 'identity',
        `the record is attributed to ${String(arrived.product)} rather than to identity`,
      )
    })

    await ctx.step('the same event produced exactly one record', async () => {
      const result = await call(ctx, `${activity}/feed?limit=50`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from activity /feed, got ${result.status}`)
      const matching = records(result.body).filter(
        (record) => record.sourceEventId === arrived.sourceEventId,
      )
      // AD-10, the effectively-once property. Delivery is at-least-once; the inbox insert on
      // `(topic, event_id)` is what makes a redelivery a no-op. Said plainly because this
      // assertion only bites when the producer actually retries, which beacon cannot force: it
      // proves the property holds now, and it is the assertion that goes red the first time a
      // retry meets a broken inbox.
      ctx.assert(
        matching.length === 1,
        `event ${String(arrived.sourceEventId)} produced ${matching.length} records; the inbox ` +
          `dedupe on (topic, event_id) is what makes at-least-once delivery effectively-once`,
      )
    })

    await ctx.step('the record is in that account’s feed and no other', async () => {
      // A SECOND, DIFFERENT account. The assertion below is that one account cannot read another's
      // record — the estate's worst possible data leak if it ever regresses — and it is worth
      // nothing if both tokens carry the same subject. `pool.ts` gives this journey two slots for
      // exactly this step, and refuses a pool that names one account twice.
      const other = await poolSession(ctx, identity, 'ecosystem.event-bus/bystander')
      const result = await call(ctx, `${activity}/feed?limit=50`, { token: other.token })
      ctx.assert(result.status === 200, `expected 200 from activity /feed, got ${result.status}`)
      const visible = records(result.body)
      ctx.assert(
        !visible.some((record) => record.id === arrived.id),
        `a second account can read record ${arrived.id}, which belongs to another user`,
      )
      // Asserted in both directions on purpose. "No record from the other account" is also true
      // of a feed that is broken and returns nothing at all, and a check that passes when the
      // feature is dead is not a check.
      ctx.assert(
        visible.every((record) => record.userId === other.userId),
        `the second account's feed contains a record belonging to somebody else`,
      )
    })
  },
}

/* ------------------------------------------------------------------ 2. one activity history */

/**
 * Two services agree about one read model, byte for byte.
 *
 * Hub's activity page does not read `activity`; it reads `hub-api`, which reads `activity` and
 * passes the page through. The pass-through is where a feed quietly becomes two feeds: a service
 * that re-shapes a record, re-encodes a cursor or drops a field it did not know about produces a
 * history that disagrees with the history, and the disagreement is invisible from either side.
 *
 * `hub-api/src/server.ts` states the intent — "the cursor is opaque and stays opaque … re-encoding
 * it would create a second cursor format that has to be kept in step with the first for ever".
 * This is that sentence as an assertion.
 */
export const ECOSYSTEM_ONE_ACTIVITY: JourneyDefinition = {
  name: 'ecosystem.one-activity',
  title: 'The activity history is one history, whichever service serves it',
  productGroup: GROUPS.account,
  // `hub-api`. The assertion is that hub's projection of the history agrees with activity's own,
  // and hub is the one that has to reproduce somebody else's answer.
  service: 'hub-api',
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const activity = ctx.target('activity')
    const hub = ctx.target('hub-api')

    const subject = await ctx.step('be an account with a session', () =>
      poolSession(ctx, identity, 'ecosystem.one-activity'),
    )

    const direct = await ctx.step('read the feed from activity', async () => {
      const found = await pollFor(ctx, BUS, async () => {
        const result = await call(ctx, `${activity}/feed?limit=20`, { token: subject.token })
        ctx.assert(result.status === 200, `expected 200 from activity /feed, got ${result.status}`)
        const page = records(result.body)
        return page.length > 0 ? { page, body: result.body } : null
      })
      ctx.assert(found !== null, 'no record ever reached activity for a freshly registered account')
      return found as { page: readonly FeedRecord[]; body: Json }
    })

    await ctx.step('read the same feed through hub-api', async () => {
      const result = await call(ctx, `${hub}/v1/activity?limit=20`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from hub-api /v1/activity, got ${result.status}`)

      // hub-api answers 200 with a degraded tile when activity is unreachable, which is correct
      // behaviour for a dashboard and useless as evidence here: comparing an empty degraded page
      // with a populated one would report a disagreement that is really an outage. Say which.
      const status = stringField(result.body, 'status')
      const reason = stringField(result.body, 'reason')
      if (status !== 'ok') refuseIfEnvironmentExpired(reason, 'hub-api’s activity tile')
      ctx.assert(
        status === 'ok',
        `hub-api served the activity tile as "${String(status)}" (${String(reason)}) — it could ` +
          `not reach activity, so the two feeds cannot be compared`,
      )

      const throughHub = records(result.body)
      ctx.assert(
        throughHub.length > 0,
        'hub-api reported the activity tile healthy and returned no records, while activity ' +
          'itself returned some — the pass-through dropped the page',
      )

      const first = direct.page[0] as FeedRecord
      const mirrored = throughHub.find((record) => record.id === first.id)
      ctx.assert(
        mirrored !== undefined,
        `record ${first.id} is in activity's feed and not in hub-api's`,
      )
      // Deep equality, not field-by-field. A pass-through that renames one key, rounds one
      // amount or drops a field added last week is a second read model, and the only assertion
      // that catches all three at once is "the bytes are the same".
      ctx.assert(
        JSON.stringify((mirrored as FeedRecord).raw) === JSON.stringify(first.raw),
        `hub-api reshaped record ${first.id}: ${JSON.stringify((mirrored as FeedRecord).raw).slice(0, 240)}`,
      )
    })

    await ctx.step('the cursor is passed back unparsed', async () => {
      // Read one record at a time so a cursor actually exists to compare. With a page big enough
      // to hold everything, both cursors are null and the assertion would be two nulls agreeing
      // — a check that cannot fail, which is the defect class this repository keeps finding.
      const fromActivity = await call(ctx, `${activity}/feed?limit=1`, { token: subject.token })
      ctx.assert(fromActivity.status === 200, `expected 200 from activity /feed, got ${fromActivity.status}`)
      const cursor = stringField(fromActivity.body, 'nextCursor')
      if (cursor === null) {
        // One record and no more pages is the normal state of a two-second-old account. Nothing
        // is asserted rather than something weak being asserted: the following steps' evidence
        // does not depend on this one, and a fabricated pass here would be worth less than the
        // gap it hides.
        return
      }
      const fromHub = await call(ctx, `${hub}/v1/activity?limit=1`, { token: subject.token })
      ctx.assert(fromHub.status === 200, `expected 200 from hub-api /v1/activity, got ${fromHub.status}`)
      ctx.assert(
        stringField(fromHub.body, 'nextCursor') === cursor,
        `hub-api re-encoded activity's cursor: activity said "${cursor}", hub-api said ` +
          `"${String(stringField(fromHub.body, 'nextCursor'))}"`,
      )
    })
  },
}

/* ------------------------------------------------------------------ 3. one portfolio */

/**
 * One portfolio total, however you ask for it.
 *
 * Vision test 4 is "a single number that is the truth about what you hold", and hub-api serves
 * that number down two different paths: `/v1/dashboard` composes it as one tile of eleven, and
 * `/v1/portfolio` composes it alone, with its own cache entry and its own TTL. Two paths to one
 * number is how a portfolio total and a portfolio page disagree by one stale minute, and neither
 * page can tell.
 *
 * **What this does not prove, said plainly.** A freshly registered account holds nothing, so the
 * number both paths agree on is zero. That makes this an agreement test over the empty case and
 * the observation timestamps, not over an amount. Proving it for a non-zero holding needs a
 * `ledger:post` credential beacon cannot hold today; `claims.ts` records that as the gap it is.
 */
export const ECOSYSTEM_ONE_PORTFOLIO: JourneyDefinition = {
  name: 'ecosystem.one-portfolio',
  title: 'The portfolio total is the same number on both of hub’s paths to it',
  productGroup: GROUPS.wallet,
  // `hub-api`, and the title says why: both paths being compared are hub's own.
  service: 'hub-api',
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const hub = ctx.target('hub-api')

    const subject = await ctx.step('be an account with a session', () =>
      poolSession(ctx, identity, 'ecosystem.one-portfolio'),
    )

    const fromDashboard = await ctx.step('read the portfolio tile from the dashboard', async () => {
      const result = await call(ctx, `${hub}/v1/dashboard`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from /v1/dashboard, got ${result.status}`)
      ctx.assert(
        stringField(result.body, 'userId') === subject.userId,
        `the dashboard is for ${String(stringField(result.body, 'userId'))}, not for the account that asked`,
      )
      const tile = field(result.body, 'tiles', 'portfolio')
      ctx.assert(tile !== undefined, 'the dashboard has no portfolio tile at all')
      const status = stringField(result.body, 'tiles', 'portfolio', 'status')
      const reason = stringField(result.body, 'tiles', 'portfolio', 'reason')
      if (status !== 'ok') refuseIfEnvironmentExpired(reason, 'hub-api’s portfolio tile')
      ctx.assert(
        status === 'ok',
        `the dashboard's portfolio tile is "${String(status)}" (${String(reason)}) — the ledger is ` +
          `not answering, so the two paths cannot be compared`,
      )
      return field(result.body, 'tiles', 'portfolio', 'data')
    })

    await ctx.step('read the portfolio on its own path', async () => {
      const result = await call(ctx, `${hub}/v1/portfolio`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from /v1/portfolio, got ${result.status}`)
      const status = stringField(result.body, 'portfolio', 'status')
      ctx.assert(
        status === 'ok',
        `the portfolio page's tile is "${String(status)}" while the dashboard's was ok`,
      )
      const data = field(result.body, 'portfolio', 'data')

      // Deep equality over the whole payload, not just the total. `pricedAt` is the oldest
      // contributing observation and is the field a stale cache moves first; `holdings` is what
      // moves when one path prices and the other does not. Comparing only the total would pass
      // while the page told the reader their valuation was an hour older than it is.
      ctx.assert(
        JSON.stringify(data) === JSON.stringify(fromDashboard),
        `the two paths to the portfolio disagree.\n  dashboard: ${JSON.stringify(fromDashboard).slice(0, 300)}\n  portfolio: ${JSON.stringify(data).slice(0, 300)}`,
      )

      // A total that arrived as a JSON number has already been through a float. Scaled integers
      // as strings are the estate's rule for money and this is the wire-level half of it.
      const total = field(result.body, 'portfolio', 'data', 'totalUsdScaled')
      ctx.assert(
        typeof total === 'string',
        `totalUsdScaled arrived as ${typeof total}; money on this wire is a decimal string, ` +
          `because a number has already lost to binary floating point by the time it is parsed`,
      )
    })
  },
}

/* ------------------------------------------------------------------ 4. one account */

/**
 * Three services, one token, one subject.
 *
 * Vision test 1 is "one account signs into everything, once" and test 2 is "the same identity
 * everywhere". The part of both that is checkable today without a sign-in surface is this: a
 * single access token, presented to identity, to hub-api and to activity, must resolve to the same
 * person in all three. Each service verifies the JWT itself against identity's JWKS; nothing makes
 * them agree about which claim is the subject except that all three read `sub`, and "hub-api
 * resolves the subject from a header when one is present" is a two-line change nobody would think
 * to test from either side.
 */
export const ECOSYSTEM_ONE_ACCOUNT: JourneyDefinition = {
  name: 'ecosystem.one-account',
  title: 'One token means the same person in identity, hub and activity',
  productGroup: GROUPS.account,
  // `identity`. Three services are dialled and the thing under test is whether one identity
  // token means the same subject in all of them — that is identity's claim about itself, and the
  // other two are the witnesses.
  service: 'identity',
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const activity = ctx.target('activity')
    const hub = ctx.target('hub-api')

    const subject = await ctx.step('be an account with a session', () =>
      poolSession(ctx, identity, 'ecosystem.one-account'),
    )

    await ctx.step('identity recognises the token as that account', async () => {
      const result = await call(ctx, `${identity}/auth/me`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from /auth/me, got ${result.status}`)
      ctx.assert(
        stringField(result.body, 'user', 'id') === subject.userId,
        `/auth/me answered for ${String(stringField(result.body, 'user', 'id'))}, not for the registered account`,
      )
      // The EMAIL, not the handle. This compared against the handle submitted at registration, and
      // there is no registration here any more — a pool account's handle is whatever it was
      // provisioned with, which this process does not know and must not be told, because the pool
      // is configured as address-and-password and nothing else. The address is the identifier the
      // sign-in was performed with, so it is the field that can be checked against something this
      // journey actually holds; identity normalises it, hence the comparison in lower case.
      ctx.assert(
        stringField(result.body, 'user', 'email')?.toLowerCase() === subject.account.email.toLowerCase(),
        `/auth/me reports ${String(stringField(result.body, 'user', 'email'))} for the token that ` +
          'was minted by signing in as a different address',
      )
    })

    await ctx.step('hub resolves the same subject from the same token', async () => {
      const result = await call(ctx, `${hub}/v1/dashboard`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from /v1/dashboard, got ${result.status}`)
      ctx.assert(
        stringField(result.body, 'userId') === subject.userId,
        `hub-api resolved the token to ${String(stringField(result.body, 'userId'))} and identity ` +
          `resolved the same token to ${subject.userId}`,
      )
    })

    await ctx.step('activity attributes the account’s own events to it', async () => {
      const found = await pollFor(ctx, BUS, async () => {
        const result = await call(ctx, `${activity}/feed?limit=20`, { token: subject.token })
        ctx.assert(result.status === 200, `expected 200 from activity /feed, got ${result.status}`)
        const page = records(result.body)
        return page.length > 0 ? page : null
      })
      ctx.assert(found !== null, 'no record ever reached activity for a freshly registered account')
      ctx.assert(
        (found as readonly FeedRecord[]).every((record) => record.userId === subject.userId),
        `activity's feed for this token carries records belonging to another user id`,
      )
    })

    await ctx.step('an unauthenticated read of each is refused', async () => {
      // Asserted, not assumed, and asserted on BOTH services. A monitor that only ever checks the
      // happy path cannot tell an authenticated endpoint from an open one, and a per-service
      // suite proving its own route is gated says nothing about the other two.
      const hubAnon = await call(ctx, `${hub}/v1/dashboard`)
      ctx.assert(hubAnon.status === 401, `hub-api answered ${hubAnon.status} without a token`)
      const activityAnon = await call(ctx, `${activity}/feed`)
      ctx.assert(activityAnon.status === 401, `activity answered ${activityAnon.status} without a token`)
    })
  },
}

/* ------------------------------------------------------------------ 5. the trial balance */

/**
 * The ledger balances, and it balances over something.
 *
 * Vision test 10 — one financial source of truth — and 17 §8's continuous gate: **the trial
 * balance is exactly zero**. `ledger/src/entries.ts` computes Σ debits − Σ credits per asset in
 * the database rather than in the application, and its own comment says a non-zero result should
 * be unreachable: either a deferred trigger was dropped or something wrote to `postings` outside
 * the service.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`balanced: true` OVER AN EMPTY JOURNAL IS NOT EVIDENCE, AND THIS JOURNEY REFUSES TO REPORT
 * IT AS SUCH.**
 *
 * Zero minus zero is zero. A ledger that has never recorded an entry answers `balanced: true`,
 * `totalAbsoluteDelta: "0"`, and a monitor that stopped there would publish a green reconciliation
 * signal for a service that has never reconciled anything — the exact shape of the CI job that
 * built an image and read its metadata without ever running it. So `entryCount` is asserted first,
 * and an empty journal is a **skip** with that reason. A skip is not a pass, the gate refuses on
 * it, and refusing to promote a release on the grounds that nothing has proved the ledger works is
 * the correct answer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The token is minted per run from a long-lived credential rather than injected. That is also the
 * answer to the ten-minute cliff `deploy/README.md` records: identity issues service tokens with a
 * 600-second TTL and nothing re-mints one, so anything holding an injected token starts answering
 * 401 ten minutes after the estate came up. A credential mints its own.
 */
export const ECOSYSTEM_TRIAL_BALANCE: JourneyDefinition = {
  name: 'ecosystem.trial-balance',
  title: 'The ledger’s trial balance is exactly zero, over a journal with entries in it',
  productGroup: GROUPS.wallet,
  service: 'ledger',
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const ledger = ctx.target('ledger')
    const credential = serviceCredential()
    if (credential === null) {
      // Unreachable through `ECOSYSTEM_JOURNEYS`, which does not declare this journey without the
      // credential. Kept because the definition is exported and a caller may run it directly, and
      // a journey that ran without its credential would otherwise fail on a 401 and report the
      // ledger broken.
      ctx.skip('BEACON_SERVICE_CREDENTIAL is not set, so no ledger:read token can be minted')
    }

    const token = await ctx.step('mint a ledger:read token from the credential', async () => {
      const result = await call(ctx, `${identity}/service-tokens/exchange`, {
        method: 'POST',
        // The credential goes in the Authorization header; identity shape-checks the prefix
        // before touching the database.
        token: credential as string,
        // ── THIS ARRAY IS BEACON'S ENTIRE OUTBOUND SCOPE DECLARATION ──────────────────────────
        //
        // `satisfies readonly LiveScope[]` rather than a named constant, and the literal stays
        // exactly here, inline, on purpose. Both halves of that are load-bearing.
        //
        // The `satisfies` is the check. This is an outbound demand — what beacon presents to
        // identity — and that direction had never been verified by anything: `service-ci.yml`'s
        // scope audit reads a repository's INBOUND route gates. That is how `micro-market` came
        // to declare `policy:evaluate` and `micro-wallet` `custody:address`, neither ever a
        // registry key, for the life of both services. `LiveScope` rather than `Scope` because
        // `Scope` is every registered key including DEPRECATED ones, and identity will not mint
        // a deprecated scope either — it fail-fasts on its grant list at import, so a bad name
        // here is a dead identity container and no tokens for anybody.
        //
        // The literal stays inline because `micro-deploy` reads it FROM THIS TEXT.
        // `derive-grants.mjs` has two seams: an exported `*_SCOPES` constant, and the `scopes:`
        // body of a `POST /service-tokens/exchange` call. Beacon is only ever seen through the
        // second — it builds no `HttpClient`, so `presentsCredential()` is false for this file,
        // and it has no entry in `compose/estate/grant-gaps.json` precisely because this literal
        // is readable (`deploy/scripts/derive-grants.mjs`). Lifting it to
        // `scopes: LEDGER_SCOPES` would match neither seam: the file would contribute nothing,
        // beacon would silently lose `ledger:read`, and the estate build would fail it as an
        // undeclared gap. A named constant needs micro-deploy to resolve an identifier at this
        // seam first. Until then, `satisfies` buys the whole compile-time guarantee a constant
        // would have, and costs the estate nothing.
        body: { scopes: ['ledger:read'] satisfies readonly LiveScope[] },
      })
      ctx.assert(
        result.status === 201 || result.status === 200,
        `expected 2xx from /service-tokens/exchange, got ${result.status} — ` +
          `${result.text.slice(0, 200)}`,
      )
      const minted = stringField(result.body, 'token') ?? accessToken(result.body)
      ctx.assert(minted !== null, 'the exchange returned no token')
      return minted as string
    })

    await ctx.step('the trial balance is zero and the journal is not empty', async () => {
      const result = await call(ctx, `${ledger}/trial-balance`, { token })
      ctx.assert(result.status === 200, `expected 200 from /trial-balance, got ${result.status}`)

      const entryCount = field(result.body, 'entryCount')
      ctx.assert(
        typeof entryCount === 'number',
        `/trial-balance returned no entryCount, so nothing says the journal has anything in it`,
      )
      if ((entryCount as number) === 0) {
        ctx.skip('the ledger journal is empty — a zero trial balance over nothing proves nothing')
      }

      // `=== true`, never `!== false`. A response that lost the field entirely must not read as
      // balanced, and `undefined !== false` is exactly how that happens.
      const balanced = field(result.body, 'balanced')
      ctx.assert(
        balanced === true,
        `the trial balance is not zero: delta ${String(
          stringField(result.body, 'totalAbsoluteDelta'),
        )} over ${String(entryCount)} entries. Σ debits ≠ Σ credits means every number downstream ` +
          `of the ledger is untrustworthy until it is explained.`,
      )
      ctx.assert(
        stringField(result.body, 'totalAbsoluteDelta') === '0',
        `balanced said true and totalAbsoluteDelta said ` +
          `${String(stringField(result.body, 'totalAbsoluteDelta'))}; the two disagree, which is ` +
          `a defect in the ledger's own arithmetic`,
      )
    })

    await ctx.step('an unauthenticated read of the trial balance is refused', async () => {
      const anon = await call(ctx, `${ledger}/trial-balance`)
      ctx.assert(
        anon.status === 401 || anon.status === 403,
        `the ledger served its trial balance to an unauthenticated caller (${anon.status})`,
      )
    })
  },
}

/* ------------------------------------------------------------------ 6. deposit provisioning */

/**
 * The asset this journey provisions an address for.
 *
 * EMBER, because it is the estate's own chain and `CHAIN_FOR_ASSET` in `wallet/src/addresses.ts`
 * maps it to `ember`. SHARD would be wrong in the way that matters: it settles on no chain, so
 * wallet refuses it 400 `not_depositable` and the happy path would never reach custody at all —
 * a journey that looked like it was driving provisioning while driving only the refusal.
 */
const DEPOSIT_ASSET = 'EMBER'

/**
 * `POST /v1/deposits` provisions a real address, and custody is holding the key it names.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS ROUTE WAS DEAD FOR THE WHOLE LIFE OF THE SERVICE AND NOTHING NOTICED, WHICH IS THE
 * REASON THIS JOURNEY EXISTS RATHER THAN THE BUG IT FIXES.**
 *
 * Deposit provisioning is the ONLY way money enters this platform: payments here are crypto-native
 * and balances are funded by on-chain deposit. It answered 500 to every caller — wallet never sent
 * the `orderId` custody requires and nothing caught the resulting `CustodyRefusedError` — and every
 * layer of observability missed it. `journeys.ts` names `deposit` in the critical-path set and this
 * repository drove no part of it; `conformance` deliberately excluded the happy path *because* it
 * was broken. A capability that is listed and not driven is a claim, not a check.
 *
 * So the assertions below are chosen against that defect specifically, and each is proved to go
 * red in `ecosystem.test.ts` — including one test that stands the estate up answering the exact
 * 500 it used to answer and requires this journey to report `fail`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why this is an ecosystem journey and not a wallet one
 *
 * The rule at the head of this file: a journey here must need at least two processes to be wrong.
 * Provisioning needs wallet to mint an assignment id, present it to custody as the `orderId` half
 * of the SD-09 signing binding, canonicalise the address custody returns, file a wallet row, an
 * assignment row and an outbox event in one transaction, and register the address with the indexer.
 * The defect was in the seam, and neither service's suite could see it: wallet's tests use a local
 * custody fake, and custody's tests never see wallet's request. `custody holds the key that
 * address names` is the step no per-service suite can write.
 *
 * ## What it deliberately does NOT prove
 *
 * **No money moves.** This provisions the address a deposit would arrive at; it does not deposit.
 * Crediting one needs an on-chain transfer and the indexer's confirmation depth, which no journey
 * can produce on demand. The name says `deposit-address` rather than `deposit` for that reason —
 * the critical-path set calls the journey "deposit", and claiming that name for the half that is
 * driveable is how a gap stops being visible.
 *
 * **The `orderId` binding is not read back.** `GET /v1/addresses/:address` publishes neither
 * `userId` nor `orderId`, on purpose — custody's own comment says publishing them would make the
 * `/sign` binding check circular, since the binding's entropy is entirely in those two fields.
 * `GET /v1/admin/keys/:address` serves them to a credential beacon cannot hold. What the 201 does
 * prove is that SOME acceptable `orderId` crossed the seam, because custody reads it with no
 * default and refuses without it — which is precisely the defect that was live.
 *
 * ## What a run leaves behind, and why it is one row and not two
 *
 * One custody key, one managed wallet row, one `deposit_address_assignments` row and one indexer
 * watch, per run, for ever — identity has no deletion route a monitor may call and neither does
 * custody. At a five-minute cadence that is ~288 addresses a day, alongside the throwaway account
 * every journey in this file already leaves (`calls.ts`, `throwaway()`).
 *
 * It is ONE and not two because of the second provision below, and the number of things standing
 * behind that is currently in flux — which is why this journey asserts the OUTCOME rather than
 * naming a mechanism. Checked on 2026-08-04 rather than taken from a comment:
 *
 *   * `wallet/src/deposits.ts` looks for an active assignment before it mints, and its own comment
 *     says that lookup — not the idempotency key it sends — is what actually stops a retry.
 *   * That comment is now half stale. `custody/src/keys.ts`'s `findReplay` consults
 *     `(created_by, idempotency_key)` and then the deposit binding, added by the
 *     `provisioning_idempotency` migration, so custody deduplicates too.
 *   * **And that is not deployed.** `custody_keys` on the running estate has no `idempotency_key`
 *     column at all (`\d custody_keys`, 2026-08-04), so on the estate as it stands today wallet's
 *     find-or-create really is the only guard, and after the next deploy there will be two.
 *
 * Asserting "asking twice yields one address" holds across all three of those states and needs no
 * edit when the fourth arrives. If every guard breaks at once, this journey goes red BEFORE the
 * estate has accumulated a second address per run, which is the correct order to find out in.
 *
 *     delete from custody_keys where user_id in (select id from users where email like 'beacon+%');
 *
 * ## Why it is not critical, deliberately
 *
 * The same decision `ecosystem.event-bus` records, for the same reason and with the same exit: a
 * critical journey refuses every release from the moment it is declared, and this one has no
 * history in any deployment. It also spans three processes and an indexer registration, so its own
 * flake rate is an assumption rather than a number. It blocks a release by FAILING, which is the
 * signal it is here to give, and it is promoted to critical — matching the critical-path set that
 * names deposit — once it has run on a schedule long enough for that number to be known.
 */
export const ECOSYSTEM_DEPOSIT_ADDRESS: JourneyDefinition = {
  name: 'ecosystem.deposit-address',
  title: 'A deposit address is provisioned, and custody holds the key it names',
  productGroup: GROUPS.wallet,
  // `wallet`. Three services are dialled and wallet is the one that must produce the joined-up
  // answer: it orchestrates the mint, files the rows and owns the route a client calls. A failure
  // here is attributed to wallet even when custody caused it — which is exactly what happened.
  service: 'wallet',
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const wallet = ctx.target('wallet')
    const custody = ctx.target('custody')

    const subject = await ctx.step('be an account with a session', () =>
      poolSession(ctx, identity, 'ecosystem.deposit-address'),
    )

    const assignment = await ctx.step('provision a deposit address', async () => {
      const result = await call(ctx, `${wallet}/v1/deposits`, {
        method: 'POST',
        token: subject.token,
        body: { assetCode: DEPOSIT_ASSET },
      })
      // 201 EXACTLY, and the body of the message carries what came back. "Any 2xx" would have
      // passed a route that answered 200 with an empty envelope, and the 500 this replaced told
      // an operator nothing about which of the two services had refused.
      ctx.assert(
        result.status === 201,
        `expected 201 from POST /v1/deposits, got ${result.status} — ${result.text.slice(0, 200)}`,
      )

      const address = stringField(result.body, 'assignment', 'address')
      ctx.assert(
        address !== null && address.length > 0,
        'the provision answered 201 and returned no address — a funding page with an empty box on it',
      )
      const id = stringField(result.body, 'assignment', 'id')
      ctx.assert(id !== null, 'the assignment carries no id, so nothing can name it again')
      ctx.assert(
        stringField(result.body, 'assignment', 'userId') === subject.userId,
        `the address was provisioned for ${String(stringField(result.body, 'assignment', 'userId'))} ` +
          `and not for the account that asked. One missing predicate in a find-or-create is how a ` +
          `funding page shows somebody else's address, which is the worst outcome this route has.`,
      )
      ctx.assert(
        stringField(result.body, 'assignment', 'status') === 'active',
        `the assignment is "${String(stringField(result.body, 'assignment', 'status'))}" rather than ` +
          `active, so money sent to it would arrive at an address nothing is crediting`,
      )
      const urn = stringField(result.body, 'assignment', 'custodyKeyUrn')
      // The URN is the handle settlement and the export ceremony dereference. `04-domain-model.md`
      // sets its form and `wallet/src/custodyclient.ts` mints it from custody's own reply, so it
      // MUST end in the address served beside it. One that names a different address is a row
      // that dereferences to somebody else's key.
      ctx.assert(
        urn !== null && urn.endsWith(address as string),
        `the custody key URN (${String(urn)}) does not name the address served beside it ` +
          `(${String(address)})`,
      )
      return { id: id as string, address: address as string }
    })

    await ctx.step('custody holds the key that address names', async () => {
      // ────────────────────────────────────────────────────────────────────────────────────────
      // THE SEAM, AND THE STEP NO PER-SERVICE SUITE CAN WRITE.
      //
      // Asked of custody DIRECTLY, with the user's own token, so nothing wallet says is taken on
      // trust. Wallet inventing an address, or filing one custody never minted, produces a row
      // that reads perfectly in wallet's own suite and in wallet's own API — and money sent to it
      // is money nobody holds a key for. Custody answers 404 rather than 403 to a caller who does
      // not own the key, so a 200 here is also the ownership binding: this account's token
      // resolves to the user id custody filed against the key.
      // ────────────────────────────────────────────────────────────────────────────────────────
      const result = await call(ctx, `${custody}/v1/addresses/${assignment.address}`, {
        token: subject.token,
      })
      ctx.assert(
        result.status === 200,
        `custody answered ${result.status} for the address wallet had just provisioned ` +
          `(${assignment.address}). A 404 means wallet filed an address custody never minted; ` +
          `money sent there is money nobody holds a key for.`,
      )
      ctx.assert(
        stringField(result.body, 'key', 'address') === assignment.address,
        `custody answered for ${String(stringField(result.body, 'key', 'address'))}, not for the ` +
          `address asked about`,
      )
      // `purpose` is one of the five fields custody compares character for character before it
      // signs (SD-09). A deposit address filed under any other purpose is a key settlement will
      // refuse to sweep with, every tick, for ever.
      ctx.assert(
        stringField(result.body, 'key', 'purpose') === 'deposit',
        `custody holds this key for "${String(stringField(result.body, 'key', 'purpose'))}" rather ` +
          `than for deposit`,
      )
      ctx.assert(
        stringField(result.body, 'key', 'status') === 'active',
        `custody holds this key as "${String(stringField(result.body, 'key', 'status'))}"`,
      )
    })

    await ctx.step('an unauthenticated read of the key is refused', async () => {
      // Asserted, not assumed, and asserted against CUSTODY. An address is not a secret, but the
      // route that serves one is the same route the export ceremony is reached through, and a
      // monitor that only ever calls it with a token cannot tell a gated endpoint from an open
      // one. The day that regresses is the day nobody notices.
      const anon = await call(ctx, `${custody}/v1/addresses/${assignment.address}`)
      ctx.assert(
        anon.status === 401 || anon.status === 403,
        `custody served a key to an unauthenticated caller (${anon.status})`,
      )
    })

    await ctx.step('asking again returns the same address, not a second one', async () => {
      // ────────────────────────────────────────────────────────────────────────────────────────
      // ONE ADDRESS PER ASSET, HOWEVER MANY TIMES IT IS ASKED FOR.
      //
      // Asserted as an OUTCOME and never as a mechanism, because the mechanisms are moving under
      // it: wallet's find-or-create is the only guard on the estate as deployed today, and
      // custody's own `findReplay` becomes a second one the moment the `provisioning_idempotency`
      // migration ships. See the header, where both were checked rather than read.
      //
      // What is at stake if they all go: every load of the receive panel leaves another watched
      // address behind and another key in the service that holds the estate's keys, under a
      // binding settlement must restate to sweep. Nothing else in the estate would say so.
      // ────────────────────────────────────────────────────────────────────────────────────────
      const again = await call(ctx, `${wallet}/v1/deposits`, {
        method: 'POST',
        token: subject.token,
        body: { assetCode: DEPOSIT_ASSET },
      })
      ctx.assert(
        again.status === 201,
        `a repeated provision answered ${again.status} — ${again.text.slice(0, 160)}`,
      )
      ctx.assert(
        stringField(again.body, 'assignment', 'id') === assignment.id &&
          stringField(again.body, 'assignment', 'address') === assignment.address,
        `asking twice produced two addresses (${assignment.address} then ` +
          `${String(stringField(again.body, 'assignment', 'address'))}). Every guard against a ` +
          `retry — or a page reload — minting a second key has failed at once: wallet's ` +
          `find-or-create and, where it is deployed, custody's own idempotency.`,
      )
    })

    await ctx.step('the assignment is listed back', async () => {
      const result = await call(ctx, `${wallet}/v1/deposits`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from GET /v1/deposits, got ${result.status}`)
      const listed = field(result.body, 'assignments')
      ctx.assert(Array.isArray(listed), 'GET /v1/deposits returned no assignments array')
      const mine = (listed as unknown[])
        .map((row) => (typeof row === 'object' && row !== null ? (row as Json) : null))
        .filter((row): row is Json => row !== null)
      const found = mine.find((row) => stringField(row, 'id') === assignment.id)
      // Provisioned and not readable back is a user who cannot find the address they were just
      // given, which is the same outcome as never having been given one.
      ctx.assert(
        found !== undefined,
        `assignment ${assignment.id} was provisioned and does not appear in GET /v1/deposits`,
      )
      ctx.assert(
        stringField(found as Json, 'address') === assignment.address,
        `the listed address differs from the one provisioned: ` +
          `${String(stringField(found as Json, 'address'))} vs ${assignment.address}`,
      )
    })

    await ctx.step('an asset that does not settle on a chain is refused', async () => {
      // The other half of the route, and the half that keeps the first half honest: a route that
      // answered 201 to everything would pass every assertion above. A Shard deposit address
      // would be an address on no chain — money sent to a place that cannot credit it — so the
      // refusal is the feature, and `not_depositable` is the code a funding page renders.
      const result = await call(ctx, `${wallet}/v1/deposits`, {
        method: 'POST',
        token: subject.token,
        body: { assetCode: 'NOTACOIN' },
      })
      ctx.assert(
        result.status === 400,
        `an asset that settles on no chain was answered ${result.status} rather than 400`,
      )
      ctx.assert(
        stringField(result.body, 'error', 'code') === 'not_depositable',
        `the refusal's code is "${String(stringField(result.body, 'error', 'code'))}" rather than ` +
          `not_depositable, which is the code a client renders on the funding page`,
      )
    })

    await ctx.step('an unauthenticated provision is refused', async () => {
      const anon = await call(ctx, `${wallet}/v1/deposits`, {
        method: 'POST',
        body: { assetCode: DEPOSIT_ASSET },
      })
      // An open provisioning route mints custody keys for anybody who asks, which is an unbounded
      // write into the service that holds the estate's keys.
      ctx.assert(
        anon.status === 401,
        `wallet provisioned a deposit address for an unauthenticated caller (${anon.status})`,
      )
    })
  },
}

/* ------------------------------------------------------------------ the registry */

/**
 * The ecosystem journeys this build declares.
 *
 * `ECOSYSTEM_TRIAL_BALANCE` appears only when a credential exists to run it with. That is the
 * difference between "absent because it cannot run" — which is the rule this repository holds — and
 * "declared and skipping for ever", which is how a gate gets switched off.
 */
export function ecosystemJourneys(
  source: Readonly<Record<string, string | undefined>> = process.env,
): readonly JourneyDefinition[] {
  const withCredential = (source['BEACON_SERVICE_CREDENTIAL']?.trim() ?? '').length > 0
  return [
    ECOSYSTEM_EVENT_BUS,
    ECOSYSTEM_ONE_ACTIVITY,
    ECOSYSTEM_ONE_PORTFOLIO,
    ECOSYSTEM_ONE_ACCOUNT,
    // Declared unconditionally, like the four above it and unlike the trial balance. It needs no
    // credential — the user's own token reaches both routes — only an address for `wallet` and one
    // for `custody`, and a deployment that runs neither gets the same skip-with-a-reason
    // `ctx.target` gives every other journey. That is the ordinary case this repository already
    // handles, not the "declared and skipping for ever" case its rule is about.
    ECOSYSTEM_DEPOSIT_ADDRESS,
    ...(withCredential ? [ECOSYSTEM_TRIAL_BALANCE] : []),
  ]
}

/** Every ecosystem journey, declared or not. `claims.ts` maps the eleven claims onto these. */
export const ALL_ECOSYSTEM_JOURNEYS: readonly JourneyDefinition[] = [
  ECOSYSTEM_EVENT_BUS,
  ECOSYSTEM_ONE_ACTIVITY,
  ECOSYSTEM_ONE_PORTFOLIO,
  ECOSYSTEM_ONE_ACCOUNT,
  ECOSYSTEM_DEPOSIT_ADDRESS,
  ECOSYSTEM_TRIAL_BALANCE,
]

export type { JourneyContext }
