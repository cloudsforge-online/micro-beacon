/**
 * Turning the catalogue into journeys — and refusing to, for anything that cannot run.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DECLARATION IS COMPUTED, NEVER WRITTEN DOWN.**
 *
 * `browserJourneys()` returns a journey for a scenario only when all three of these are true:
 *
 *   1. the scenario carries no permanent blocker (`catalogue.ts`),
 *   2. every surface and service it needs has an address in `BEACON_TARGETS`,
 *   3. an implementation for it exists in this file.
 *
 * For a long time condition 2 was false for EVERY scenario, because
 * `deploy/compose/docker-compose.estate.yml` served no frontend container. It now serves sixteen,
 * on ports recomputed from micro-org's registry, behind a gateway on the hostnames the shared UI
 * derives. So the function returns something for the first time — mechanically, with no code
 * change to make it do so, which is the whole point of computing it.
 *
 * The third condition is the honest one, and it is where the remaining gap lives. Thirty-one of
 * the eighty-seven T3 scenarios are still blocked by a missing screen in doc 22 §8.2-§8.6 and
 * cannot be written at all. Of the fifty-six that are not, four are implemented here; the other
 * fifty-two are named one line at a time by `unimplemented()` rather than quietly omitted, because
 * an absent scenario is a gap nobody can see.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why only four, when fifty-six are unblocked
 *
 * Because a journey is only worth declaring if it can be GREEN when the product is right and RED
 * when it is not, and several of the fifty-two fail the first half today for reasons that are not
 * defects in what they test:
 *
 *   * **The four `BJ-NET-*` explorer scenarios need a chain.** `INDEXER_CHAINS` is unset in the
 *     estate, so the indexer follows nothing and answers 404 for every scope;
 *     `explorer.<apex>/chains` renders "This scope could not be read." eight times, which is the
 *     page correctly showing what its index reports. A journey asserting reorg depth or a block's
 *     transactions there would skip or fail for ever. Driven, not assumed.
 *   * **`BJ-NET-09` needs the faucet**, which is not a service in the estate compose file. That one
 *     is already handled by condition 2 — it has no address and cannot declare itself.
 *
 * Adding an implementation is one entry in `IMPLEMENTATIONS` plus the function. The catalogue is
 * deliberately not the place that decides.
 *
 * ## How a surface gets an address
 *
 * Through `ctx.target`, from `BEACON_TARGETS`, exactly as a service does — `site=https://…`,
 * `hub=https://…`. Three consequences, all of them wanted:
 *
 *   * **This repository never restates the surface registry.**
 *     `ui/packages/ui/src/surfaces.ts` carries a header recording that the same list of hostnames
 *     was maintained by hand in eight places and had already drifted. A ninth copy, in the service
 *     whose job is to notice drift, would be that mistake made where it does the most damage.
 *   * **A surface with no address is a skip with a reason**, which is what `ctx.target` already
 *     does for a service this deployment does not run.
 *   * **The address is a real public hostname, never a compose-network name.** Loading
 *     `http://site:80` would work — nginx answers — and the page would then derive its API hosts
 *     from the hostname `site`, call `https://nimbus.site`, and fail for a reason that has nothing
 *     to do with the product. That is a wrong answer wearing the costume of a real failure, which
 *     is worse than a skip.
 *
 * `account` is a surface key like any other and resolves to wherever the sign-in page is served.
 * Today that is `hub.<apex>/account` — a PATH under another surface, which is exactly why the
 * address is configured rather than derived: the registry moved the sign-in surface onto Hub and
 * nothing here had to know.
 */

