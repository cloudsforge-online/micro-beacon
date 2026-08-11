/**
 * The journeys this build runs against the estate.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **ONLY JOURNEYS THAT ACTUALLY EXERCISE SOMETHING ARE DECLARED HERE.**
 *
 * The critical-path set in 13-operational-model.md is nine journeys — register, sign in, SSO
 * handoff, deposit, convert, spend, withdraw, mint deploy, market purchase. Five of them move
 * money across a chain, and the services that would do so are not deployed
 * (18-build-status.md: "nothing is deployed"). So they are **absent** rather than declared and
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
 * claimed. `worlds/src/server.ts` pointed into the entitlement handler's `recordGrant` call;
 * `POST /v1/titles` is nowhere near it. `market/src/server.ts` pointed at the collections
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

import {
  accessToken,
  call,
  field,
  registerAccount,
  sessionFieldIn,
  stringField,
  throwaway,
} from './calls.ts'
import { GROUPS } from './groups.ts'
import { ecosystemJourneys } from './ecosystem.ts'
import { poolAccount, poolSession } from './pool.ts'
import type { JourneyContext, JourneyDefinition } from './journeys.ts'

/**
 * Product groups now live in `groups.ts` and are re-exported here.
 *
 * Three files need them and this one imports two of those three to assemble the registry, so
 * keeping the constant here would make the import graph a cycle for the sake of five strings.
 * The re-export keeps `GROUPS` importable from where it has always been importable from.
 */
export { GROUPS }

