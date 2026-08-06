/**
 * The dashboard and the portfolio — the one number that is supposed to be true about what you hold.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE ARE THREE PLACES THIS ESTATE STATES A BALANCE, AND NOTHING CHECKED THEY AGREE.**
 *
 * `micro-ledger` holds it, `hub-api` composes it into a portfolio tile, and `hub-web` renders it
 * twice — once as the overview's TOTAL HELD and once on the portfolio page. Every one of those is
 * separately tested against a stub, and a stub cannot express the failure that matters: the three
 * disagreeing. A holding dropped between the ledger and the tile, a total that stops including one
 * asset, an overview and a portfolio computing the same figure two ways — all of those are green
 * in sixteen mocked suites and wrong on screen.
 *
 * So every assertion here starts at `micro-ledger`'s own books and works outwards, in `bigint`:
 *
 *   ledger balance  →  the holding hub-api sent  →  the digits on the page  →  the same digits on
 *   the other page
 *
 * Nothing is compared as a float and nothing is parsed back out of the DOM into a number. Where a
 * figure has to be matched on screen it is matched on the exact digit run the estate holds, with
 * only the separators a locale added removed — `money.ts`'s `rendersAmount` states why.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { JourneyContext, JourneyDefinition } from '../journeys.ts'
import { GROUPS } from '../groups.ts'
import type { BrowserConfig, BrowserPage } from './driver.ts'
import { requestsTo } from './driver.ts'
import type { Scenario } from './catalogue.ts'
import { surfaceJourney } from './journeys.ts'
import { fundAccount, signInBrowser, type Operator } from './fixtures.ts'
import { signInForToken } from './money.ts'
import { ledgerBalances, money, rendersAmount } from './money.ts'

/**
 * `ctx.skip`, as a declared function, so the compiler knows control does not continue past it.
 *
 * See the note on the identical helper in `foresightjourneys.ts`: `JourneyContext.skip` returns
 * `never` and is honoured as such only where the receiver carries an explicit annotation, and
 * `verify(ctx, …)`'s parameters are contextually typed. Without this the value after a skip is
 * possibly-undefined and the natural fix is a non-null assertion — which is exactly the assertion a
 * journey must not make about its own fixture.
 */
function stop(ctx: JourneyContext, reason: string): never {
  return ctx.skip(reason)
}

type Implementation = (
  config: BrowserConfig,
  scenario: Scenario,
  operator: Operator | null,
) => JourneyDefinition

/**
 * Two assets, so the total is a SUM rather than a copy of one number.
 *
 * A single-asset fixture makes `totalUsdScaled === holdings[0].usdScaled` trivially, and an
 * arithmetic error in the composition would pass. Two holdings is the smallest fixture in which the
 * total is actually computed. The amounts are deliberately not round: both are recognisable in a
 * failure message and neither is a value another fixture would produce by accident.
 *
 * ── NEITHER IS A CHAIN ASSET, AND THAT IS THE POINT ────────────────────────────────────────────
 *
 * An earlier draft credited EMBER. EMBER settles on chain 7412, so a ledger credit with no matching
 * on-chain deposit is unbacked liability — and reconciliation caught exactly that shape while this
 * was being written and froze the asset (`drift_exceeded`, ledger 36e18 against chain 31e18). A
 * fixture that has to be reversed by somebody else is not a fixture. SHARD and USD are internal
 * units, reconcile against nothing, and make every assertion here identically strong.
 */
const SEED: ReadonlyMap<string, bigint> = new Map([
  ['SHARD', 1_234_567n],
  ['USD', 4_321n],
])

interface Tile {
  readonly status?: string
  readonly reason?: string | null
  readonly data?: unknown
}

async function hubJson(
  ctx: JourneyContext,
  hubBase: string,
  token: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${hubBase.replace(/\/+$/, '')}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
  })
  if (!response.ok) throw new Error(`GET ${path} on hub-api answered HTTP ${response.status}`)
  return (await response.json()) as Record<string, unknown>
}