import type { JourneyContext, JourneyDefinition } from '../journeys.ts'
import { GROUPS } from '../groups.ts'
import {
  assertClean,
  assertRendered,
  browserAvailable,
  withPage,
  type BrowserConfig,
  type BrowserPage,
  type Collected,
  type ExpectedFailure,
} from './driver.ts'
import { T3_SCENARIOS, type Scenario } from './catalogue.ts'
import { FORESIGHT_IMPLEMENTATIONS } from './foresightjourneys.ts'
import { WALLET_IMPLEMENTATIONS } from './walletjourneys.ts'
import { DASHBOARD_IMPLEMENTATIONS } from './dashboardjourneys.ts'
import type { Operator } from './fixtures.ts'

/**
 * The fifteen surface keys, and nothing else about them.
 *
 * Keys only — no hostname, no port, no apex rule. Beacon needs to know that `hub` names a bundle
 * and `hub-api` names a service so that a missing bundle can say "no address for the hub surface"
 * rather than "no address for hub"; it does not need, and must not hold, a copy of where any of
 * them lives. Read out of doc 22 §5, which read them out of each repository's `src/app.tsx`.
 */
export const SURFACE_KEYS: readonly string[] = [
  'hub',
  'market',
  'trade',
  'worlds',
  'create',
  'admin',
  'status',
  'explorer',
  'developers',
  'foresight',
  'foresight-admin',
  'emberkin',
  'aetherholm',
  'site',
  'network',
  // Not one of the fifteen bundles: `account` is the sign-in surface doc 22 §8.1 records as not
  // existing anywhere in the estate. It is named here so a scenario can declare that it needs one,
  // and so the absence is a resolvable name rather than a silence.
  'account',
]

/* ------------------------------------------------------------------ the shared shape */

export interface SurfaceJourneyOptions {
  readonly name: string
  readonly title: string
  readonly productGroup: string
  readonly critical?: boolean
  /** The surface key, resolved through `ctx.target`. */
  readonly surface: string
  readonly config: BrowserConfig
  /**
   * A path under the surface's base, when the scenario starts somewhere other than the index.
   *
   * Joined rather than concatenated: `account` resolves to `hub.<apex>/account` today, so a naive
   * `base + path` would produce `…/account/register` correctly and `…/accountregister` the day the
   * address gains or loses a trailing slash. One of those is a 404 that reads as a missing route.
   */
  readonly path?: string
  /**
   * The exchanges this scenario expects the estate to refuse. See `ExpectedFailure`.
   *
   * A refusal scenario's 4xx arrives in the same bucket as a 404ing chunk, so it has to be
   * declared or the journey can never be green.
   */
  readonly expected?: readonly ExpectedFailure[]
  /** Anything this scenario asserts beyond "the application mounted". */
  readonly verify?: (
    ctx: JourneyContext,
    page: BrowserPage,
    collected: Collected,
    base: string,
  ) => Promise<void>
}

/**
 * The shape every browser journey shares: load it, prove it mounted, then assert the scenario.
 *
 * Carried forward from `stack/infra/beacon/src/journeys/web.js:19`, which is the design doc 22
 * §2.3 says is being re-adopted rather than invented. The two assertions in `the application
 * boots` are the whole reason a browser is here at all:
 *
 *   * **`domcontentloaded` fires whether or not the bundle exists**, so waiting for it proves
 *     nginx is running. `networkidle` is no better — a bundle that 404s leaves the network
 *     perfectly idle. The assertion has to be about content the application produced, which is
 *     what `assertRendered` is.
 *   * **A page can render and still be broken.** `assertClean` fails on an uncaught exception or
 *     a failed request, which is how a CORS regression or a missing chunk is caught while every
 *     server-side probe stays green.
 */
