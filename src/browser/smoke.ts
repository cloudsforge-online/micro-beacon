/**
 * The smoke tier: a real browser, against the real estate, through the real gateway, stubbing
 * nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS EXISTS: A SUITE THAT ANSWERS ITS OWN REQUESTS CANNOT SEE THAT THE API IS DOWN.**
 *
 * The estate shipped green — 44 healthy containers, CI green in 58 repositories, 314 browser
 * scenarios specified — and when a human opened it in a browser, sign-in failed, the Forge Worlds
 * registry failed, Foresight was blank and Forge Trade rendered unstyled. Every test passed
 * through all of it, and the reason is one line repeated in every frontend's journey helper
 * (`site/test/journeys/browser.ts:342` and its equivalents):
 *
 *     await page.route('**\/*', async (route) => { … route.fulfill({ … }) })
 *
 * It launches a real browser, renders the real bundle, and then **intercepts every network request
 * and answers it from a fixture**. What it proves is "this app renders correctly when its API
 * works". It is structurally incapable of noticing that the API is unreachable — which is the
 * failure it was sitting at the exact seam of.
 *
 * So the single most important property of this file is a negative one:
 *
 *     THERE IS NO `page.route`, NO `route.fulfill`, NO `setOfflineMode`, NO SERVICE WORKER AND NO
 *     FIXTURE ANYWHERE IN THIS TIER. EVERY BYTE THESE PAGES RECEIVE CAME FROM THE ESTATE.
 *
 * `smoke.test.ts` asserts that as text over this repository's own sources, and CI repeats it, so
 * the day somebody reaches for a stub to make a red go away it is a red of its own.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why here and not in micro-conformance
 *
 * micro-conformance records what the estate *does* — request in, normalised response out — so a
 * replacement can be proven equivalent. It is an HTTP recorder with a corpus; it has no browser,
 * no notion of a rendered page, and its whole value is that its output is a stable artefact to
 * diff. Adding a Chromium and a set of live assertions to it would make its corpus depend on
 * whether a bundle painted, which is the one thing a characterisation corpus must not do.
 *
 * micro-beacon already owns every piece of this: `driver.ts` drives Chromium and collects console
 * errors, uncaught exceptions and failed requests **and has never intercepted anything**;
 * `journeys.ts` owns "not-run is not passed"; `gate.ts` turns results into a release decision.
 * This is one more file beside them, not a third harness.
 *
 * ## What it asserts, and why each one is the one that would have caught the estate
 *
 * Per surface, in one signed-in browser context, in the order a person would meet them:
 *
 *   1. **The document answers 200.** Necessary and nowhere near sufficient — all sixteen answer
 *      200 today while eight of them show an error state.
 *   2. **The application mounted** (`assertRendered`). Foresight is blank; only this sees it.
 *   3. **The page is painted.** `body`'s computed background is not transparent. Three surfaces
 *      serve a bundle whose own stylesheet never applies, and "renders unstyled" is a thing a
 *      human notices in one second and no HTTP check notices ever.
 *   4. **No `state--failed` and no `state--forbidden` node.** This is the strongest assertion in
 *      the file and it is not a string match on prose. Every frontend renders the same four-state
 *      component (`<each frontend>/src/components/states.tsx`), whose header sets out why the states are
 *      separate: `EMPTY` is "the query answered, with nothing" and `FAILED` is "the query did not
 *      answer". So an empty registry is green and a registry that did not load is red, decided by
 *      the estate's own design system rather than by a regex this repository invented.
 *   5. **No failed request and no uncaught exception**, from `driver.ts`'s collectors. The Worlds
 *      registry defect is exactly this and nothing else: `ERR_FAILED` on
 *      `worlds-api.<apex>/v1/titles`.
 *   6. **No console error.** Asked for explicitly, and fatal HERE where it is not fatal in
 *      `assertClean` — see `SMOKE_CONSOLE_IS_FATAL` below for why the two differ on purpose.
 *   7. **The surface's own words are on screen.** A gateway that routed every hostname to one
 *      bundle would satisfy every assertion above and serve the wrong product at fifteen
 *      addresses.
 *
 * And once, before all of it: **a real sign-in**, with a real password, against real identity,
 * ending on a page that renders the account's handle. It is the single most valuable assertion in
 * the estate and there was nothing anywhere that made it.
 */