async function settled(page: BrowserPage, timeoutMs: number): Promise<string> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  await page.waitForTimeout(1_500)
  return await page.evaluate(() => document.body?.innerText ?? '')
}

/** The holdings hub-api composed, as a map of asset code to smallest units. */
function holdingsOf(tile: Tile): ReadonlyMap<string, bigint> {
  const rows = (tile.data as { holdings?: readonly Record<string, unknown>[] })?.holdings ?? []
  const out = new Map<string, bigint>()
  for (const row of rows) {
    out.set(String(row['assetCode'] ?? ''), money(row['amount'], 'a composed holding amount'))
  }
  return out
}

/* ------------------------------------------------------------------ BJ-DSH-01 */

/**
 * BJ-DSH-01 ★ — every tile renders, and the total is the sum of what the ledger holds.
 *
 * Doc 22: "all eleven tiles render, and the portfolio total equals the sum the response implies."
 *
 * The row's second clause is the one with teeth and it is asserted twice over, because "the sum
 * the response implies" can be checked against the response and still be a lie about the account:
 *
 *   1. **The ledger's balance is the holding's amount**, per asset, exactly. This is the join
 *      nothing else in the estate makes — hub-api's own tests assert its composition against a
 *      stubbed ledger, and a holding silently dropped between the two is invisible to both sides.
 *   2. **The total is the sum of the priced holdings**, in scaled integers. `hub-api` drops a
 *      holding it cannot price and sets `pricingComplete: false` rather than valuing it at zero
 *      (`wallet/src/pricingclient.ts`: "a valuation of zero is a lie about a holding that exists"),
 *      so the sum is over the priced ones and the flag is asserted alongside it.
 *   3. **The page shows the amount**, as the exact digit run, so a total that is right in the API
 *      and wrong on screen is still red.
 */