export function surfaceJourney(options: SurfaceJourneyOptions): JourneyDefinition {
  return {
    name: options.name,
    title: options.title,
    productGroup: options.productGroup,
    // The surface key, which for a browser journey IS the owning service: what this asserts is
    // that one bundle mounted and stayed clean, so a red belongs to whatever serves that bundle
    // and not to the APIs it happened to call. These journeys are driven by `beacon browser` and
    // are not in the scheduled registry, so none of them currently carries an SLO — the field is
    // set correctly anyway rather than left to be guessed at the moment one does.
    service: options.surface,
    critical: options.critical ?? false,
    // Generous, and its own rather than the global 90s: launching Chromium, loading a bundle and
    // waiting for a SPA to mount is not comparable to a JSON round trip, and sharing one deadline
    // would either make browser journeys flaky or make HTTP journeys slow to report.
    deadlineMs: 120_000,
    async run(ctx) {
      const availability = await browserAvailable(options.config)
      if (!availability.ok) ctx.skip(availability.reason)
      const base = join(ctx.target(options.surface), options.path ?? '')

      await withPage(options.config, async (page, collected) => {
        await ctx.step('load the page', async () => {
          const response = await page.goto(base, { waitUntil: 'domcontentloaded' })
          ctx.assert(response !== null, `no response at all from ${base}`)
          ctx.assert(
            (response as { ok(): boolean; status(): number }).ok(),
            `${base} returned HTTP ${(response as { status(): number }).status()}`,
          )
        })

        await ctx.step('the application boots', async () => {
          // Best effort. A surface that polls forever never reaches networkidle, and waiting for
          // it is a courtesy to a slow mount rather than a precondition of the assertion.
          await page
            .waitForLoadState('networkidle', { timeout: options.config.timeoutMs })
            .catch(() => {})
          const text = await page.evaluate(() => document.body?.innerText ?? '')
          const rendered = assertRendered(text, collected, base)
          ctx.assert(rendered.ok, rendered.reason)
          const clean = assertClean(collected, options.name, options.expected ?? [])
          ctx.assert(clean.ok, clean.reason)
        })

        if (options.verify) await options.verify(ctx, page, collected, base)
      })
    },
  }
}

/* ------------------------------------------------------------------ the implementations */

/**
 * ── THE THIRD ARGUMENT IS THE ESTATE OPERATOR'S CREDENTIAL, AND IT IS ALWAYS NULLABLE ─────────
 *
 * A money journey has to put a balance on an account before it can assert anything about one,
 * and identity refuses `POST /service-tokens` to an ordinary account (403) — which
 * `deploy/scripts/estate-verify.sh:121-123` records as the deliberate gap it is. So seeding needs
 * a credential that is configuration, never a default.
 *
 * `null` is the ordinary case and is handled by SKIPPING with the variable named, not by falling
 * back to an empty account: "the page showed nothing and the ledger holds nothing" is a check
 * that cannot fail. Every implementation that does not need one simply ignores the argument.
 */
type Implementation = (
  config: BrowserConfig,
  scenario: Scenario,
  operator: Operator | null,
) => JourneyDefinition

/**
 * Join a configured base with a path, without producing `…/accountregister` or `…//register`.
 *
 * Exported so `journeys.test.ts` can pin it. `account` resolves to `hub.<apex>/account` — a path
 * under another surface — so this is load-bearing rather than tidiness.
 */
