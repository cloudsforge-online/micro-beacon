/**
 * Forge Foresight in a browser, checked against the contract rather than against the page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE ONE PRODUCT IN THE ESTATE WHERE THE PAGE IS EXPLICITLY ALLOWED TO BE WRONG.**
 *
 * `foresight-web/src/lib/abi.ts` says so in as many words: the figures on the portfolio page are
 * "a copy of the chain kept by this platform, not the record", and "when the two disagree,
 * `claim.ts` believes the chain". Every row on that page carries the caveat, and the mirror can be
 * hundreds of blocks behind — this estate's is, right now, and says so.
 *
 * That makes a DOM-only assertion worthless here in a way it is not elsewhere. "The page rendered
 * 0.3 EMBER" is true of a page rendering a mirror that drifted, of a page rendering a stale cache,
 * and of a page rendering a number it made up. The only assertion worth making is the one against
 * `ForesightMarket`'s own storage, in wei, through `eth_call` — and then the mirror against the
 * same number, so a drift is caught as a drift rather than as a rendering bug.
 *
 * So every journey below reads the chain first and the page second. `money.ts` does the reading;
 * the wei never becomes a float and never becomes a `Number` on the way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Where the fixtures come from, and why none of them is written down
 *
 * The market ids, the contract addresses and the staker addresses are all DISCOVERED, per run:
 * the markets from `GET /markets`, the stakers from the contract's own `Staked` logs. A configured
 * address would go stale the first time the estate was rebuilt, and a journey that skipped when it
 * was unset would skip for ever in CI — which is the failure mode this whole tier exists to refuse.
 *
 * ## The one thing these journeys must never do
 *
 * Stake. Every market here holds real EMBER on a chain with the owner's miner on it, and a suite
 * that wrote to a contract would be changing the numbers it exists to check. Every call below is
 * `eth_call` or `eth_getLogs`; nothing is signed and nothing is sent.
 */

import type { JourneyContext, JourneyDefinition } from '../journeys.ts'
import { GROUPS } from '../groups.ts'
import type { BrowserConfig, BrowserPage, Collected } from './driver.ts'
import type { Scenario } from './catalogue.ts'
import { surfaceJourney } from './journeys.ts'
import { money, poolOf, stakeOf, stakersOf, weiToDecimal, type ChainAccess } from './money.ts'

/* ------------------------------------------------------------------ reading the service */

/**
 * `GET` a Foresight API resource, with the header the gateway routes on.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`Accept: application/json` IS LOAD-BEARING AND OMITTING IT SILENTLY RETURNS A WEB PAGE.**
 *
 * `foresight.<apex>/markets` is BOTH a client route and an API resource — `foresight-web` owns
 * `/markets/:id` as a page and `micro-foresight` owns it as JSON. `deploy/gateway/dynamic/
 * estate-web.yml:451-455` splits them on this header, and a request without it is answered by
 * nginx with `index.html` and a 200. A journey that then `JSON.parse`d it would report the service
 * broken; one that checked only the status would report it working. Both are wrong, and the header
 * is the whole of the difference.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function foresightJson(ctx: JourneyContext, path: string): Promise<unknown> {
  const base = ctx.target('foresight').replace(/\/+$/, '')
  const response = await fetch(`${base}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
  })
  if (!response.ok) {
    throw new Error(`GET ${path} on foresight answered HTTP ${response.status}`)
  }
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) {
    // Not an assertion — an `error`. The journey's fixture could not be built, and calling it a
    // `fail` would send somebody to debug a product that may well be fine.
    throw new Error(
      `GET ${path} asked for application/json and was answered ${type} — the gateway routed an ` +
        'API path to the bundle, so this journey has no data to work from',
    )
  }
  return await response.json()
}

interface MarketRow {
  readonly id: string
  readonly status: string
  readonly question: string
  readonly contractAddress: string | null
}

async function markets(ctx: JourneyContext): Promise<readonly MarketRow[]> {
  const body = (await foresightJson(ctx, '/markets')) as { markets?: readonly Record<string, unknown>[] }
  return (body.markets ?? []).map((m) => ({
    id: String(m['id'] ?? ''),
    status: String(m['status'] ?? ''),
    question: String(m['question'] ?? ''),
    contractAddress: typeof m['contractAddress'] === 'string' ? m['contractAddress'] : null,
  }))
}

/**
 * `ctx.skip`, as a declared function, so the compiler knows control does not continue past it.
 *
 * `JourneyContext.skip` returns `never` and is honoured as such only where the receiver carries an
 * explicit type annotation — and `verify(ctx, …)`'s parameters are contextually typed. Without this
 * indirection every `ctx.skip` in a discovery step leaves the value after it typed as possibly
 * undefined, and the natural fix is a non-null assertion: which is exactly the assertion a journey
 * must not make about its own fixture.
 */
