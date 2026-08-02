/**
 * Turning the catalogue into journeys — and refusing to, while it cannot run.
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
 * Today the second condition is false for every scenario, because
 * `deploy/compose/docker-compose.estate.yml` serves no frontend container, so the function returns
 * nothing and the registry is unchanged. That is the correct result and it is reached mechanically
 * — nobody has to remember to take a journey out, and nobody has to remember to put one back. The
 * day a compose profile serves the bundles and the deploy names them in `BEACON_TARGETS`, the
 * journeys appear.
 *
 * The third condition is the honest one. Sixty-eight of the eighty-six T3 scenarios are blocked by
 * something in doc 22 §8 and cannot be written at all. Of the six that are not, one is implemented
 * here; the other five are recorded by `unimplemented()` rather than quietly omitted, because an
 * absent scenario is a gap nobody can see.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
} from './driver.ts'
import { T3_SCENARIOS, type Scenario } from './catalogue.ts'

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
    critical: options.critical ?? false,
    // Generous, and its own rather than the global 90s: launching Chromium, loading a bundle and
    // waiting for a SPA to mount is not comparable to a JSON round trip, and sharing one deadline
    // would either make browser journeys flaky or make HTTP journeys slow to report.
    deadlineMs: 120_000,
    async run(ctx) {
      const availability = await browserAvailable(options.config)
      if (!availability.ok) ctx.skip(availability.reason)
      const base = ctx.target(options.surface)

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
          const clean = assertClean(collected, options.name)
          ctx.assert(clean.ok, clean.reason)
        })

        if (options.verify) await options.verify(ctx, page, collected, base)
      })
    },
  }
}

/* ------------------------------------------------------------------ the implementations */

type Implementation = (config: BrowserConfig, scenario: Scenario) => JourneyDefinition

/**
 * BJ-XS-10 — every entry in the rendered switcher opens a surface that answers 200.
 *
 * The one T3 scenario that needs no session and no missing UI, so it is the one that gets written
 * first. It is also the scenario that catches the failure nothing else can: the product switcher
 * is generated from the shared surface registry and rendered by every bundle, so an apex that
 * resolves for the reader but not for the switcher's derived hostnames breaks navigation between
 * every product at once while every surface's own probe stays green.
 *
 * The assertion kind is `navigation`, and it stays inside that boundary: it asserts that each
 * address the page offers **answers**, never anything about what the address then shows. A
 * signed-out reader sees the switcher without the three `adminOnly` entries, and whether that
 * hiding is correct is `ui`'s own test — hiding is not the boundary.
 */
const switcherResolves: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.network,
    config,
    surface: 'site',
    critical: false,
    async verify(ctx, page, _collected, base) {
      const links = await ctx.step('read the switcher’s addresses off the page', async () => {
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((href) => href.startsWith('http')),
        )
        const origins = [...new Set(hrefs.map((href) => new URL(href).origin))].sort()
        // A page that rendered no cross-origin link has not rendered a switcher, and asserting
        // "every one of zero addresses answered" is the check-that-cannot-fail this repository
        // keeps finding. Fail instead, and say what was expected.
        ctx.assert(
          origins.length > 1,
          `${base} rendered links to ${origins.length} origin(s) — the shared switcher links to ` +
            `every product, so one origin means @cloudsforge/ui did not load or did not render it`,
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
 * that decides — a scenario that exists as data and not as code is a stated gap, and `journeys.
 * test.ts` prints the difference rather than letting it become invisible.
 */
const IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  'BJ-XS-10': switcherResolves,
}

/* ------------------------------------------------------------------ the declaration */

export interface BrowserRegistryOptions {
  readonly config: BrowserConfig
  /** The names `BEACON_TARGETS` resolves. A surface without one cannot be pointed at. */
  readonly targets: ReadonlySet<string>
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
    out.push(implementation(options.config, scenario))
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