export function join(base: string, path: string): string {
  if (path === '') return base
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * A credential nobody else will use, derived from the run.
 *
 * Beacon registers REAL accounts against identity, exactly as `deploy/scripts/estate-verify.sh`
 * does. Two rules make that safe to run on a schedule: the identifier carries the run id, so two
 * replicas can never collide on a handle and turn a passing journey red; and the domain is
 * `.test`, which RFC 2606 reserves and no resolver will ever route mail to.
 *
 * The handle is `[a-z0-9]` only and 20 characters — identity's own handle rule is the thing under
 * test in BJ-ACC-02, and a fixture that trips it would assert the wrong refusal.
 */
function synthetic(ctx: JourneyContext): { email: string; handle: string; password: string } {
  const id = ctx.runId.replace(/-/g, '').slice(0, 14)
  return {
    email: `bj-${id}@example.test`,
    handle: `bj${id}`,
    // Long, and constant: it is not a secret — it guards an account that exists for ninety
    // seconds — and generating it would put a random value in a failure message for no gain.
    password: 'correct-horse-battery-staple-42',
  }
}

/** Register over HTTP, for the scenarios whose assertion is about what happens AFTER an account exists. */
async function seedAccount(
  ctx: JourneyContext,
  who: { email: string; handle: string; password: string },
): Promise<void> {
  const identity = ctx.target('identity')
  const response = await fetch(`${identity}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
  })
  // An `error`, not an assertion: this is the FIXTURE. A journey that cannot build its own
  // precondition has not demonstrated anything about the product, and calling it `fail` would
  // send somebody to debug a sign-in page that is fine.
  if (!response.ok) {
    throw new Error(
      `could not seed an account at ${identity}/auth/register (HTTP ${response.status}) — ` +
        'this is the journey’s fixture, not the product',
    )
  }
}

/**
 * BJ-ACC-01 ★ — register from the sign-in surface and land back with a session.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SCENARIO DOC 22 §8.1 CALLED THE LARGEST BLOCKER IN THE CATALOGUE, NOW DRIVEN.**
 *
 * `signInRedirect()` sends every signed-out visitor of every product to `${accountUrl()}/login`.
 * That resolved `account.<apex>`, which no repository served and which micro-identity refuses to
 * render HTML for. micro-ui moved the `signin` row onto Hub and micro-hub-web serves the page; this
 * is the assertion that the two halves meet in a real browser.
 *
 * The last step is the one that matters. `assertRendered` would pass on the sign-in page itself,
 * so "the form is on screen" is not evidence of a session. What is: the browser is no longer on an
 * `/account/*` path, AND the page renders the handle the form was given — a string the application
 * can only have got from identity's answer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const registerAndLand: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.account,
    config,
    surface: 'account',
    path: 'register',
    critical: scenario.gate,
    async verify(ctx, page, collected, base) {
      const who = synthetic(ctx)

      await ctx.step('fill the registration form the estate serves', async () => {
        // By NAME, which is the attribute hub-web's own inputs carry
        // (hub-web/src/pages/account.tsx:434,455,479) and the one a form post would use. A CSS
        // class or a nth-child would be a selector that breaks on a restyle and reports it as an
        // outage.
        await page.fill('input[name=email]', who.email)
        await page.fill('input[name=handle]', who.handle)
        await page.fill('input[name=password]', who.password)
      })

      await ctx.step('press Create account and leave the sign-in surface', async () => {
        await page.click('button[type=submit]')
        // The predicate is "no longer on an /account path", not "is at the root": `?return=` can
        // send the browser anywhere, and pinning the destination here would make this scenario a
        // duplicate of BJ-ACC-03 that breaks whenever a default changes.
        await page.waitForURL((url) => !url.pathname.startsWith('/account'), {
          timeout: config.timeoutMs,
        })
      })

      await ctx.step('the surface it landed on renders the account it just created', async () => {
        await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {})
        const text = await page.evaluate(() => document.body?.innerText ?? '')
        const rendered = assertRendered(text, collected, page.url())
        ctx.assert(rendered.ok, rendered.reason)
        // The handle is the evidence. It is not on the page this journey typed it into — the
        // browser navigated — so it can only have arrived through identity's answer and the
        // shared account menu. A length check alone would pass against a signed-OUT page.
        ctx.assert(
          text.includes(who.handle),
          `${page.url()} rendered ${text.trim().length} characters and none of them is the handle ` +
            `"${who.handle}" that was just registered from ${base} — the browser left the sign-in ` +
            'surface without a session',
        )
      })
    },
  })

/**
 * BJ-ACC-02 — register with a taken handle: the inline error, and every other field kept.
 *
 * A refusal scenario, so `ownedBy` names identity's own test and this asserts only the SENTENCE the
 * user is shown. The second half is the part with a cost attached:
 * `hub-web/src/pages/account.tsx:410-413` records it — "a form that clears on a taken handle is the
 * failure BJ-ACC-02 exists to catch: the user retypes an address and a password they had right, to
 * fix one word."
 *
 * The 409 is declared through `expected`, because it IS the assertion.
 */
const takenHandle: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.account,
    config,
    surface: 'account',
    path: 'register',
    critical: scenario.gate,
    expected: [{ path: '/auth/register', status: 409 }],
    async verify(ctx, page, _collected, base) {
      const taken = synthetic(ctx)
      await ctx.step('take a handle, over HTTP, so the browser meets it already taken', async () => {
        await seedAccount(ctx, taken)
      })

      // A DIFFERENT email with the SAME handle: the point is that the refusal is about one field
      // and the form keeps the other two.
      const second = `second-${taken.email}`
      await ctx.step('submit the form with that handle and a different address', async () => {
        await page.fill('input[name=email]', second)
        await page.fill('input[name=handle]', taken.handle)
        await page.fill('input[name=password]', taken.password)
        await page.click('button[type=submit]')
        await page.waitForTimeout(3_000)
      })

      await ctx.step('the refusal is rendered, and the browser stayed on the form', async () => {
        ctx.assert(
          page.url().includes('/account/register'),
          `a refused registration navigated to ${page.url()} — the form must stay where it is`,
        )
        const alert = await page.evaluate(
          () =>
            Array.from(document.querySelectorAll('[role="alert"]'))
              .map((n) => (n as HTMLElement).innerText ?? '')
              .join(' · '),
        )
        // The sentence must EXIST and must be the server's. This asserts presence and origin, not
        // wording: doc 22 §3.1 forbids a browser scenario from asserting the rule, and pinning
        // identity's exact prose here would be that rule copied into this repository.
        ctx.assert(
          alert.trim().length > 0,
          `${base} refused the registration and rendered no role="alert" at all — the user is ` +
            'looking at a form that did nothing',
        )
      })

      await ctx.step('EVERY OTHER FIELD KEPT WHAT WAS TYPED', async () => {
        const kept = await page.evaluate(() => ({
          email: (document.querySelector('input[name=email]') as HTMLInputElement | null)?.value ?? '',
          handle: (document.querySelector('input[name=handle]') as HTMLInputElement | null)?.value ?? '',
          password:
            (document.querySelector('input[name=password]') as HTMLInputElement | null)?.value ?? '',
        }))
        ctx.assert(kept.email === second, `the email field was cleared or changed (got "${kept.email}")`)
        ctx.assert(kept.handle === taken.handle, `the handle field was cleared (got "${kept.handle}")`)
        // Asserted by LENGTH. A journey must not put a password in a failure message, and the
        // length is the whole of what "it was kept" means here.
        ctx.assert(
          kept.password.length === taken.password.length,
          `the password field was cleared — ${kept.password.length} characters remain, not ${taken.password.length}`,
        )
      })
    },
  })

/**
 * BJ-ACC-03 ★ — sign in from a protected deep link and arrive at the deep link.
 *
 * The scenario that catches the regression everything else misses: sign-in works, and every
 * protected address a user was sent silently becomes the dashboard. It is `navigation`, so it
 * asserts one thing — where the browser ended up — and nothing about what that page then shows.
 *
 * It starts at `hub`, not at `account`: the point is that the REDIRECT happens, so being handed the
 * sign-in address would delete half the test.
 */
const deepLinkSignIn: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.account,
    config,
    surface: 'hub',
    // An address hub-web enumerates and guards. Read off its own route table rather than invented:
    // an address the surface does not own would 404 and the journey would assert the redirect a
    // not-found page happens to make.
    path: 'security',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const who = synthetic(ctx)
      await ctx.step('an account exists, seeded over HTTP', async () => {
        await seedAccount(ctx, who)
      })

      // Re-visited AFTER seeding: `surfaceJourney` already loaded `base` once, and that load is
      // the one whose redirect is being asserted. Loading it again costs a page load and removes
      // any question about ordering.
      const landed = await ctx.step('a protected deep link sends a signed-out browser to sign in', async () => {
        await page.goto(base, { waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {})
        const here = new URL(page.url())
        ctx.assert(
          here.pathname.startsWith('/account/login'),
          `${base} did not send a signed-out browser to the sign-in surface — it stayed at ${page.url()}`,
        )
        // The deep link has to be CARRIED. Without this the next step could pass by luck on a
        // surface whose post-sign-in default happened to be the same path.
        const carried = here.searchParams.get('return') ?? ''
        ctx.assert(
          carried.endsWith('/security'),
          `the sign-in redirect carried return="${carried}", which does not name the deep link`,
        )
        return carried
      })

      await ctx.step('sign in, and ARRIVE AT THE DEEP LINK rather than at the root', async () => {
        await page.fill('input[name=identifier]', who.handle)
        await page.fill('input[name=password]', who.password)
        await page.click('button[type=submit]')
        await page.waitForURL((url) => !url.pathname.startsWith('/account'), {
          timeout: config.timeoutMs,
        })
        const arrived = new URL(page.url())
        ctx.assert(
          arrived.pathname === new URL(landed).pathname,
          `signed in from a deep link to ${landed} and arrived at ${page.url()} instead`,
        )
      })
    },
  })