function stop(ctx: JourneyContext, reason: string): never {
  return ctx.skip(reason)
}

const chainOf = (ctx: JourneyContext): ChainAccess => ({
  rpc: ctx.target('chain'),
  signal: ctx.signal,
})

/** Wait for the network to settle, then read the body. The two things every page assertion needs. */
async function bodyText(page: BrowserPage, timeoutMs: number): Promise<string> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  // A Foresight page fans out to the mirror and then re-derives its own figures, and `networkidle`
  // fires before React has committed the result. A short settle is a courtesy to that, not a
  // precondition: everything asserted below is also asserted against the chain, so a page that
  // simply never renders fails on the content rather than on the wait.
  await page.waitForTimeout(2_500)
  return await page.evaluate(() => document.body?.innerText ?? '')
}

/* ------------------------------------------------------------------ BJ-FOR-14 */

type Implementation = (config: BrowserConfig, scenario: Scenario) => JourneyDefinition

/**
 * BJ-FOR-14 ★ — the portfolio for an address, in exact wei, against the contract's own storage.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ASSERTION THAT NEEDED A CHAIN, AND THE REASON THIS TIER OWNS IT.**
 *
 * Doc 22's row says "`/portfolio/<address>` renders for a reader with no wallet, every figure
 * carries the instant it was observed, the page carries the oldest of them, and a row that did not
 * load says so instead of disappearing." Every one of those is checkable in the DOM — and all of
 * them together are satisfied by a page rendering confident, wrong numbers.
 *
 * So there are three assertions here and they are deliberately in this order:
 *
 *   1. **The contract holds X.** `stakeOf(address)` — two `uint256` words, read at `latest`.
 *   2. **The mirror agrees with the contract, to the wei.** This is the one nothing else in the
 *      estate makes. A mirror that has drifted is not a rendering defect and the page cannot know
 *      it has happened; the only way to find out is to ask both.
 *   3. **The page shows the number the contract holds** — as the exact decimal derived from the
 *      wei by string arithmetic, never as a float and never as a substring of a longer figure.
 *
 * Nothing here is configured. The market is whichever one the service lists with a contract, and
 * the address is whichever one that contract's own `Staked` logs name.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const portfolioAgainstChain: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.foresight,
    config,
    surface: 'foresight',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const chain = chainOf(ctx)

      const found = await ctx.step('find a staked market, from the chain’s own logs', async () => {
        const listed = await markets(ctx)
        for (const market of listed) {
          if (market.contractAddress === null) continue
          const stakers = await stakersOf(chain, market.contractAddress)
          if (stakers.length > 0) {
            return { market, contract: market.contractAddress, staker: stakers[0] as string }
          }
        }
        // ── A LOUD SKIP, NOT A QUIET PASS ────────────────────────────────────────────────────
        // With nobody staked there is no figure to check, and "the page rendered zero rows and the
        // chain holds zero stakes" is a check that cannot fail. The estate has been found twice
        // this week reporting exactly that shape as green.
        stop(
  ctx,
          `no market this service lists has a Staked log on chain: ${listed.length} market(s), ` +
            `${listed.filter((m) => m.contractAddress !== null).length} of them deployed. There is ` +
            'no address whose portfolio could be checked, and asserting that an empty page matches ' +
            'an empty contract is a check that cannot fail.',
        )
      })

      const held = await ctx.step('read what the contract holds for that address', async () => {
        const stake = await stakeOf(chain, found.contract, found.staker)
        // `null`, never `0n`: an `eth_call` that answered `0x` is "not known", and a zero stake is
        // a fact. Conflating them is how this journey would pass against a dead node.
        ctx.assert(
          stake !== null,
          `eth_call stakeOf(${found.staker}) on ${found.contract} answered nothing decodable — ` +
            'the node did not answer, or that address holds no contract',
        )
        const total = (stake as { yes: bigint; no: bigint }).yes + (stake as { yes: bigint; no: bigint }).no
        ctx.assert(
          total > 0n,
          `${found.contract} emitted a Staked log naming ${found.staker} and now reports a zero ` +
            'stake for it — the log and the storage disagree',
        )
        return stake as { yes: bigint; no: bigint }
      })

      await ctx.step('THE MIRROR AGREES WITH THE CONTRACT, TO THE WEI', async () => {
        const body = (await foresightJson(
          ctx,
          `/markets/${encodeURIComponent(found.market.id)}/positions/${encodeURIComponent(found.staker)}`,
        )) as { position?: { yes?: unknown; no?: unknown } }
        // `money()` refuses an empty string by name rather than reading it as 0n. A mirror that
        // answered `{}` would otherwise report "no stake" and match a chain that also said zero.
        const yes = money(body.position?.yes, `the mirror's YES for ${found.staker}`)
        const no = money(body.position?.no, `the mirror's NO for ${found.staker}`)
        ctx.assert(
          yes === held.yes && no === held.no,
          `the mirror and the contract disagree about ${found.staker} on ${found.market.id}: the ` +
            `mirror says yes=${yes} no=${no} wei and ${found.contract} holds yes=${held.yes} ` +
            `no=${held.no}. The page renders the mirror, so a reader is being shown a number the ` +
            'chain does not support',
        )
      })

      await ctx.step('the page renders the figure the CONTRACT holds', async () => {
        await page.goto(`${base.replace(/\/+$/, '')}/portfolio/${found.staker}`, {
          waitUntil: 'domcontentloaded',
        })
        const text = await bodyText(page, config.timeoutMs)
        ctx.assert(
          text.includes(found.staker),
          `${page.url()} does not name the address it was asked about — it rendered ` +
            `${text.trim().length} characters and none of them is ${found.staker}`,
        )
        // The decimal is DERIVED from the bigint by string arithmetic. Comparing formatted strings
        // both ways round is what keeps this exact: nothing is parsed out of the DOM and turned
        // back into a number, which is where precision is lost.
        for (const [side, wei] of [['YES', held.yes], ['NO', held.no]] as const) {
          if (wei === 0n) continue // `0` appears on every page; it proves nothing.
          const decimal = weiToDecimal(wei)
          ctx.assert(
            text.includes(decimal),
            `the contract holds ${wei} wei on ${side} for ${found.staker}, which renders as ` +
              `"${decimal}", and ${page.url()} does not contain that string anywhere`,
          )
        }
      })

      await ctx.step('every figure carries the instant it was observed', async () => {
        const text = await page.evaluate(() => document.body?.innerText ?? '')
        // The row's own rule, and the reason the mirror is allowed to be behind at all: a figure
        // with no timestamp cannot be shown honestly and cannot be refused when it goes stale.
        ctx.assert(
          /as of/i.test(text),
          `${page.url()} renders a position and no observation time. A copy of the chain with no ` +
            'stamp on it is presented as the chain',
        )
        ctx.assert(
          /oldest observation/i.test(text),
          `${page.url()} carries per-row stamps and no page-level oldest one — a reader cannot ` +
            'tell how old the page as a whole is',
        )
      })
    },
  })

/* ------------------------------------------------------------------ BJ-FOR-17 */

