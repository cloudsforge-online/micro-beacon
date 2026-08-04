/**
 * The journeys this build runs against the estate.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **ONLY JOURNEYS THAT ACTUALLY EXERCISE SOMETHING ARE DECLARED HERE.**
 *
 * The critical-path set in 13-operational-model.md:435 is nine journeys — register, sign in, SSO
 * handoff, deposit, convert, spend, withdraw, mint deploy, market purchase. Five of them move
 * money across a chain, and the services that would do so are not deployed
 * (18-build-status.md:43: "nothing is deployed"). So they are **absent** rather than declared and
 * left to skip.
 *
 * That is a deliberate choice and it is the safe one in both directions:
 *
 *   * A declared-but-skipping critical journey would refuse every release for ever, because a skip
 *     is not a pass. The gate would be switched off within a week, which is how a gate dies.
 *   * A declared-but-faked journey — one that asserts nothing and returns — would report green and
 *     make the gate a lie, which is worse than not having one.
 *
 * The README lists which of the nine exist and which do not, so the gap is a stated fact rather
 * than an absence somebody has to notice. Adding one is this file plus one row.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO OF THE JOURNEYS BELOW COULD ONLY EVER FAIL, AND BOTH ARE FIXED IN PLACE.**
 *
 * Found on 2026-08-03 by running them against the dev estate, which nothing in this repository had
 * ever done — the six journeys had no tests at all.
 *
 *   * `identity.signin` posted `{ email, password }` to `POST /auth/login`.
 *     `@cloudsforge/contracts-auth`'s `validateLogin` reads `identifier` and has never read
 *     `email`, so identity answered 400 on every run.
 *   * `identity.handoff` posted `{}` to `POST /auth/handoff`, which requires `redirectOrigin`, and
 *     redeemed without the `Origin` header the redemption route requires. 400 on every run.
 *
 * Both are CRITICAL, so the gate refused every release — for the monitor's own defect, dressed up
 * as the product being broken. That is the worst failure a release gate has: the fix everybody
 * reaches for is to switch the gate off. `estate.test.ts` now drives all six against a fake estate
 * that answers exactly what the real services answer, and each assertion is proved to go red when
 * the estate stops holding it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **The cross-service journeys are in `ecosystem.ts`, and the browser catalogue is in
 * `browser/`.** The split is by what a journey needs to be wrong: everything here is one service
 * answering for itself, everything there needs at least two processes or a rendered page.
 *
 * Every route below was read out of the service that serves it, not out of a document. Two of the
 * estate's own architecture documents were found stale while this repository was being written, so
 * a route taken from prose is a route that has not been checked.
 *
 *   POST /auth/register          identity/src/server.ts
 *   POST /auth/login             identity/src/server.ts
 *   GET  /auth/me                identity/src/server.ts
 *   POST /auth/handoff           identity/src/server.ts
 *   POST /auth/handoff/redeem    identity/src/server.ts
 *   GET  /v1/listings            market/src/server.ts
 *   POST /v1/titles              worlds/src/server.ts
 *
 * **These citations name a route and not a line, and that is a correction rather than a style
 * choice.** The list carried line numbers until the audit that produced this comment checked them.
 * Two were wrong in the way that is worst — they resolved, to real code that was not the route
 * claimed. `worlds/src/server.ts:467` pointed into the entitlement handler's `recordGrant` call;
 * `POST /v1/titles` is nowhere near it. `market/src/server.ts:618` pointed at the collections
 * block; `/v1/listings` is further down. A citation that fails loudly is a citation somebody
 * fixes. A citation that lands on plausible unrelated code is one a reader believes.
 *
 * The remaining five were all correct, and then stopped being correct while this very comment was
 * being edited: an eight-line change inside `POST /auth/register` — which is upstream of the other
 * four in the same file — moved every one of them. Nothing about that change was careless, no
 * reviewer of it would think to look here, and no test anywhere in the estate could have caught
 * it. That is the whole case: a line number is a claim about a file that any edit to an earlier
 * part of that file silently falsifies, and it is asserted from a repository that cannot see the
 * file at all.
 *
 * A method and a path are the same fact stated in a form that survives. They are also directly
 * resolvable — `grep -n "define('POST', '/v1/titles'" worlds/src/server.ts` — which is what a
 * line number was standing in for, done in a way that cannot rot.
 */

import { accessToken, call, registerAccount, stringField, throwaway } from './calls.ts'
import { GROUPS } from './groups.ts'
import { ecosystemJourneys } from './ecosystem.ts'
import type { JourneyContext, JourneyDefinition } from './journeys.ts'