import {
  assertClean,
  assertRendered,
  isObservabilitySink,
  type BrowserConfig,
  type BrowserPage,
  type Collected,
} from './driver.ts'

/* ------------------------------------------------------------------ the surfaces */

/** Whether the surface must show the signed-in account, once the suite has signed in. */
export type SessionExpectation = 'shows-the-account' | 'does-not-have-to'

export interface SmokeSurface {
  /** The registry key, as `ui/packages/ui/src/surfaces.ts` names it. */
  readonly key: string
  /** Subdomain under the apex. The empty string is the apex itself. */
  readonly subdomain: string
  /** The page whose primary data matters. The index, for every surface: it is what a person opens. */
  readonly path: string
  readonly session: SessionExpectation
  /**
   * Words only this surface's own bundle produces.
   *
   * Not a data assertion — that is what `state--failed` is for, because the design system already
   * distinguishes "answered with nothing" from "did not answer" and a regex here would be this
   * repository guessing at the difference. These pin IDENTITY: that the gateway routed this
   * hostname to this product, rather than to whichever bundle answers first.
   */
  readonly renders: readonly RegExp[]
}

/**
 * The sixteen surfaces `deploy/compose/docker-compose.estate.yml` serves, in switcher order.
 *
 * Keys and subdomains are read off `ui/packages/ui/src/surfaces.ts`, which is the registry whose
 * own header records that this list was maintained by hand in eight places and had already
 * drifted. The apex is NOT recorded here — it comes from configuration, so that pointing this
 * suite at staging is a variable rather than an edit.
 */
export const SMOKE_SURFACES: readonly SmokeSurface[] = [
  {
    key: 'site',
    subdomain: '',
    path: '/',
    session: 'does-not-have-to',
    renders: [/One crypto world/i, /The loop is the product/i],
  },
  {
    key: 'hub',
    subdomain: 'hub',
    path: '/',
    // Hub is where the suite signed in. If the account is not on screen HERE, the session did not
    // survive the navigation and every other signed-in surface is being judged on a lie.
    session: 'shows-the-account',
    renders: [/Portfolio/i, /Activity/i],
  },
  {
    key: 'market',
    subdomain: 'market',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Market/i, /Browse the market/i],
  },
  {
    key: 'create',
    subdomain: 'create',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Create/i, /Launch a token/i],
  },
  {
    key: 'trade',
    subdomain: 'trade',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Trade/i, /Strategies/i],
  },
  {
    key: 'worlds',
    subdomain: 'worlds',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Worlds/i, /The title registry/i],
  },
  {
    key: 'explorer',
    subdomain: 'explorer',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Network Explorer/i, /Chains/i],
  },
  {
    key: 'network',
    subdomain: 'network',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Network/i, /Hearth/i],
  },
  {
    key: 'developers',
    subdomain: 'developers',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Developer Platform/i, /Organisations/i],
  },
  {
    key: 'admin',
    subdomain: 'admin',
    path: '/',
    // The operator console. An admin surface that renders while signed out is either broken or a
    // hole, and either way it is not a pass.
    session: 'shows-the-account',
    renders: [/Estate/i, /Approvals/i],
  },
  {
    key: 'status',
    subdomain: 'status',
    path: '/',
    session: 'does-not-have-to',
    renders: [/STATUS/, /How we measure/i],
  },
  {
    key: 'foresight',
    subdomain: 'foresight',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Foresight/i],
  },
  {
    key: 'foresight-admin',
    subdomain: 'foresight-admin',
    path: '/',
    // Deliberately NOT 'shows-the-account'. The cross-origin session handoff to this console was
    // observed to work on one run and not on the next, and an assertion that is sometimes right is
    // worse than none: it teaches people to re-run. Its real defects — 404s on the ideas and
    // categories routes — are caught by the network assertion, which is not ambiguous.
    session: 'does-not-have-to',
    renders: [/Idea queue/i, /Markets/i],
  },
  {
    key: 'emberkin',
    subdomain: 'emberkin',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Emberkin|Warden|Kin/i, /Dex/i],
  },
  {
    key: 'aetherholm',
    subdomain: 'aetherholm',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Archipelago/i, /Chronicle/i],
  },
  {
    key: 'tessera',
    subdomain: 'tessera',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Wards/i, /Kiln/i],
  },
]

