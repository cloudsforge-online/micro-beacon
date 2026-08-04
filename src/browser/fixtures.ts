/**
 * An account with real money in it, built the way the estate would build one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FIXTURE IS A REAL POSTING THROUGH A REAL SERVICE, NOT A ROW WRITTEN BEHIND ITS BACK.**
 *
 * A money journey needs a balance to spend, and there are two ways to get one. Writing the row
 * into `micro-ledger`'s Postgres directly is quicker and produces a state the service could never
 * have reached — no journal, no idempotency key, nothing for the deferred balance constraint to
 * have checked — so every assertion downstream would be about a fiction. Posting a balanced
 * double entry through `POST /entries` produces the same state a deposit produces, because it IS
 * the shape a deposit takes (`deploy/scripts/estate-verify.sh:280-291`).
 *
 * So this module registers a real account against identity, mints a real service token, and posts
 * a real balanced entry. The account is disposable and the domain is `.test`, which RFC 2606
 * reserves and no resolver will route mail to.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why the operator credential is configuration and its absence is a loud skip
 *
 * `POST /service-tokens` is refused to an ordinary account — identity answers 403, and
 * `estate-verify.sh:121-123` records that as the deliberate gap it is. So seeding a balance needs
 * the estate operator's credential, which is configuration and must never be a default. A journey
 * that cannot get one **skips, naming what to set**; it does not fall back to asserting against an
 * empty account, because "the page showed nothing and the ledger holds nothing" is a check that
 * cannot fail and is the exact failure mode this estate keeps finding.
 */

import type { JourneyContext } from '../journeys.ts'
import { wait, waitMsFor } from './backoff.ts'
import {
  creditSubject,
  ledgerBalances,
  mintServiceToken,
  signInForToken,
  subjectOf,
  trialBalanceBalanced,
  type LedgerAccess,
} from './money.ts'

/** The estate credential that can mint a service token. Configuration; never defaulted. */
export interface Operator {
  readonly identifier: string
  readonly password: string
}

export interface FundedAccount {
  readonly email: string
  readonly handle: string
  readonly password: string
  /** identity's id for the account. The ledger subject is `user:<this>`. */
  readonly userId: string
  /** The ledger subject, ready to pass to `ledgerBalances`. */
  readonly subject: string
  /** The account's own bearer token, for calling a service as the user this browser signs in as. */
  readonly token: string
  /** A `ledger:read` + `ledger:post` service token, for reading the books back afterwards. */
  readonly ledger: LedgerAccess
  /** What was credited, by asset code, in the asset's smallest units. */
  readonly credited: ReadonlyMap<string, bigint>
}

/**
 * A credential nobody else will use, derived from the run.
 *
 * Carried over from `journeys.ts`'s `synthetic()` for its two reasons: the identifier carries the
 * run id so two replicas cannot collide on a handle and turn a passing journey red, and the handle
 * is `[a-z0-9]` only because identity's handle rule is itself under test elsewhere and a fixture
 * that tripped it would assert the wrong refusal.
 */
export function syntheticCredential(ctx: JourneyContext, tag: string): {
  email: string
  handle: string
  password: string
} {
  const id = ctx.runId.replace(/-/g, '').slice(0, 12)
  return {
    email: `bj${tag}${id}@example.test`,
    handle: `bj${tag}${id}`.slice(0, 20),
    // Long, and constant: it is not a secret — it guards an account that exists for ninety seconds
    // — and generating one would put a random value in a failure message for no gain.
    password: 'correct-horse-battery-staple-42',
  }
}

/**
 * Register an account, credit it, and prove the ledger holds what was asked for.
 *
 * Everything that goes wrong in here throws rather than asserting, and the distinction is
 * `journeys.ts` rule 1: this is the journey's FIXTURE. A failure to build it is beacon being
 * unable to ask the question, which is an `error` and goes to whoever owns the harness. Calling it
 * a `fail` would open an incident against a product that may be perfectly healthy.
 */