/**
 * Product groups now live in `groups.ts` and are re-exported here.
 *
 * Three files need them and this one imports two of those three to assemble the registry, so
 * keeping the constant here would make the import graph a cycle for the sake of five strings.
 * The re-export keeps `GROUPS` importable from where it has always been importable from.
 */
export { GROUPS }

export const IDENTITY_REGISTER: JourneyDefinition = {
  name: 'identity.register',
  title: 'A new account can be created and recognised',
  productGroup: GROUPS.account,
  // Only identity is dialled. Its budget, unambiguously.
  service: 'identity',
  critical: true,
  async run(ctx) {
    const identity = ctx.target('identity')
    const account = throwaway()

    const token = await ctx.step('register', async () => {
      // The estate protecting itself is not the estate being broken. Identity rate-limits
      // registration, and recording a limit hit as a failure would open an incident against a
      // control that is working. `registerAccount` waits out identity's own `retry-after` once
      // before it skips — read the block above it in `calls.ts`: this journey skipped on every
      // cycle for ten cycles because Beacon's OWN non-critical journeys spent the allowance first.
      const result = await registerAccount(ctx, identity, account)
      ctx.assert(result.status === 201, `expected 201 from /auth/register, got ${result.status}`)
      const token = accessToken(result.body)
      ctx.assert(token !== null, 'registration returned no access token')
      return token as string
    })

    await ctx.step('read the account back from the token', async () => {
      const result = await call(ctx, `${identity}/auth/me`, { token })
      ctx.assert(result.status === 200, `expected 200 from /auth/me, got ${result.status}`)
    })

    await ctx.step('an unauthenticated read is refused', async () => {
      const result = await call(ctx, `${identity}/auth/me`)
      // Asserted, not assumed. A monitor that only ever checks the happy path cannot tell an
      // authenticated endpoint from an open one, and the day that regresses is the day nobody
      // notices.
      ctx.assert(result.status === 401, `expected 401 without a token, got ${result.status}`)
    })
  },
}

export const IDENTITY_SIGNIN: JourneyDefinition = {
  name: 'identity.signin',
  title: 'An existing account can sign in',
  productGroup: GROUPS.account,
  service: 'identity',
  critical: true,
  async run(ctx) {
    const identity = ctx.target('identity')
    const account = throwaway()

    await ctx.step('register the account this run will sign into', async () => {
      const result = await registerAccount(ctx, identity, account)
      ctx.assert(result.status === 201, `expected 201 from /auth/register, got ${result.status}`)
    })

    await ctx.step('sign in', async () => {
      // ────────────────────────────────────────────────────────────────────────────────────────
      // `identifier`, NOT `email`. This journey posted `{ email, password }` until 2026-08-03 and
      // `@cloudsforge/contracts-auth`'s `validateLogin` has never read that field: it reads
      // `identifier`, and decides email-or-handle by looking for an `@`. So every run of this
      // CRITICAL journey answered 400 "an identifier and a password are required" and reported
      // the product broken, which is the worst possible failure for a release gate — the gate
      // refuses every release, the refusal is the gate's own bug, and the fix everyone reaches
      // for is to switch the gate off.
      //
      // Found by running it against the dev estate rather than by reading it. Nothing in this
      // repository could have caught it: the journeys had no tests at all, and a test that
      // asserted "the journey posts the body the journey was written to post" would have passed.
      // ────────────────────────────────────────────────────────────────────────────────────────
      const result = await call(ctx, `${identity}/auth/login`, {
        method: 'POST',
        body: { identifier: account.email, password: account.password },
      })
      if (result.status === 429) ctx.skip('login is rate limited')
      ctx.assert(result.status === 200, `expected 200 from /auth/login, got ${result.status}`)
      ctx.assert(accessToken(result.body) !== null, 'login returned no access token')
    })

    await ctx.step('the wrong password is refused', async () => {
      const result = await call(ctx, `${identity}/auth/login`, {
        method: 'POST',
        body: { identifier: account.email, password: `${account.password}-wrong` },
      })
      if (result.status === 429) ctx.skip('login is rate limited')
      // 401 exactly, never "any 4xx". A 400 here would mean the request was malformed — which is
      // what the bug above produced — and accepting it would let a journey that never reached the
      // password check report that the password check works.
      ctx.assert(result.status === 401, `expected 401 for a wrong password, got ${result.status}`)
    })
  },
}