/** `https://hub.apex/path`, or `https://apex/path` for the apex surface. */
export function surfaceUrl(apex: string, surface: SmokeSurface): string {
  const host = surface.subdomain === '' ? apex : `${surface.subdomain}.${apex}`
  return `https://${host}${surface.path.startsWith('/') ? surface.path : `/${surface.path}`}`
}

/** Every hostname the suite will speak TLS to, for `collectPins`. */
export function smokeHosts(apex: string): readonly string[] {
  return SMOKE_SURFACES.map((s) => (s.subdomain === '' ? apex : `${s.subdomain}.${apex}`))
}

/* ------------------------------------------------------------------ what a page did */

/**
 * Everything one page visit produced, as data.
 *
 * A plain record with no browser in it, so every assertion below is a pure function of it and can
 * be proved — including proved to FAIL — in a checkout with no Chromium and no estate. The
 * fixtures in `smoke.test.ts` are transcriptions of what the real estate actually returned, so the
 * suite's own red is reproducible after the estate is fixed.
 */
export interface PageObservation {
  readonly surfaceKey: string
  readonly url: string
  /** The document's own status. `null` when the navigation never produced a response at all. */
  readonly status: number | null
  /**
   * Why the navigation threw, when it did.
   *
   * A refused connection, a DNS answer nobody serves, or a certificate the pin did not excuse.
   * Carried as a field rather than thrown, so one dead surface reports itself and the other
   * fifteen are still visited — a suite that stops at the first failure finds one defect per run.
   */
  readonly navigationError: string | null
  readonly bodyText: string
  /** `body`'s computed background. `rgba(0, 0, 0, 0)` means the surface's stylesheet did not apply. */
  readonly backgroundColor: string
  /** Carried for the message only. Never asserted on — see `dom.d.ts`. */
  readonly fontFamily: string
  /** The text of every `*-state--failed` / `*-state--forbidden` node on the page. */
  readonly failureStates: readonly string[]
  readonly collected: Collected
}

export interface Finding {
  readonly surfaceKey: string
  readonly check: string
  readonly detail: string
}

/**
 * Console errors are FATAL here, and they are not in `assertClean`. Both are correct.
 *
 * `assertClean` serves declared journeys that run every five minutes for years, and its reasoning
 * holds for that: third-party widgets and extensions produce console errors, and a journey that
 * fails on any `console.error` fails for ever for reasons nobody owns.
 *
 * This tier is different in the two ways that reverse the answer. It runs against an estate we
 * control, in a clean profile with no extensions, on demand rather than on a schedule — and the
 * brief it was written to is explicit that "no console errors and no failed network requests on
 * each page… alone would have caught both defects". It is true: the Worlds registry defect
 * announces itself as a CORS console error before it is anything else.
 *
 * Named as a constant rather than left implicit, so that the day somebody wants to relax it they
 * have to delete a paragraph that says why they should not.
 */
export const SMOKE_CONSOLE_IS_FATAL = true

/** Transparent. The value Chromium reports for a `body` nothing painted. */
export const UNPAINTED_BACKGROUND = 'rgba(0, 0, 0, 0)'

/**
 * Every way this page visit failed. Empty means the surface works.
 *
 * Returns ALL of them rather than the first, because a surface with a 404 and a failure state and
 * a missing stylesheet is three defects, and reporting one at a time turns one afternoon into
 * three.
 */