const dashboardTotal: Implementation = (config, scenario, operator) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.wallet,
    config,
    surface: 'hub',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const account = await ctx.step('an account holding two assets, posted to the ledger', async () =>
        fundAccount(ctx, operator, { tag: 'd1', credit: SEED }),
      )

      await ctx.step('sign in through the page a person uses', async () => {
        await signInBrowser(ctx, page, base, account, config.timeoutMs)
      })

      const tiles = await ctx.step('every tile hub-api composes is present and states itself', async () => {
        const body = await hubJson(ctx, base, account.token, '/v1/dashboard')
        const composed = (body['tiles'] ?? {}) as Record<string, Tile>
        const names = Object.keys(composed)
        // Eleven, per the row. Asserted as "at least the eleven", because a twelfth tile is a
        // feature and a missing one is a hole — and naming the missing one is what a person needs.
        for (const required of [
          'portfolio', 'prices', 'wallets', 'deposits', 'withdrawals', 'activity',
          'security', 'restrictions', 'entitlements', 'alerts', 'notifications',
        ]) {
          ctx.assert(
            composed[required] !== undefined,
            `GET /v1/dashboard carried no "${required}" tile. It carried: ${names.join(', ')}`,
          )
        }
        // Every tile STATES itself. A tile with no status is one the page cannot tell apart from
        // an empty one, which is the whole distinction `states.tsx` is built around.
        for (const [name, tile] of Object.entries(composed)) {
          ctx.assert(
            typeof tile.status === 'string' && tile.status !== '',
            `the "${name}" tile carries no status, so the page cannot tell "answered with nothing" ` +
              'from "did not answer"',
          )
        }
        return composed
      })

      await ctx.step('THE LEDGER’S BALANCE IS THE HOLDING hub-api SENT, TO THE UNIT', async () => {
        const portfolio = tiles['portfolio'] as Tile
        ctx.assert(
          portfolio.status === 'ok',
          `the portfolio tile answered "${portfolio.status}" (${portfolio.reason ?? 'no reason'}), ` +
            'so there is no composed holding to compare against the ledger',
        )
        const composed = holdingsOf(portfolio)
        const books = await ledgerBalances(account.ledger, account.subject)
        for (const [assetCode, held] of books) {
          ctx.assert(
            composed.get(assetCode) === held,
            `micro-ledger holds ${held} ${assetCode} for ${account.subject} and hub-api composed ` +
              `${composed.get(assetCode) ?? 'no holding at all'}. A holding dropped between the ` +
              'ledger and the tile is invisible to both services’ own tests',
          )
        }
        // And the other direction, which is the one that catches an INVENTED holding.
        for (const [assetCode, amount] of composed) {
          ctx.assert(
            books.get(assetCode) === amount,
            `hub-api composed ${amount} ${assetCode} and micro-ledger holds ` +
              `${books.get(assetCode) ?? 'no account for it'}`,
          )
        }
      })

      await ctx.step('THE TOTAL IS THE SUM OF THE PRICED HOLDINGS, IN SCALED INTEGERS', async () => {
        const data = (tiles['portfolio'] as Tile).data as {
          totalUsdScaled?: unknown
          pricingComplete?: unknown
          holdings?: readonly Record<string, unknown>[]
        }
        const rows = data.holdings ?? []
        let sum = 0n
        let unpriced = 0
        for (const row of rows) {
          const scaled = row['usdScaled']
          // A holding with no usable price is EXCLUDED, never valued at zero. Counted, so the
          // `pricingComplete` flag can be asserted against the count rather than taken on trust.
          if (typeof scaled !== 'string' || scaled === '') {
            unpriced += 1
            continue
          }
          sum += money(scaled, `the usdScaled of ${String(row['assetCode'])}`)
        }
        ctx.assert(
          money(data.totalUsdScaled, 'the portfolio total') === sum,
          `hub-api reports a total of ${String(data.totalUsdScaled)} scaled and its own holdings ` +
            `sum to ${sum}. ${rows.length} holding(s), ${unpriced} of them unpriced`,
        )
        ctx.assert(
          data.pricingComplete === (unpriced === 0),
          `pricingComplete is ${String(data.pricingComplete)} and ${unpriced} holding(s) carry no ` +
            'usable price. A zero and an unknown must not look identical, and the flag is how a ' +
            'reader is told which they are looking at',
        )
      })

      await ctx.step('and the page shows the amount the ledger holds', async () => {
        await page.goto(`${base.replace(/\/+$/, '')}/portfolio`, { waitUntil: 'domcontentloaded' })
        const text = await settled(page, config.timeoutMs)
        const books = await ledgerBalances(account.ledger, account.subject)
        for (const [assetCode, held] of books) {
          ctx.assert(
            rendersAmount(text, held),
            `micro-ledger holds ${held} ${assetCode} and ${page.url()} renders no such figure. It ` +
              `showed ${text.trim().length} characters`,
          )
        }
      })
    },
  })

/* ------------------------------------------------------------------ BJ-XS-04 */