/**
 * BJ-XS-10 ★ — every entry in the rendered switcher opens a surface that answers 200.
 *
 * The scenario that catches the failure nothing else can: the product switcher is generated from
 * the shared surface registry and rendered by every bundle, so an apex that resolves for the reader
 * but not for the switcher's derived hostnames breaks navigation between every product at once
 * while every surface's own probe stays green.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FIRST VERSION OF THIS READ `a[href]` AND WOULD HAVE ASSERTED THAT GITHUB.COM ANSWERS 200.**
 *
 * `ProductSwitcher` renders its entries INSIDE `{open && (…)}` (ui/packages/ui/src/index.tsx:677),
 * so on a page nobody has clicked there is no switcher in the DOM at all. Reading every anchor
 * instead therefore did two wrong things at once: it missed the thing the scenario is named after,
 * and it swept up whatever else the page links to — driven against `network.<apex>`, that set is
 * `{apex, explorer, network, github.com}`, and the journey would have gone red the next time
 * GitHub had a bad minute.
 *
 * So the trigger is clicked and the entries are read from `[role="menuitem"]` — the role the
 * component gives them, which is a contract with assistive technology and therefore the most
 * stable handle on the page.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The assertion stays inside the `navigation` boundary: each address the switcher OFFERS answers,
 * never anything about what it then shows. A signed-out reader sees the switcher without the
 * `adminOnly` entries, and whether that hiding is correct is `ui`'s own test — hiding is not the
 * boundary.
 */