export function checkSurface(
  observation: PageObservation,
  surface: SmokeSurface,
  handle: string,
): readonly Finding[] {
  const findings: Finding[] = []
  const at = (check: string, detail: string): void => {
    findings.push({ surfaceKey: observation.surfaceKey, check, detail })
  }

  if (observation.navigationError !== null) {
    at('the document answers', `${observation.url} could not be loaded: ${observation.navigationError}`)
  } else if (observation.status === null) {
    at('the document answers', `${observation.url} produced no response at all`)
  } else if (observation.status !== 200) {
    at('the document answers', `${observation.url} answered HTTP ${observation.status}`)
  }

  const rendered = assertRendered(observation.bodyText, observation.collected, observation.url)
  if (!rendered.ok) at('the application mounted', rendered.reason)

  if (observation.backgroundColor === UNPAINTED_BACKGROUND) {
    at(
      'the page is painted',
      `${observation.url} rendered with a transparent body background and fell back to ` +
        `"${observation.fontFamily}" — the surface's own stylesheet did not apply, so a reader ` +
        'sees unstyled markup on white',
    )
  }

  if (observation.failureStates.length > 0) {
    at(
      'no error state on screen',
      `${observation.url} is showing ${observation.failureStates.length} failure state(s) from ` +
        `its own design system: ${observation.failureStates.slice(0, 3).join(' | ')}`,
    )
  }

  // `assertClean` with NO expected failures. A smoke run has no refusal scenarios, so there is
  // nothing legitimate for it to excuse, and passing an allowance here would be the beginning of
  // the list that eventually contains the defect.
  const clean = assertClean(observation.collected, observation.surfaceKey)
  if (!clean.ok) at('nothing failed on the wire', clean.reason)

  if (SMOKE_CONSOLE_IS_FATAL && observation.collected.consoleErrors.length > 0) {
    at(
      'no console error',
      `${observation.url} logged ${observation.collected.consoleErrors.length} console error(s): ` +
        observation.collected.consoleErrors.slice(0, 3).join(' | '),
    )
  }

  for (const pattern of surface.renders) {
    if (!pattern.test(observation.bodyText)) {
      at(
        'the surface renders its own words',
        `${observation.url} never rendered ${String(pattern)} — this hostname is not serving the ` +
          `${surface.key} bundle, or the bundle is not showing its own page`,
      )
    }
  }

  if (surface.session === 'shows-the-account' && !observation.bodyText.includes(handle)) {
    at(
      'the session reached this surface',
      `${observation.url} rendered ${observation.bodyText.trim().length} characters and none of ` +
        `them is the handle "${handle}" — the browser signed in and this surface does not know it`,
    )
  }

  return findings
}

/* ------------------------------------------------------------------ driving it */

/** How many of each collector's entries had already been seen before a navigation. */
export interface SinkMark {
  readonly consoleErrors: number
  readonly pageErrors: number
  readonly failedRequests: number
  readonly observabilityFailures: number
}

export function mark(collected: Collected): SinkMark {
  return {
    consoleErrors: collected.consoleErrors.length,
    pageErrors: collected.pageErrors.length,
    failedRequests: collected.failedRequests.length,
    observabilityFailures: collected.observabilityFailures.length,
  }
}

/**
 * What happened SINCE a mark.
 *
 * One page is reused for all seventeen navigations, because that is what a session is: signing in
 * once and then walking the estate is the thing under test, and a fresh context per surface would
 * quietly delete the cross-origin half of it. The collectors are cumulative, so each surface is
 * judged on its own slice — without this, surface two inherits surface one's failures and every
 * report after the first is wrong.
 */
export function since(collected: Collected, at: SinkMark): Collected {
  return {
    consoleErrors: collected.consoleErrors.slice(at.consoleErrors),
    pageErrors: collected.pageErrors.slice(at.pageErrors),
    failedRequests: collected.failedRequests.slice(at.failedRequests),
    observabilityFailures: collected.observabilityFailures.slice(at.observabilityFailures),
  }
}