export const IDENTITY_HANDOFF: JourneyDefinition = {
  name: 'identity.handoff',
  title: 'One account signs into everything, once',
  productGroup: GROUPS.account,
  // Both halves of the hand-off are identity's routes; the "everything" in the title is the
  // surfaces an operator would reach for, and not a service this journey touches.
  service: 'identity',
  critical: true,
  async run(ctx) {
    const identity = ctx.target('identity')
    const account = throwaway()

    // ──────────────────────────────────────────────────────────────────────────────────────────
    // THE HAND-OFF IS BOUND TO AN ORIGIN, AND THIS JOURNEY POSTED NO ORIGIN AT ALL.
    //
    // `POST /auth/handoff` requires `redirectOrigin` and mints a code bound to it;
    // `POST /auth/handoff/redeem` requires an `Origin` header and matches the two. That binding IS
    // the security of the hand-off — without it an open redirect anywhere in the estate turns a
    // legitimate sign-in into a token delivered to somebody else's page.
    //
    // Until 2026-08-03 this journey sent `body: {}` and no `Origin`, so identity answered 400
    // "redirectOrigin is required" and the journey failed. A CRITICAL journey that can only fail
    // refuses every release for ever, for a reason that is the monitor's own defect.
    //
    // The origin is configuration rather than a constant: it must be one identity's own
    // `IDENTITY_HANDOFF_ORIGINS` allowlist names, which is a property of the deployment. Unset is
    // a SKIP with the variable named — the same treatment `ctx.target` gives a service this
    // deployment does not run. It is not a failure: an estate that has not configured SSO has not
    // demonstrated a broken SSO.
    // ──────────────────────────────────────────────────────────────────────────────────────────
    const origin = process.env['BEACON_HANDOFF_ORIGIN']?.trim()
    if (!origin) {
      ctx.skip(
        'BEACON_HANDOFF_ORIGIN is not set. It must be one of the origins identity accepts in ' +
          'IDENTITY_HANDOFF_ORIGINS; a hand-off code is bound to an origin at mint and matched at ' +
          'redemption, so there is nothing to mint against without one.',
      )
    }

    const token = await ctx.step('register', async () => {
      const result = await registerAccount(ctx, identity, account)
      ctx.assert(result.status === 201, `expected 201 from /auth/register, got ${result.status}`)
      const registered = accessToken(result.body)
      ctx.assert(registered !== null, 'registration returned no access token')
      return registered as string
    })

    const code = await ctx.step('mint a handoff code', async () => {
      const result = await call(ctx, `${identity}/auth/handoff`, {
        method: 'POST',
        token,
        body: { redirectOrigin: origin },
      })
      if (result.status === 403) {
        // The allowlist refusing an origin is the allowlist working. Skipping names the two
        // variables that have to agree, which is what somebody reading this needs; failing would
        // report identity broken when identity has just enforced its most important rule.
        ctx.skip(
          `identity refused "${origin}" as a hand-off origin. BEACON_HANDOFF_ORIGIN must appear in ` +
            `identity's IDENTITY_HANDOFF_ORIGINS.`,
        )
      }
      ctx.assert(
        result.status === 201 || result.status === 200,
        `expected 2xx from /auth/handoff, got ${result.status} — ${result.text.slice(0, 160)}`,
      )
      const value = stringField(result.body, 'code')
      ctx.assert(value !== null, 'handoff returned no code')
      return value as string
    })

    const redeemed = await ctx.step('redeem it in the other product', async () => {
      const result = await call(ctx, `${identity}/auth/handoff/redeem`, {
        method: 'POST',
        body: { code },
        headers: { origin: origin as string },
      })
      ctx.assert(
        result.status === 200,
        `expected 200 from redeem, got ${result.status} — ${result.text.slice(0, 160)}`,
      )
      const issued = accessToken(result.body)
      // The point of a hand-off is a SESSION on the other product. A 200 carrying no token is a
      // redemption that consumed the code and delivered nothing, which reads as success and is
      // not one.
      ctx.assert(issued !== null, 'the redemption answered 200 and issued no access token')
      return issued as string
    })

    await ctx.step('the redeemed session is a real session', async () => {
      const result = await call(ctx, `${identity}/auth/me`, { token: redeemed })
      ctx.assert(result.status === 200, `the token from the hand-off answered ${result.status} at /auth/me`)
      ctx.assert(
        stringField(result.body, 'user', 'handle') === account.handle,
        'the hand-off issued a session for a different account',
      )
    })

    await ctx.step('the code is single use', async () => {
      const result = await call(ctx, `${identity}/auth/handoff/redeem`, {
        method: 'POST',
        body: { code },
        headers: { origin: origin as string },
      })
      // THE security property of the handoff, and the reason this journey is critical rather than
      // convenient. A replayable code is a session anyone who saw one URL can take.
      ctx.assert(result.status >= 400, `a redeemed handoff code was accepted twice (${result.status})`)
    })
  },
}