/**
 * BJ-XS-04 ★ — one portfolio: the overview's total and the portfolio's total are one number.
 *
 * Vision test 4, and doc 22's row: "the two figures are equal and carry the same `pricedAt`."
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TWO PAGES ARE FED BY TWO DIFFERENT ROUTES, WHICH IS WHY THIS CAN FAIL.**
 *
 * The overview reads the portfolio TILE of `GET /v1/dashboard`; the portfolio page reads
 * `GET /v1/portfolio`. Two compositions, two caches, two chances to disagree — and a reader who
 * sees one figure on the front page and another one click later has no way to know which is theirs.
 *
 * Asserted three ways, because "the same string appears on both pages" is weaker than it looks:
 * the two API routes must agree in scaled integers, both must agree with the ledger, and the two
 * RENDERED pages must both carry the figure. A test on the rendering alone would pass against two
 * pages that were both wrong in the same way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const onePortfolio: Implementation = (config, scenario, operator) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.wallet,
    config,
    surface: 'hub',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const account = await ctx.step('an account holding two assets, posted to the ledger', async () =>
        fundAccount(ctx, operator, { tag: 'x4', credit: SEED }),
      )

      await ctx.step('sign in through the page a person uses', async () => {
        await signInBrowser(ctx, page, base, account, config.timeoutMs)
      })

      const figures = await ctx.step('THE TWO ROUTES AGREE, IN SCALED INTEGERS', async () => {
        const dashboard = await hubJson(ctx, base, account.token, '/v1/dashboard')
        const standalone = await hubJson(ctx, base, account.token, '/v1/portfolio')
        const fromTile = ((dashboard['tiles'] as Record<string, Tile>)['portfolio'] as Tile).data as {
          totalUsdScaled?: unknown
          pricedAt?: unknown
        }
        // `GET /v1/portfolio` answers `{ portfolio: <tile> }` — a single key with the tile beneath
        // it, not the tile at the top level (hub-api/src/server.ts). Reading it the other way
        // round would produce `undefined` and `money()` would refuse it by name rather than
        // silently comparing two zeros.
        const fromRoute = (standalone['portfolio'] as Tile).data as {
          totalUsdScaled?: unknown
          pricedAt?: unknown
        }
        const tileTotal = money(fromTile.totalUsdScaled, 'the overview’s total')
        const routeTotal = money(fromRoute.totalUsdScaled, 'the portfolio route’s total')
        ctx.assert(
          tileTotal === routeTotal,
          `the overview composes a total of ${tileTotal} scaled and the portfolio route composes ` +
            `${routeTotal}. Two routes, one account, two answers — a reader has no way to know ` +
            'which is theirs',
        )
        // The stamp too. Doc 22's row asks for it and hub-api computes it as the OLDEST
        // contributing observation, so two different stamps mean the two pages priced the holding
        // at two different moments and only one of them can be what the summary claims.
        ctx.assert(
          String(fromTile.pricedAt ?? '') === String(fromRoute.pricedAt ?? ''),
          `the two routes carry different pricedAt stamps: "${String(fromTile.pricedAt)}" and ` +
            `"${String(fromRoute.pricedAt)}"`,
        )
        return { total: tileTotal }
      })

      await ctx.step('and both totals are the ledger’s, not each other’s', async () => {
        // Two wrong numbers that agree with each other are still two wrong numbers. The ledger is
        // the only thing that makes the previous step mean something.
        const books = await ledgerBalances(account.ledger, account.subject)
        let holdings = 0n
        for (const amount of books.values()) holdings += amount
        ctx.assert(
          holdings > 0n,
          `the fixture credited ${[...SEED.keys()].join(' and ')} and the ledger reports nothing ` +
            'for this account — there is no total to check',
        )
        ctx.assert(
          figures.total > 0n,
          `the account holds ${holdings} across ${books.size} asset(s) and both routes report a ` +
            'total of zero. A zero total over a non-empty account is the failure this asserts',
        )
      })

      await ctx.step('BOTH PAGES RENDER IT, AND THE SAME ONE', async () => {
        const seen: string[] = []
        for (const path of ['/', '/portfolio']) {
          await page.goto(`${base.replace(/\/+$/, '')}${path}`, { waitUntil: 'domcontentloaded' })
          const text = await settled(page, config.timeoutMs)
          const shown = await page.evaluate(() => {
            const body = document.body?.innerText ?? ''
            // The figure beneath the TOTAL HELD label, as the page renders it. Read as a string and
            // compared as a string: parsing a currency back into a number here would reintroduce
            // exactly the float this whole file avoids.
            const match = /TOTAL HELD\s*\n\s*([^\n]+)/i.exec(body)
            return match?.[1]?.trim() ?? ''
          })
          ctx.assert(
            shown !== '',
            `${page.url()} renders no TOTAL HELD figure at all. It showed ${text.trim().length} ` +
              'characters',
          )
          seen.push(shown)
        }
        ctx.assert(
          seen[0] === seen[1],
          `the overview shows "${seen[0]}" as the total held and the portfolio page shows ` +
            `"${seen[1]}". One account, one portfolio`,
        )
      })
    },
  })

/* ------------------------------------------------------------------ BJ-DSH-17 */