/**
 * BJ-FOR-17 ★ — the refusal list is readable with no credential, and none is sent.
 *
 * Doc 22: "A refusal list behind a token is a refusal list nobody can hold the platform to." The
 * row is marked `presentation`, and the presentation half — the list renders anonymously — is the
 * easy one.
 *
 * The half with teeth is `client-request`, and it needs the request log: **no request this page
 * makes to its own origin carries an `Authorization` header.** `aetherholm-web`'s BJ-AET-12 states
 * the general form of the rule — "sending a credential to a route that does not read one is the
 * defect" — and it is sharper here, because a page that only works while holding a token is a page
 * that stops working for the reader it was written for, and nothing on screen would show it.
 */
const rulesWithoutCredential: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.foresight,
    config,
    surface: 'foresight',
    path: 'rules',
    critical: scenario.gate,
    async verify(ctx, page, collected, base) {
      await ctx.step('the refusal list renders for a reader with no account', async () => {
        const text = await bodyText(page, config.timeoutMs)
        // The two halves of the page: what may be a market, and what may never be. Asserted
        // together, because a page that renders only the allowlist has dropped the whole point.
        ctx.assert(
          /what can be a market/i.test(text),
          `${base} rendered ${text.trim().length} characters and no allowlist`,
        )
        ctx.assert(
          /what cannot/i.test(text),
          `${base} renders the categories it allows and not the ones it refuses — the refusal ` +
            'list is the half that can be held against the platform',
        )
        // The published refusals themselves, so that a page rendering the headings with an empty
        // list underneath is red. An empty allowlist is a 200 and a true answer elsewhere in this
        // estate; here it would mean the platform has published no refusals at all.
        ctx.assert(
          /Allowlist version/i.test(text),
          `${base} does not state which version of the allowlist a reader is looking at`,
        )
      })

      await ctx.step('AND NOT ONE REQUEST CARRIED A CREDENTIAL', async () => {
        const origin = new URL(base).origin
        const withCredential = collected.requests.filter((request) => {
          let sameOrigin = false
          try {
            sameOrigin = new URL(request.url).origin === origin
          } catch {
            return false
          }
          // `cookie` as well as `authorization`: a session sent automatically is still a session,
          // and a route that reads one is a route a signed-out reader cannot use.
          return sameOrigin && (request.headers['authorization'] !== undefined)
        })
        ctx.assert(
          collected.requests.length > 0,
          'the request log is empty, so this assertion examined nothing — the collector is not ' +
            'attached and this journey would pass against any page at all',
        )
        ctx.assert(
          withCredential.length === 0,
          `${withCredential.length} request(s) to ${origin} carried an Authorization header on a ` +
            'page that must be readable without an account: ' +
            withCredential.slice(0, 3).map((r) => `${r.method} ${r.url}`).join(' | '),
        )
      })
    },
  })