/**
 * Read one page, having navigated to it.
 *
 * Nothing is mocked, nothing is fulfilled, and the only thing this waits for is the network going
 * quiet — best effort, because a surface that polls for ever never reaches `networkidle` and
 * waiting for it is a courtesy to a slow mount rather than a precondition of anything asserted.
 */
export async function visit(
  page: BrowserPage,
  collected: Collected,
  surface: SmokeSurface,
  apex: string,
  timeoutMs: number,
): Promise<PageObservation> {
  const url = surfaceUrl(apex, surface)
  const before = mark(collected)
  let status: number | null = null
  let navigationError: string | null = null
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    status = response === null ? null : response.status()
  } catch (err) {
    navigationError = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)
  }
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})

  const read = await page
    .evaluate(() => ({
      bodyText: document.body?.innerText ?? '',
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      fontFamily: getComputedStyle(document.body).fontFamily,
      failureStates: Array.from(
        document.querySelectorAll('[class*="state--failed"], [class*="state--forbidden"]'),
      ).map((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 200)),
    }))
    .catch(() => ({ bodyText: '', backgroundColor: '', fontFamily: '', failureStates: [] as string[] }))

  return {
    surfaceKey: surface.key,
    url,
    status,
    navigationError,
    bodyText: read.bodyText,
    backgroundColor: read.backgroundColor,
    fontFamily: read.fontFamily,
    failureStates: read.failureStates,
    collected: since(collected, before),
  }
}

/* ------------------------------------------------------------------ the sign-in */

export interface Credentials {
  /** identity's field is `identifier`, and it takes an address OR a handle. It is not `email`. */
  readonly identifier: string
  readonly password: string
  /** What the signed-in estate must render. The evidence that a session exists at all. */
  readonly handle: string
}

export interface SignInResult {
  readonly findings: readonly Finding[]
  /** Where the browser ended up. In the message when the assertion fails. */
  readonly landedAt: string
}

/**
 * Sign in, for real, through the page a person uses.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ASSERTION THE ESTATE DID NOT HAVE, AND THE ONE THAT MATTERED MOST.**
 *
 * The form is filled and submitted in a real browser, which means the request goes wherever the
 * bundle decides to send it, through whatever gateway routing exists, with whatever CORS the
 * services allow. That is the whole point: the defect that shipped was a gateway with no `/auth/*`
 * route at all, and NOTHING in the estate exercised the path from a form to identity and back.
 *
 * The last check is the one with teeth. Reaching a page is not a session: a sign-in that silently
 * failed leaves the browser on a form that looks fine. Landing off `/account` **and** rendering
 * the handle is a string the application can only have obtained from identity's answer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function signIn(
  page: BrowserPage,
  collected: Collected,
  apex: string,
  credentials: Credentials,
  timeoutMs: number,
): Promise<SignInResult> {
  const url = `https://hub.${apex}/account/login`
  const findings: Finding[] = []
  const at = (check: string, detail: string): void => {
    findings.push({ surfaceKey: 'sign-in', check, detail })
  }
  const before = mark(collected)

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    if (response === null) at('the sign-in page answers', `${url} produced no response at all`)
    else if (!response.ok()) {
      at('the sign-in page answers', `${url} answered HTTP ${response.status()}`)
    }
  } catch (err) {
    at('the sign-in page answers', `${url}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    return { findings, landedAt: url }
  }
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})

  try {
    // BY NAME, which is the attribute hub-web's own inputs carry, and the one a form post would
    // use. `identifier`, not `email`: the field takes either an address or a handle, and a suite
    // that typed into `input[name=email]` would fail on a page that is working.
    await page.fill('input[name=identifier]', credentials.identifier)
    await page.fill('input[name=password]', credentials.password)
  } catch (err) {
    at(
      'the sign-in form is on screen',
      `${url} does not carry input[name=identifier] and input[name=password] ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
    )
    return { findings, landedAt: page.url() }
  }

  try {
    await page.click('button[type=submit]')
    await page.waitForURL((u) => !u.pathname.startsWith('/account'), { timeout: timeoutMs })
  } catch {
    at(
      'signing in leaves the sign-in surface',
      `the form was submitted with a correct credential and the browser is still at ${page.url()} ` +
        `after ${timeoutMs}ms — sign-in did not succeed`,
    )
  }

  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  const landedAt = page.url()
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')

  if (!text.includes(credentials.handle)) {
    at(
      'the estate renders the account that signed in',
      `${landedAt} rendered ${text.trim().length} characters and none of them is the handle ` +
        `"${credentials.handle}" — reaching a page is not a session`,
    )
  }

  const slice = since(collected, before)
  const clean = assertClean(slice, 'sign-in')
  if (!clean.ok) at('nothing failed on the wire while signing in', clean.reason)
  if (SMOKE_CONSOLE_IS_FATAL && slice.consoleErrors.length > 0) {
    at(
      'no console error while signing in',
      slice.consoleErrors.slice(0, 3).join(' | '),
    )
  }

  return { findings, landedAt }
}

/* ------------------------------------------------------------------ the run */