export const MARKET_CATALOGUE: JourneyDefinition = {
  name: 'market.catalogue',
  title: 'The market catalogue can be read',
  productGroup: GROUPS.market,
  service: 'market',
  critical: false,
  async run(ctx) {
    const market = ctx.target('market')
    await ctx.step('read the listings', async () => {
      const result = await call(ctx, `${market}/v1/listings`)
      ctx.assert(result.status === 200, `expected 200 from /v1/listings, got ${result.status}`)
      ctx.assert(Array.isArray(result.body['listings']), '/v1/listings returned no listings array')
    })
    await ctx.step('read the collections', async () => {
      const result = await call(ctx, `${market}/v1/collections`)
      ctx.assert(result.status === 200, `expected 200 from /v1/collections, got ${result.status}`)
    })
  },
}

export const WORLDS_REGISTRY: JourneyDefinition = {
  name: 'worlds.registry',
  title: 'The title registry answers, so a launcher can list games',
  productGroup: GROUPS.worlds,
  service: 'worlds',
  critical: false,
  async run(ctx) {
    const worlds = ctx.target('worlds')
    await ctx.step('read the title registry', async () => {
      const result = await call(ctx, `${worlds}/v1/titles`)
      ctx.assert(result.status === 200, `expected 200 from /v1/titles, got ${result.status}`)
      ctx.assert(Array.isArray(result.body['titles']), '/v1/titles returned no titles array')
    })
  },
}

/**
 * Every configured address answers `/livez`.
 *
 * Not a substitute for a probe — a probe checks one target every thirty seconds and this runs
 * every five minutes — but it is the one journey that fails when the *estate* is missing rather
 * than when a *service* is. A deploy that brought up eight of nine containers passes every
 * per-service probe that exists and fails this.
 */
export const ESTATE_REACHABLE: JourneyDefinition = {
  name: 'estate.reachable',
  title: 'Every service the estate is configured to have is answering',
  productGroup: GROUPS.network,
  // `beacon`, and it is the one entry that is not the service being dialled. This journey asserts
  // that EVERY address in `BEACON_TARGETS` answers, so no single target owns its failures — but
  // something must, or the budget is unowned. Beacon owns it because Beacon owns the target list:
  // when this journey goes red the first question is whether the estate lost a service or whether
  // Beacon is pointed at one that no longer exists, and that question is Beacon's to answer.
  service: 'beacon',
  critical: true,
  async run(ctx) {
    // Ordered so a failure names the same service every time. An unordered scan reports whichever
    // one happened to be checked first, which makes two runs of the same outage look different.
    for (const name of [...ESTATE_SERVICES].sort()) {
      let base: string
      try {
        base = ctx.target(name)
      } catch {
        // Not configured in this deployment. `ctx.target` throws a skip, and catching it here
        // rather than letting it end the journey is what lets a partial estate still prove the
        // part it does run.
        continue
      }
      await ctx.step(`${name} is answering`, async () => {
        const result = await call(ctx, `${base}/livez`, { deadlineMs: 5_000 })
        ctx.assert(result.status === 200, `${name} answered ${result.status} on /livez`)
      })
    }
  },
}

/** The services `estate.reachable` will look for, if `BEACON_TARGETS` names them. */
export const ESTATE_SERVICES: readonly string[] = [
  'identity',
  'ledger',
  'wallet',
  'billing',
  'market',
  'mint',
  'worlds',
  'notify',
  'hub-api',
  // Added with the ecosystem journeys, which is the first thing in this repository that needs
  // activity to be reachable. A name here costs nothing when the deployment does not run the
  // service — `estate.reachable` skips a target it has no address for.
  'activity',
  // Added with `ecosystem.deposit-address`, which is the first journey in this repository that
  // dials custody. `wallet` was already named here and had no address configured, so this journey
  // is also the first thing that makes either of them a real target rather than a listed one.
  'custody',
]

/** The six per-service journeys, before the cross-service ones are added. */
export const SERVICE_JOURNEYS: readonly JourneyDefinition[] = [
  IDENTITY_REGISTER,
  IDENTITY_SIGNIN,
  IDENTITY_HANDOFF,
  MARKET_CATALOGUE,
  WORLDS_REGISTRY,
  ESTATE_REACHABLE,
]

/**
 * The registry this build ships. `index.ts` syncs it into the table at boot.
 *
 * The ecosystem set is assembled at import from the environment, because one of its members needs
 * a credential and a journey with no credential to run with must be ABSENT rather than declared
 * and skipping — the rule this file's header sets out. Browser journeys are added by `index.ts`
 * rather than here: they need the browser configuration, and pulling `playwright-core`'s
 * availability check into a module every test imports would make the whole suite depend on an
 * optional dependency.
 */
export const JOURNEYS: readonly JourneyDefinition[] = [...SERVICE_JOURNEYS, ...ecosystemJourneys()]

/** Re-exported so a caller can construct one in a test without importing the internals. */
export type { JourneyContext }