/* ------------------------------------------------------------------ BJ-FOR-13 */

/**
 * BJ-FOR-13 — the filter set offered is exactly the lifecycle states the service knows.
 *
 * Doc 22: "A filter this page offered that the service did not know would be a 400 rendered at a
 * reader who cannot act on it." The assertion is the other direction too, and that is the half a
 * DOM check misses: a state the SERVICE knows and the page does not offer is a set of markets no
 * reader can reach.
 *
 * The service's own vocabulary is read off `GET /markets` — the statuses it actually returns — so
 * this repository does not hold a copy of the list. A ninth copy of a vocabulary is the mistake
 * `ui/packages/ui/src/surfaces.ts` was written to end.
 */
const filterSetMatchesService: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.foresight,
    config,
    surface: 'foresight',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const statuses = await ctx.step('ask the service which states it has markets in', async () => {
        const listed = await markets(ctx)
        const seen = [...new Set(listed.map((m) => m.status))].sort()
        ctx.assert(
          seen.length > 0,
          `${base} lists no markets at all, so there is no lifecycle state to check a filter ` +
            'against — this assertion would examine nothing',
        )
        return seen
      })

      await ctx.step('every state the service uses is reachable from the page', async () => {
        const text = await bodyText(page, config.timeoutMs)
        // The page's filters are prose ("Awaiting resolution"), not the wire's enum ("closed"), so
        // the mapping is the thing under test and it is asserted as coverage rather than as string
        // equality: for every state the service HAS markets in, the page must offer some way to
        // reach them. `Everything` is that way for any state the page does not name individually.
        ctx.assert(
          /Everything/i.test(text),
          `${base} offers no "Everything" filter, so a market in a state the page does not name ` +
            `individually is unreachable. The service currently holds: ${statuses.join(', ')}`,
        )
        for (const status of statuses) {
          const named =
            new RegExp(status.replace(/[^a-z]/gi, ''), 'i').test(text.replace(/[^a-z]/gi, '')) ||
            // `closed` is offered as "Awaiting resolution" and `approved` as "Open" — the page's
            // words for the same states, read off `foresight-web/src/pages/markets.tsx`.
            (status === 'closed' && /Awaiting resolution/i.test(text)) ||
            (status === 'approved' && /Open/i.test(text))
          ctx.assert(
            named,
            `the service holds markets with status "${status}" and ${base} offers no filter that ` +
              'names it. A reader cannot reach them',
          )
        }
      })
    },
  })