export interface SmokeConfig {
  readonly apex: string
  readonly credentials: Credentials
  readonly browser: BrowserConfig
  /** A subset of `SMOKE_SURFACES`, for driving one surface while fixing it. Defaults to all. */
  readonly surfaces?: readonly SmokeSurface[]
}

export interface SmokeResult {
  readonly signIn: SignInResult
  readonly observations: readonly PageObservation[]
  readonly findings: readonly Finding[]
}

/**
 * Sign in once, walk every surface, and report everything wrong with all of them.
 *
 * `withPage` from `driver.ts` supplies the browser and the collectors — the same driver the
 * declared journeys use, so there is one implementation of "what did this page do wrong" and no
 * second one to drift.
 */
export async function runSmoke(config: SmokeConfig): Promise<SmokeResult> {
  const { withPage } = await import('./driver.ts')
  const surfaces = config.surfaces ?? SMOKE_SURFACES
  return await withPage(config.browser, async (page, collected) => {
    const signInResult = await signIn(
      page,
      collected,
      config.apex,
      config.credentials,
      config.browser.timeoutMs,
    )
    const observations: PageObservation[] = []
    const findings: Finding[] = [...signInResult.findings]
    for (const surface of surfaces) {
      const observation = await visit(page, collected, surface, config.apex, config.browser.timeoutMs)
      observations.push(observation)
      findings.push(...checkSurface(observation, surface, config.credentials.handle))
    }
    return { signIn: signInResult, observations, findings }
  })
}

/**
 * Is the gateway there at all?
 *
 * Separate from the run and answered before it, so that "the estate is not running" and "the
 * estate is running and broken" are different sentences. The first is a skip with an address in
 * it; the second is the product being red. A suite that reported the first as the second would
 * teach people to ignore it.
 *
 * `fetch`, not a browser: this must answer in a second even where there is no Chromium, and the
 * question is only whether something is listening and speaking TLS.
 */
export async function estateReachable(
  apex: string,
  timeoutMs = 3_000,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const { inspectCertificate } = await import('./estatecert.ts')
  try {
    await inspectCertificate(`hub.${apex}`, { timeoutMs })
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason:
        `nothing is serving TLS at hub.${apex}:443 ` +
        `(${err instanceof Error ? err.message : String(err)}) — bring the estate up, or set ` +
        'BEACON_SMOKE_APEX to one that is running',
    }
  }
}

/** Failures that came from the browser telemetry sink, kept visible and never counted. */
export function observabilityAside(observations: readonly PageObservation[]): readonly string[] {
  return observations
    .flatMap((o) => o.collected.observabilityFailures)
    .filter((r) => isObservabilitySink(r.url))
    .map((r) => `${r.failure} ${r.url}`)
}