const switcherResolves: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.network,
    config,
    surface: 'site',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const links = await ctx.step('open the switcher and read its addresses off the page', async () => {
        const opened = await page.evaluate(() => {
          const triggers = Array.from(
            document.querySelectorAll('button[aria-haspopup="menu"]'),
          ) as HTMLButtonElement[]
          for (const trigger of triggers) trigger.click()
          return triggers.length
        })
        ctx.assert(
          opened > 0,
          `${base} rendered no button[aria-haspopup="menu"] — @cloudsforge/ui did not load, or the ` +
            'switcher is no longer a menu and this journey is reading the wrong thing',
        )
        await page.waitForTimeout(500)
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('ul[role="menu"] [role="menuitem"][href]')).map(
            (a) => (a as HTMLAnchorElement).href,
          ),
        )
        const origins = [...new Set(hrefs.map((href) => new URL(href).origin))].sort()
        // A page that rendered no cross-origin entry has not rendered a switcher, and asserting
        // "every one of zero addresses answered" is the check-that-cannot-fail this repository
        // keeps finding. Fail instead, and say what was expected.
        ctx.assert(
          origins.length > 1,
          `${base} offered ${origins.length} switcher origin(s) — the shared switcher links to ` +
            'every product, so one or none means @cloudsforge/ui did not render it',
        )
        return origins
      })

      for (const origin of links) {
        await ctx.step(`the switcher’s ${new URL(origin).hostname} answers`, async () => {
          const response = await fetch(origin, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]),
          })
          ctx.assert(
            response.status === 200,
            `the switcher offers ${origin} and it answered ${response.status}`,
          )
        })
      }
    },
  })