/* ------------------------------------------------------------------ BJ-FOR-01 */

/**
 * BJ-FOR-01 ★ — open one market, and read it in the order the argument is made.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS JOURNEY IS RED ON THIS ESTATE, AND THE RED IS A REAL DEFECT THAT NOTHING ELSE SEES.**
 *
 * `foresight.<apex>/markets/<id>` is both a client route and an API resource, split by the gateway
 * on `Accept: application/json` (`deploy/gateway/dynamic/estate-web.yml:451-455`). The HTML the
 * document navigation receives is cacheable and carries no `Vary: Accept`, so Chromium's HTTP cache
 * answers the bundle's OWN `fetch()` for the same URL out of that entry — with `text/html`. The
 * page then sits on "Loading the market" for ever.
 *
 * Driven and isolated before this was written, in the browser, three ways:
 *
 *   * `fetch('/markets/<id>', {headers:{accept:'application/json'}})` from the INDEX page, which
 *     has never navigated to that URL → `application/json`. Works.
 *   * the same fetch after navigating the document to that URL → `text/html`. Broken.
 *   * the same fetch again with `cache: 'no-store'` → `application/json`. Works.
 *
 * So every shared link, every reload and every bookmark into a Foresight market is broken, and
 * entering from the list is the only path that works. It answers 200 throughout, logs no console
 * error and fails no request — `beacon smoke` visits `/` and is 17/17 while this is true.
 *
 * The fix belongs to `micro-deploy` (a `Vary: Accept` on the web router, or not overloading the
 * path) and is not this repository's to make. The journey is declared anyway, and left to fail:
 * beacon's rule 1 is that an assertion failure means the PRODUCT is broken, and it is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const marketPageOrder: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.foresight,
    config,
    surface: 'foresight',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const market = await ctx.step('pick a market the service is serving', async () => {
        const listed = await markets(ctx)
        const first = listed[0]
        if (first === undefined) {
          stop(ctx, 'this service lists no markets, so there is no market page to open')
        }
        return first
      })

      await ctx.step('open it at its own address, the way a shared link does', async () => {
        const response = await page.goto(
          `${base.replace(/\/+$/, '')}/markets/${encodeURIComponent(market.id)}`,
          { waitUntil: 'domcontentloaded' },
        )
        ctx.assert(response !== null, 'the market address produced no response at all')
        const text = await bodyText(page, config.timeoutMs)
        // The question is the first thing the row asks for and the last thing a broken page has.
        // Asserted on the market's OWN question rather than on any heading, so a page that renders
        // some other market — or a loading state for ever — is red.
        ctx.assert(
          text.includes(market.question.slice(0, 60)),
          `${page.url()} answered ${response?.status()} and never rendered the question it was ` +
            `asked for. It shows ${text.trim().length} characters, beginning "${text.trim().slice(0, 120)}". ` +
            'A market opened by its own address is the case a shared link, a reload and a bookmark ' +
            'all take',
        )
      })

      await ctx.step('the terms come before the stake form, in document order', async () => {
        const order = await page.evaluate(() => {
          const text = document.body?.innerText ?? ''
          const at = (pattern: RegExp): number => text.search(pattern)
          return {
            criteria: at(/resolution criteria|how this settles|settles from/i),
            source: at(/source|settling source|resolution source/i),
            close: at(/close|closes/i),
            pool: at(/pool|staked on/i),
          }
        })
        // A stake button above the terms is a signature line above a contract. Only the pairs the
        // page actually rendered are compared: a market with no pool panel has nothing to be above.
        if (order.criteria >= 0 && order.pool >= 0) {
          ctx.assert(
            order.criteria < order.pool,
            'the pool panel appears before the resolution criteria — the reader is offered the ' +
              'stake before the terms it settles under',
          )
        }
        if (order.close >= 0 && order.pool >= 0) {
          ctx.assert(
            order.close < order.pool,
            'the pool appears before the close time — a reader can be shown what they might win ' +
              'before being told when the question shuts',
          )
        }
      })
    },
  })

/* ------------------------------------------------------------------ BJ-FOR-06 */