export async function fundAccount(
  ctx: JourneyContext,
  operator: Operator | null,
  options: {
    readonly tag: string
    /** Asset code to smallest-unit amount. `EMBER` is the only chain asset this estate prices. */
    readonly credit: ReadonlyMap<string, bigint>
  },
): Promise<FundedAccount> {
  if (operator === null) {
    // A loud skip with the variable named in it. See the header for why there is no fallback.
    ctx.skip(
      'no estate operator credential is configured, and identity refuses POST /service-tokens to ' +
        'an ordinary account (403). Without one this journey cannot put a balance on an account, ' +
        'and asserting that an empty page matches an empty ledger is a check that cannot fail. ' +
        'Set BEACON_ESTATE_OPERATOR and BEACON_ESTATE_OPERATOR_PASSWORD.',
    )
  }

  const identity = { base: ctx.target('identity'), signal: ctx.signal }
  const who = syntheticCredential(ctx, options.tag)

  // ── THE REGISTRATION LIMITER IS REAL, AND WAITING FOR IT IS NOT WORKING AROUND IT ────────────
  //
  // identity caps `/auth/register` at five per window (`identity/src/server.ts:421`), taken at
  // dispatch so a refusal costs what a success does. That is a deliberate control and this must
  // not defeat it — but a shard of six money journeys each seeding one account WILL hit it, and a
  // journey that reported the product broken because its own fixture was throttled would be the
  // harness blaming the estate. So the `retry-after` the service names is HONOURED, a bounded
  // number of times, and exhausting it is still an error rather than a silent continue.
  let registration: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    registration = await fetch(`${identity.base.replace(/\/+$/, '')}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(who),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
    })
    if (registration.status !== 429) break
    // The service's own number, never a guess: it knows its window and this does not.
    await registration.arrayBuffer()
    await wait(waitMsFor(registration.headers.get('retry-after')), ctx.signal)
  }
  if (registration === null || !registration.ok) {
    throw new Error(
      `could not register the journey's account (HTTP ${registration?.status ?? 'no response'}) — ` +
        'this is the fixture, not the product',
    )
  }
  const registered = (await registration.json()) as { accessToken?: unknown }
  const token = typeof registered.accessToken === 'string' ? registered.accessToken : ''
  if (token === '') throw new Error('identity registered the account and issued no access token')

  const userId = await subjectOf(identity, token)
  const subject = `user:${userId}`

  const operatorToken = await signInForToken(identity, operator.identifier, operator.password)
  const ledger: LedgerAccess = {
    base: ctx.target('ledger'),
    // Minted per journey rather than shared. identity issues service tokens with a 600-second TTL
    // and nothing re-mints one (`identity/src/tokens.ts:28`), which is doc 22 §4.1's ten-minute
    // cliff: a shard running eight minutes would hand its last journey an expired credential and
    // report the product broken.
    token: await mintServiceToken(identity, operatorToken, 'wallet', ['ledger:read', 'ledger:post']),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }

  for (const [assetCode, amount] of options.credit) {
    await creditSubject(ledger, {
      subject,
      assetCode,
      amount,
      // The run id, so a retried journey credits once — ledger answers 200 on a replay rather than
      // posting the money twice — and two replicas cannot collide.
      idempotencyKey: `beacon-browser-${ctx.runId}-${assetCode}`,
    })
  }

  // ── THE FIXTURE IS VERIFIED BEFORE IT IS USED ────────────────────────────────────────────────
  // A journey that assumes its own precondition and then asserts a page against it reports the
  // product broken when the fixture silently did nothing. Read the books back, exactly.
  const balances = await ledgerBalances(ledger, subject)
  for (const [assetCode, amount] of options.credit) {
    const held = balances.get(assetCode)
    if (held !== amount) {
      throw new Error(
        `the fixture credited ${amount} ${assetCode} to ${subject} and the ledger reports ` +
          `${held === undefined ? 'no account at all' : `${held}`} — the precondition did not hold`,
      )
    }
  }
  if (!(await trialBalanceBalanced(ledger))) {
    throw new Error(
      'the trial balance does not balance after the fixture posting — the estate is in a state ' +
        'no journey should be asserting against',
    )
  }

  return { ...who, userId, subject, token, ledger, credited: options.credit }
}

/**
 * Sign the browser in, for real, through the page a person uses.
 *
 * The same form and the same last assertion as `smoke.ts`: reaching a page is not a session, so
 * this leaves the `/account` path AND renders the handle — a string the application can only have
 * obtained from identity's answer.
 */
export async function signInBrowser(
  ctx: JourneyContext,
  page: {
    goto(url: string, options?: { waitUntil?: string }): Promise<unknown>
    fill(selector: string, value: string): Promise<void>
    click(selector: string): Promise<void>
    waitForURL(predicate: (url: URL) => boolean, options?: { timeout?: number }): Promise<void>
    waitForLoadState(state: string, options?: { timeout?: number }): Promise<void>
    evaluate<T>(fn: () => T): Promise<T>
    url(): string
  },
  hubBase: string,
  who: { handle: string; password: string },
  timeoutMs: number,
  /**
   * What the signed-in page must render, when it is not the string typed into the form.
   *
   * identity's login field takes an address OR a handle, so an account signed in by email renders a
   * handle the form never saw. Defaulting to `who.handle` keeps the ordinary case one argument.
   */
  rendersAs = who.handle,
): Promise<void> {
  const base = hubBase.replace(/\/+$/, '')
  await page.goto(`${base}/account/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  // BY NAME, and `identifier` rather than `email`: identity's field takes an address OR a handle,
  // and a suite typing into `input[name=email]` would fail against a page that is working.
  await page.fill('input[name=identifier]', who.handle)
  await page.fill('input[name=password]', who.password)
  await page.click('button[type=submit]')
  await page.waitForURL((url) => !url.pathname.startsWith('/account'), { timeout: timeoutMs })
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  const text = await page.evaluate(() => document.body?.innerText ?? '')
  ctx.assert(
    text.includes(rendersAs),
    `signed in at ${base}/account/login and landed on ${page.url()} rendering ` +
      `${text.trim().length} characters, none of which is the handle "${rendersAs}" — reaching a ` +
      'page is not a session',
  )
}