/**
 * The scenarios this file can actually run, by id.
 *
 * Adding one is an entry here plus its implementation. The catalogue is deliberately NOT the place
 * that decides — a scenario that exists as data and not as code is a stated gap, and
 * `unimplemented()` prints the difference rather than letting it become invisible.
 */
const IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  'BJ-ACC-01': registerAndLand,
  'BJ-ACC-02': takenHandle,
  'BJ-ACC-03': deepLinkSignIn,
  'BJ-XS-10': switcherResolves,
  // The money path. Split into its own file rather than added here, because these carry their own
  // apparatus — a ledger oracle, an `eth_call` client and a set of fixtures — and folding six
  // hundred lines of it into the registry would bury the four above. The registry stays one map.
  ...FORESIGHT_IMPLEMENTATIONS,
  ...WALLET_IMPLEMENTATIONS,
  ...DASHBOARD_IMPLEMENTATIONS,
}

/* ------------------------------------------------------------------ the declaration */

export interface BrowserRegistryOptions {
  readonly config: BrowserConfig
  /** The names `BEACON_TARGETS` resolves. A surface without one cannot be pointed at. */
  readonly targets: ReadonlySet<string>
  /**
   * The estate credential that can mint a service token, or `null`.
   *
   * Only the money journeys use it, and they skip loudly without it rather than asserting against
   * an account with nothing in it. See `Implementation`.
   */
  readonly operator?: Operator | null
}

/**
 * The browser journeys this build declares.
 *
 * Returns the empty array whenever the estate cannot serve a browser, which is every deployment
 * that exists today. See the file header for why that is the point rather than a shortfall.
 */
export function browserJourneys(options: BrowserRegistryOptions): readonly JourneyDefinition[] {
  const out: JourneyDefinition[] = []
  for (const scenario of T3_SCENARIOS) {
    if (scenario.blocked !== null) continue
    const implementation = IMPLEMENTATIONS[scenario.id]
    if (!implementation) continue
    if (!scenario.needs.every((need) => options.targets.has(need))) continue
    out.push(implementation(options.config, scenario, options.operator ?? null))
  }
  return out
}

/** Why each unblocked scenario is not declared right now. One line per scenario, for the log. */
export function undeclared(options: BrowserRegistryOptions): readonly string[] {
  const out: string[] = []
  for (const scenario of T3_SCENARIOS) {
    if (scenario.blocked !== null) continue
    if (!IMPLEMENTATIONS[scenario.id]) {
      out.push(`${scenario.id}: no implementation yet`)
      continue
    }
    const missing = scenario.needs.filter((need) => !options.targets.has(need))
    if (missing.length > 0) {
      out.push(`${scenario.id}: no address for ${missing.join(', ')}`)
    }
  }
  return out
}

/** Unblocked scenarios with no implementation. The stated half of the gap. */
export function unimplemented(): readonly Scenario[] {
  return T3_SCENARIOS.filter((s) => s.blocked === null && !IMPLEMENTATIONS[s.id])
}

/** Implemented ids, so a test can check every one of them is a real, unblocked scenario. */
export const IMPLEMENTED_IDS: readonly string[] = Object.keys(IMPLEMENTATIONS)