/**
 * How often the estate's only account-creating journey creates an account.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIRTY MINUTES, BECAUSE EVERY RUN OF THIS JOURNEY LEAVES A PERMANENT ROW.**
 *
 * At the 300s default (`BEACON_JOURNEY_INTERVAL_MS`) this journey alone would write 288 user rows
 * a day into identity, for ever, and identity has no deletion route a monitor may call. Thirty
 * minutes is 48 a day — two an hour — which is the rate micro-org#390 asked for and is chosen
 * against the two things that actually bound it:
 *
 *   * **Detection.** `journeyFreshnessMs` defaults to four intervals, so the gate tolerates one
 *     missed run and refuses on two. At 30 minutes a registration outage is a refused release
 *     within an hour and an incident after `failThreshold` runs. Registration is not a route whose
 *     breakage has to be caught in ninety seconds; it is one whose breakage must not be caught
 *     only by a customer.
 *   * **The budget's denominator.** `identity.register` carries a 95% objective over 28 days
 *     (`sloseed.ts`). At 48 runs a day that window holds 1,344 runs, so one bad run costs 0.07% of
 *     a 5% budget — still a population big enough for the arithmetic to mean something, which a
 *     journey running twice a day would not be.
 *
 * It is declared here rather than in the environment because it is a property of what this journey
 * COSTS, which is a fact about the journey and not about a deployment. A deployment that wants
 * everything faster raises `BEACON_JOURNEY_INTERVAL_MS`; this one stays where it is, and
 * `schedule.sync` takes whichever is longer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const REGISTER_INTERVAL_MS = 1_800_000

export const IDENTITY_REGISTER: JourneyDefinition = {
  name: 'identity.register',
  title: 'A new account can be created, and cannot be used until its address is confirmed',
  productGroup: GROUPS.account,
  // Only identity is dialled. Its budget, unambiguously.
  service: 'identity',
  critical: true,
  intervalMs: REGISTER_INTERVAL_MS,
  async run(ctx) {
    const identity = ctx.target('identity')
    const account = throwaway()

    /*
     * ────────────────────────────────────────────────────────────────────────────────────────────
     * **202 WITH NO SESSION, AND THIS JOURNEY ASSERTED 201 WITH ONE UNTIL 2026-08-11.**
     *
     * identity stopped minting a session at registration when it grew email verification, and its
     * own comment calls that the point of the route: an address nobody had proved control of was
     * being signed in the moment it was typed, and the owner reported both halves from the live
     * product — "i didn't receive any registration email and i was able to login directly".
     *
     * This journey went on demanding the shape identity had deliberately stopped serving, so a
     * CRITICAL journey failed on every scheduled cycle and reported the fix as the defect. Measured
     * on mainnet the day it was corrected: 24 consecutive `fail` runs in two hours, seven journeys
     * with the same cause, while identity answered exactly what it was written to answer.
     *
     * Beacon's own suite stayed green throughout, because its fake answered 201 — a check that
     * could not fail, pointed at an integration boundary. `estate.test.ts` now drives this against
     * a fake that answers what mainnet answers, and the 201 case is asserted to REDDEN it.
     * ────────────────────────────────────────────────────────────────────────────────────────────
     */
    const registered = await ctx.step('register', async () => {
      // The estate protecting itself is not the estate being broken. Identity rate-limits
      // registration, and recording a limit hit as a failure would open an incident against a
      // control that is working. `registerAccount` waits out identity's own `retry-after` once
      // before it skips — read the block above it in `calls.ts`: this journey skipped on every
      // cycle for ten cycles because Beacon's OWN non-critical journeys spent the allowance first.
      const result = await registerAccount(ctx, identity, account)
      ctx.assert(
        result.status === 202,
        `expected 202 from /auth/register, got ${result.status} — ${result.text.slice(0, 160)}`,
      )
      ctx.assert(
        field(result.body, 'verificationRequired') === true,
        'registration answered 202 without saying a verification is required, so a client cannot ' +
          'tell "check your email" from "you are signed in"',
      )
      // The NORMALISED address, echoed back. identity's route says why it is in the body: somebody
      // who typed `Sam@Example.com` must be shown the spelling the platform will use, or "check
      // your email" points at an inbox they will not think to look in.
      ctx.assert(
        stringField(result.body, 'email') === account.email.toLowerCase(),
        `registration echoed ${String(stringField(result.body, 'email'))} rather than the ` +
          'normalised address it will have mailed',
      )
      return result
    })

    await ctx.step('the response carries no session', async () => {
      // The SAME response, not a second registration. This is a step of its own rather than three
      // more lines above because the board shows the step name and this assertion is a security
      // property in its own right: a regression that restores the session would otherwise read as
      // "failed at step 'register'", which is the step that would still be passing. It costs no
      // extra row — one run of this journey creates exactly one account, and `REGISTER_INTERVAL_MS`
      // is the reason that sentence matters.
      const leaked = sessionFieldIn(registered.body)
      ctx.assert(
        leaked === null,
        `registration answered 202 and still returned "${String(leaked)}". THE ABSENCE OF A SESSION ` +
          'IS THE POINT OF THIS ROUTE: a session here signs in an address nobody has proved control ' +
          'of, which is the defect email verification was added to close',
      )
    })

    await ctx.step('the account cannot sign in until the address is confirmed', async () => {
      const result = await call(ctx, `${identity}/auth/login`, {
        method: 'POST',
        body: { identifier: account.email, password: account.password },
      })
      if (result.status === 429) ctx.skip('login is rate limited')
      // 403 exactly, and the CODE. A 401 would mean identity had failed to find or match the
      // credential — which is also a refusal, and would let this step report that verification is
      // enforced on a deployment where registration had silently stored nothing at all.
      ctx.assert(
        result.status === 403,
        `an unverified account was answered ${result.status} by /auth/login, not 403. Anything ` +
          'that is not a refusal means the account is usable without its address being proved',
      )
      ctx.assert(
        stringField(result.body, 'error', 'code') === 'email_unverified',
        `the refusal code was ${String(stringField(result.body, 'error', 'code'))}, not ` +
          'email_unverified — so this account was refused for some other reason and this step has ' +
          'stopped proving what it says it proves',
      )
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

    /*
     * ────────────────────────────────────────────────────────────────────────────────────────────
     * **IT REGISTERED THE ACCOUNT IT WAS ABOUT TO SIGN IN AS, AND THAT STOPPED BEING POSSIBLE.**
     *
     * A registration no longer produces an account that can sign in: `POST /auth/register` answers
     * 202 and `signInRefusal` refuses `unverified` until the mailed link is spent, which this
     * process cannot do. So a journey that registered-then-signed-in could only ever assert its own
     * 403 — and before that, while it still asserted 201 on the registration, it failed one step
     * earlier and never reached the sign-in at all.
     *
     * The account is a provisioned one now (`pool.ts`), which is also what a sign-in journey should
     * always have been driving: signing in as an account created eleven seconds ago exercises the
     * password path and nothing else, while a pool account has been through a verification, has a
     * session history and is the thing a returning person actually is.
     *
     * **This journey does NOT take a cached session.** `poolAccount` returns credentials only; the
     * sign-in below is a real one on every run, because a sign-in journey that reused a token would
     * be the estate's favourite defect — a check that cannot fail.
     * ────────────────────────────────────────────────────────────────────────────────────────────
     */
    const account = poolAccount(ctx, 'identity.signin')

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

    // A pool account rather than a registration, for `identity.signin`'s reason: a hand-off is
    // minted FROM a session, and a freshly registered account no longer has one to mint from.
    const subject = await ctx.step('be an account with a session', () =>
      poolSession(ctx, identity, 'identity.handoff'),
    )
    const token = subject.token

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
      // The user ID, not the handle. A handle is a display name a person may change; the subject
      // is what the hand-off is a hand-off OF, and it is the field every other service authorises
      // on. Comparing anything mutable here would make this assertion fail the day somebody renames
      // the pool account, and report it as the hand-off issuing somebody else's session.
      ctx.assert(
        stringField(result.body, 'user', 'id') === subject.userId,
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

/**
 * The registration challenge REFUSES somebody who did not solve it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY OTHER JOURNEY THAT REGISTERS IS EXCUSED THE CHALLENGE, SO SOMETHING HAS TO NOT BE.**
 *
 * micro-org#361 put a Cloudflare Turnstile in front of `POST /auth/register`, and `registerAccount`
 * gets past it by authenticating as a service principal. That is correct — beacon has no browser
 * and cannot solve a puzzle — and it means the four journeys that register would go on passing
 * word for word if the gate were deleted tomorrow. A control that only ever runs in bypass is a
 * control nobody is watching, which is the defect class micro-org#355 and #356 are both instances
 * of. This journey is the other half: it presents NO credential, and asserts the refusal.
 *
 * ── IT COSTS NO MAIL, AND THAT IS LOAD-BEARING ────────────────────────────────────────────────
 *
 * The mail plan allows 250 sends a day and beacon's own registrations have exhausted it before
 * (micro-org#243; `calls.test.ts` carries the arithmetic). A REFUSED registration creates no
 * account, emits no `identity.email.verification_requested`, and therefore sends nothing — the
 * challenge is taken before anything is created, which `identity/src/server.ts` says in the
 * comment above `runRegistrationChallenge`. The skip below is what keeps that true: on a
 * deployment with no challenge this same request would SUCCEED, and a journey that registered a
 * real throwaway account on every cycle to prove a gate that is not there would cost a mail each
 * time to learn nothing.
 *
 * ── WHY IT IS DECLARED UNCONDITIONALLY, AND NON-CRITICAL ──────────────────────────────────────
 *
 * `ecosystem.trial-balance` sets the precedent for a journey that is ABSENT rather than declared
 * and skipping, and it can be: its condition is a variable in beacon's own environment, readable
 * at import. This one's condition is not. Whether registration is challenged is a property of
 * IDENTITY's configuration, published at runtime by `GET /auth/challenge`, and beacon cannot know
 * it without asking. A second copy of the answer in beacon's environment would be exactly the
 * "second notion of the same fact" this change was written to avoid — two settings that can
 * disagree, with the disagreement showing up as a monitor that lies.
 *
 * So it is declared always and `critical: false`. A skip on a deployment with no challenge is then
 * honest and costs nothing: `collectReasons` in `gate.ts` skips over a non-critical journey
 * entirely, so this cannot refuse a release for being inapplicable — while a real 202 where a 403
 * was due is a `fail`, on the board, at the named step.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const IDENTITY_CHALLENGE: JourneyDefinition = {
  name: 'identity.registration-challenge',
  title: 'A registration nobody solved the challenge for is refused',
  productGroup: GROUPS.account,
  service: 'identity',
  critical: false,
  async run(ctx) {
    const identity = ctx.target('identity')

    await ctx.step('identity publishes whether registration is challenged', async () => {
      // No token, deliberately: this route is read by somebody who has no account yet, so a
      // credential being needed here would be a defect in itself.
      const result = await call(ctx, `${identity}/auth/challenge`)
      if (result.status === 404) {
        ctx.skip('this identity predates micro-org#361 and has no GET /auth/challenge')
      }
      ctx.assert(result.status === 200, `expected 200 from /auth/challenge, got ${result.status}`)

      const required = field(result.body, 'required')
      // `=== true`, never `!== false`. An answer that lost the field must not read as challenged:
      // this journey would then assert a 403 that nothing was ever going to send, and report
      // identity broken for a response it never made.
      ctx.assert(typeof required === 'boolean', '/auth/challenge answered without a `required` flag')
      if (required !== true) {
        ctx.skip('this deployment has no registration challenge configured, so there is no gate here to prove')
      }

      // A required challenge with no site key is a form nobody can complete: hub-web has nothing
      // to render the widget with, so every human registration fails — and no automated one
      // notices, because they are all excused. Asserted here rather than left to the browser tier,
      // which does not run in every deployment.
      const siteKey = stringField(result.body, 'siteKey')
      ctx.assert(
        siteKey !== null && siteKey !== '',
        'identity says a challenge is required and published no site key to render it with, so no ' +
          'browser can produce a token and nobody can open an account',
      )
    })

    await ctx.step('a registration carrying no challenge token is refused', async () => {
      const account = throwaway()
      const result = await call(ctx, `${identity}/auth/register`, {
        method: 'POST',
        // NO `token`, and that is the entire scenario. `registerAccount` is not used here for the
        // same reason — it presents a service bearer, which is precisely what must be absent.
        body: { email: account.email, handle: account.handle, password: account.password },
      })
      if (result.status === 429) ctx.skip('registration is rate limited')

      ctx.assert(
        result.status !== 503,
        'identity answered 503: the challenge could not be checked at all, and it fails closed, so ' +
          'nobody can open an account right now. That is an outage of the challenge and not a ' +
          'finding about this gate',
      )
      ctx.assert(
        result.status === 403,
        `an unchallenged registration was answered ${result.status}, not 403. A 202 means the gate ` +
          'is open and every bot in the world may open accounts; anything else means it refused ' +
          'for some other reason and this journey has stopped proving what it says it proves',
      )
      // The CODE, not just the status. identity separates "nothing was sent" from "something was
      // sent and did not hold" (`ChallengeError`), and this journey sent nothing — reading
      // `challenge_failed` here would mean identity found a token in a request that carried none.
      const code = stringField(result.body, 'error', 'code')
      ctx.assert(
        code === 'challenge_required',
        `expected the refusal code challenge_required, got ${String(code)}`,
      )
      // And nothing leaked out on the way. The gate runs before validation exactly so that this
      // route cannot be used to ask whether an address or a handle is taken.
      ctx.assert(
        field(result.body, 'fields') === undefined,
        'the refusal carried field-level detail, so validation ran before the gate did and this ' +
          'route is an existence oracle again',
      )
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

/** The per-service journeys, before the cross-service ones are added. */
export const SERVICE_JOURNEYS: readonly JourneyDefinition[] = [
  IDENTITY_REGISTER,
  IDENTITY_SIGNIN,
  IDENTITY_HANDOFF,
  // The only journey in this list that is not excused the registration challenge, and the only
  // reason the other three prove anything about it. micro-org#361.
  IDENTITY_CHALLENGE,
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