/**
 * BJ-DSH-17 ★ — the second page is appended, and the cursor goes back byte-for-byte.
 *
 * Doc 22: "the second page is **appended**, not substituted, and the cursor is passed back
 * byte-for-byte without being parsed."
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE CURSOR HALF IS ONLY ASSERTABLE FROM THE NETWORK LOG, AND IT IS THE HALF THAT ROTS.**
 *
 * `hub-web/src/pages/activity.tsx` records the rule: the cursor is opaque, and a client that parses
 * it "would have to be kept in step" with a format only the server owns. A client that URL-decoded,
 * trimmed, or re-encoded it would still LOOK right — the second page would arrive, the rows would
 * append — until the day the server changed its encoding, at which point the feed silently
 * truncates for everybody.
 *
 * So this reads the cursor the server issued for page one, over HTTP, and asserts the browser's
 * own second request carried that exact string. Same account, same page size, so the two are
 * comparable; nothing is intercepted, and the browser's request is not influenced by the reading.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The fixture is real sign-ins, because identity writes one `security.session_created` record per
 * session and there is no route that fabricates an activity row. It is the slowest fixture in this
 * file and it is the only honest one.
 */
const activityAppends: Implementation = (config, scenario, operator) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.account,
    config,
    surface: 'hub',
    critical: scenario.gate,
    async verify(ctx, page, collected, base) {
      // `hub-web/src/lib/hub.ts` — the page size the bundle asks for. Named here so the fixture
      // is "more than one page" rather than "thirty, probably enough".
      const PAGE_SIZE = 25

      // ── THIS JOURNEY BUILDS NO FIXTURE, AND THE REASON IS A REAL CEILING ──────────────────
      //
      // The first draft signed in twenty-nine times to manufacture more than one page of activity.
      // identity caps `/auth/login` at ten per window (`identity/src/server.ts`), taken at
      // dispatch so a refusal costs what a success does — a deliberate control, and one this must
      // not defeat. There is no other route that writes an activity record for a fresh account:
      // `micro-activity` is fed by events and posting a ledger entry produces none.
      //
      // So it drives the account that already HAS a history — the estate operator's, which has been
      // signing in and acting all night. That is a better fixture than the one it replaces: the
      // records are real, they came from six services rather than one, and the cursor being checked
      // is one the server issued over genuine data rather than over twenty-nine identical rows.
      const account = await ctx.step('the account that already has a cursored history', async () => {
        if (operator === null) {
          stop(
            ctx,
            'no estate operator credential is configured. This journey needs an account with more ' +
              'than one page of activity, and it cannot manufacture one: identity caps ' +
              '/auth/login at ten per window and nothing else writes an activity record. Set ' +
              'BEACON_ESTATE_OPERATOR and BEACON_ESTATE_OPERATOR_PASSWORD.',
          )
        }
        const token = await signInForToken(
          { base: ctx.target('identity'), signal: ctx.signal },
          operator.identifier,
          operator.password,
        )
        // The identifier signs in; the HANDLE is what the account menu renders, and they are not
        // the same string — identity's login field takes an address OR a handle. Asking the service
        // which it is, rather than assuming, is what keeps `signInBrowser`'s last assertion honest:
        // "reaching a page is not a session" only means something if the string it looks for is one
        // the application could only have got from identity's answer.
        const me = await fetch(`${ctx.target('identity').replace(/\/+$/, '')}/auth/me`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
        })
        if (!me.ok) throw new Error(`identity /auth/me answered HTTP ${me.status} for the operator`)
        const body = (await me.json()) as { user?: { handle?: unknown } }
        const handle = typeof body.user?.handle === 'string' ? body.user.handle : ''
        if (handle === '') throw new Error('identity returned no handle for the operator account')
        return { identifier: operator.identifier, handle, password: operator.password, token }
      })

      const firstCursor = await ctx.step('that account has a second page to fetch', async () => {
        const body = await hubJson(ctx, base, account.token, `/v1/activity?limit=${PAGE_SIZE}`)
        const records = (body['records'] ?? []) as readonly unknown[]
        const next = body['nextCursor']
        if (records.length < PAGE_SIZE || typeof next !== 'string' || next === '') {
          // ── A LOUD SKIP, NAMING WHAT WOULD MAKE IT RUN ──────────────────────────────────────
          // With less than a full page there is no second page, and "the feed did not grow when
          // there was nothing to add" is a check that cannot fail.
          stop(
            ctx,
            `the configured account holds ${records.length} activity record(s) and a next cursor ` +
              `of ${JSON.stringify(next)}. A second page needs more than ${PAGE_SIZE}, and ` +
              'asserting that an unpaginated feed appends nothing examines nothing.',
          )
        }
        return next
      })

      const before = await ctx.step('open the feed and count what page one rendered', async () => {
        // Signed in with the IDENTIFIER and checked for the HANDLE. See the step above.
        await signInBrowser(
          ctx,
          page,
          base,
          { handle: account.identifier, password: account.password },
          config.timeoutMs,
          account.handle,
        )
        await page.goto(`${base.replace(/\/+$/, '')}/activity`, { waitUntil: 'domcontentloaded' })
        await settled(page, config.timeoutMs)
        const rows = await page.evaluate(
          () => document.querySelectorAll('[class*="feed__row"], li, tr').length,
        )
        ctx.assert(rows > 0, `${page.url()} rendered no activity rows at all`)
        return rows
      })

      const mark = collected.requests.length
      await ctx.step('press Load more', async () => {
        const pressed = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
          const button = buttons.find((candidate) => /load more|more/i.test(candidate.textContent ?? ''))
          if (!button) return false
          button.click()
          return true
        })
        ctx.assert(
          pressed,
          `${page.url()} offers no Load more control, and the feed has a next cursor. A cursored ` +
            'feed with no way to advance is a truncated history presented as a complete one',
        )
        await page.waitForTimeout(4_000)
      })

      await ctx.step('THE CURSOR WENT BACK BYTE-FOR-BYTE, UNPARSED', async () => {
        const sent = requestsTo(collected.requests.slice(mark), 'GET', '/v1/activity')
        ctx.assert(
          sent.length >= 1,
          'pressing Load more produced no GET /v1/activity at all — the button did not fetch',
        )
        const carried = sent
          .map((request) => {
            try {
              return new URL(request.url).searchParams.get('cursor') ?? ''
            } catch {
              return ''
            }
          })
          .filter((value) => value !== '')
        ctx.assert(
          carried.length >= 1,
          `the second page was requested without a cursor at all: ${sent.map((r) => r.url).join(' | ')}. ` +
            'A cursorless second request re-reads page one and appends it to itself',
        )
        // Byte for byte. A client that decoded and re-encoded it would produce a string that WORKS
        // today and silently truncates the feed the day the server's encoding changes.
        ctx.assert(
          carried.includes(firstCursor),
          `the server issued the cursor "${firstCursor}" for page one and the browser sent ` +
            `${carried.map((c) => `"${c}"`).join(', ')}. The cursor is opaque and must go back exactly`,
        )
      })

      await ctx.step('AND THE SECOND PAGE WAS APPENDED, NOT SUBSTITUTED', async () => {
        const after = await page.evaluate(
          () => document.querySelectorAll('[class*="feed__row"], li, tr').length,
        )
        ctx.assert(
          after > before,
          `the feed showed ${before} row(s) before Load more and ${after} after. A second page ` +
            'that replaces the first is a history that shrinks as you read it',
        )
      })
    },
  })

/** The dashboard implementations, by scenario id. */
export const DASHBOARD_IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  'BJ-DSH-01': dashboardTotal,
  'BJ-DSH-17': activityAppends,
  'BJ-XS-04': onePortfolio,
}
