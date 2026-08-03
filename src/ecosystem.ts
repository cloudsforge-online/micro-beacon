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
 * ## Why only four are declared unconditionally
 *
 * The same rule `estate.ts` already holds itself to: **only journeys that actually exercise
 * something are declared.** Everything below either runs today against the dev estate — verified
 * by running it, not by reading a document — or is absent with its blocker named in `claims.ts`.
 * A declared-but-skipping journey refuses every release for ever and the gate gets switched off; a
 * declared-but-faked one reports green and makes the gate a lie.
 *
 * `ecosystem.trial-balance` is the one conditional case, and it is conditional on a **credential**
 * rather than on a missing feature: `ECOSYSTEM_JOURNEYS` includes it only when
 * `BEACON_SERVICE_CREDENTIAL` is set. Beacon cannot hold one today —
 * `IDENTITY_SERVICE_TOKEN_GRANTS` in `deploy/compose/docker-compose.estate.yml` names thirteen
 * services and `beacon` is not among them, so `POST /service-credentials` answers 500 with "no
 * scopes are configured for service 'beacon'". That is a deploy change, not a code change, and the
 * journey is written and tested so that granting it is the only remaining step.
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
 *
 * A method and a path rather than a line number, for the reason `estate.ts` sets out at length: a
 * line number is a claim about a file that any edit to an earlier part of that file silently
 * falsifies, asserted from a repository that cannot see the file at all.
 */

import { accessToken, call, field, pollFor, registerThrowaway, stringField, type Json } from './calls.ts'
import { GROUPS } from './groups.ts'
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
  // Not critical, deliberately, and this is a decision rather than an oversight. A critical
  // journey refuses every release from the moment it is declared, and this one has no history in
  // any deployment yet. It is promoted to critical when it has run on a schedule long enough for
  // its own flake rate to be a known number rather than an assumption. Until then it blocks a
  // release only by failing, which is the signal it is here to give.
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const activity = ctx.target('activity')

    const subject = await ctx.step('register an account in identity', () =>
      registerThrowaway(ctx, identity),
    )

    const arrived = await ctx.step('the fact reaches activity’s feed', async () => {
      const found = await pollFor(ctx, BUS, async () => {
        const result = await call(ctx, `${activity}/feed?limit=20`, { token: subject.token })
        ctx.assert(result.status === 200, `expected 200 from activity /feed, got ${result.status}`)
        return records(result.body).find((record) => record.userId === subject.userId) ?? null
      })
      ctx.assert(
        found !== null,
        `a user was committed in identity and no record for them reached activity within ` +
          `${(BUS.attempts * BUS.intervalMs) / 1000}s. The relay, the signing secret and the ` +
          `subscription rows in identity's event_subscriptions are the three places to look.`,
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
      const other = await registerThrowaway(ctx, identity)
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
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const activity = ctx.target('activity')
    const hub = ctx.target('hub-api')

    const subject = await ctx.step('register an account in identity', () =>
      registerThrowaway(ctx, identity),
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
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const hub = ctx.target('hub-api')

    const subject = await ctx.step('register an account in identity', () =>
      registerThrowaway(ctx, identity),
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
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')
    const activity = ctx.target('activity')
    const hub = ctx.target('hub-api')

    const subject = await ctx.step('register an account in identity', () =>
      registerThrowaway(ctx, identity),
    )

    await ctx.step('identity recognises the token as that account', async () => {
      const result = await call(ctx, `${identity}/auth/me`, { token: subject.token })
      ctx.assert(result.status === 200, `expected 200 from /auth/me, got ${result.status}`)
      ctx.assert(
        stringField(result.body, 'user', 'id') === subject.userId,
        `/auth/me answered for ${String(stringField(result.body, 'user', 'id'))}, not for the registered account`,
      )
      ctx.assert(
        stringField(result.body, 'user', 'handle') === subject.account.handle,
        `the handle submitted at registration is not the handle identity reports back`,
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
        // is readable (`deploy/scripts/derive-grants.mjs:414-421`). Lifting it to
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

/* ------------------------------------------------------------------ the registry */

/** Read at call time rather than at import, so a test can set it without reloading the module. */
function serviceCredential(): string | null {
  const value = process.env['BEACON_SERVICE_CREDENTIAL']?.trim()
  return value && value.length > 0 ? value : null
}

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
    ...(withCredential ? [ECOSYSTEM_TRIAL_BALANCE] : []),
  ]
}

/** Every ecosystem journey, declared or not. `claims.ts` maps the eleven claims onto these. */
export const ALL_ECOSYSTEM_JOURNEYS: readonly JourneyDefinition[] = [
  ECOSYSTEM_EVENT_BUS,
  ECOSYSTEM_ONE_ACTIVITY,
  ECOSYSTEM_ONE_PORTFOLIO,
  ECOSYSTEM_ONE_ACCOUNT,
  ECOSYSTEM_TRIAL_BALANCE,
]

export type { JourneyContext }