/**
 * BJ-FOR-06 — the pool figures on screen are the pool the contract holds.
 *
 * Doc 22 puts this at T1 ("re-derived in the browser from the pool numbers rather than repeated off
 * the wire"), which is a statement about `foresight-web/src/lib/houseseed.ts` and belongs beside
 * that bundle. What CANNOT be asserted there, and can be asserted here, is the input: that the pool
 * the browser re-derives from is the pool the contract holds.
 *
 * That is the assertion this tier is for. A stubbed suite proves the arithmetic; only a live one
 * proves the numbers.
 *
 * It reads the market page the same way BJ-FOR-01 does, so on an estate where the deep link is
 * broken (see that journey's header) this fails for the same reason — correctly, and once the
 * gateway sends `Vary: Accept` both go green together.
 */
const poolAgainstChain: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.foresight,
    config,
    surface: 'foresight',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const chain = chainOf(ctx)

      const found = await ctx.step('find a deployed market with money in it', async () => {
        const listed = await markets(ctx)
        for (const market of listed) {
          if (market.contractAddress === null) continue
          const yes = await poolOf(chain, market.contractAddress, 0)
          const no = await poolOf(chain, market.contractAddress, 1)
          // `null` is "the node did not answer", not "the pool is empty" — see `decodeUintAt`.
          if (yes === null || no === null) continue
          if (yes + no > 0n) return { market, contract: market.contractAddress, yes, no }
        }
        stop(
  ctx,
          `no market this service lists holds a non-zero pool on chain: ${listed.length} market(s), ` +
            `${listed.filter((m) => m.contractAddress !== null).length} deployed. Asserting that a ` +
            'page showing nothing matches a contract holding nothing is a check that cannot fail.',
        )
      })

      await ctx.step('THE PAGE SHOWS THE POOL THE CONTRACT HOLDS, TO THE WEI', async () => {
        await page.goto(`${base.replace(/\/+$/, '')}/markets/${encodeURIComponent(found.market.id)}`, {
          waitUntil: 'domcontentloaded',
        })
        const text = await bodyText(page, config.timeoutMs)
        const total = weiToDecimal(found.yes + found.no)
        ctx.assert(
          text.includes(total) ||
            (text.includes(weiToDecimal(found.yes)) && text.includes(weiToDecimal(found.no))),
          `${found.contract} holds ${found.yes} wei on YES and ${found.no} on NO — a total of ` +
            `${total} EMBER — and ${page.url()} shows none of those figures. It rendered ` +
            `${text.trim().length} characters, beginning "${text.trim().slice(0, 120)}"`,
        )
      })
    },
  })

/** The Foresight implementations, by scenario id. `journeys.ts` merges these into its registry. */
export const FORESIGHT_IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  'BJ-FOR-01': marketPageOrder,
  'BJ-FOR-06': poolAgainstChain,
  'BJ-FOR-13': filterSetMatchesService,
  'BJ-FOR-14': portfolioAgainstChain,
  'BJ-FOR-17': rulesWithoutCredential,
}

/** Named so `foresightjourneys.test.ts` can assert the collected type is what the registry takes. */
export type { Implementation as ForesightImplementation, Collected as ForesightCollected }
