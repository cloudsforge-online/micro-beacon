/**
 * Chromium, for the checks a request cannot make.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **nginx SERVES `index.html` WITH A 200 WHETHER OR NOT ANY OF IT WORKS.**
 *
 * It answers 200 whether or not the bundle it references exists, whether or not that bundle throws
 * on its first line, and whether or not every API call it makes is refused by CORS. A `curl /`
 * check passes through all three, and so does every probe in `probes.ts`. The only way to tell
 * "the shell loaded" from "the product works" is to be a browser.
 *
 * The trap inside the trap, and the reason `assertRendered` is shaped the way it is: **a bundle
 * that 404s leaves the network perfectly idle and `domcontentloaded` fires anyway.** A smoke test
 * that waits for either event and then reports green has asserted that nginx is running. The
 * assertion has to be about content the application itself produced, which is why the legacy
 * helper asserted a rendered length and collected console errors and failed requests, and why
 * this one does the same three things.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `playwright-core`, not `playwright`. The frozen repository already recorded the reason
 * (`stack/infra/beacon/src/browser.js:9-11`): the full package downloads its own browser build at
 * install time and takes the image from roughly 200MB to 1.5GB, while the core package is the same
 * driver API against a Chromium the image already has. Both the import and the binary are
 * optional — if either is missing, browser journeys skip with that reason rather than failing,
 * because a lean deployment choosing not to ship a browser is a decision, not an outage.
 *
 * ## What this file deliberately does not do
 *
 * It does not resolve a surface to a URL. `journeys.ts` does that through `ctx.target`, from
 * `BEACON_TARGETS`, exactly as a service address is resolved — see the note there. Restating the
 * surface registry here is the mistake `ui/packages/ui/src/surfaces.ts` was written to end.
 */

import { access, constants } from 'node:fs/promises'
import { JourneySkip } from '../journeys.ts'

/* ------------------------------------------------------------------ the minimum of playwright */

/**
 * The slice of playwright-core this file uses.
 *
 * Declared structurally rather than imported as a type. `playwright-core` is an optional
 * dependency: a `import type { Page } from 'playwright-core'` would make `tsc` fail in any
 * checkout that did not install it, which would turn an optional runtime dependency into a
 * mandatory build one and defeat the whole point of it being optional.
 */
export interface BrowserResponse {
  status(): number
  ok(): boolean
  url(): string
}

export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<BrowserResponse | null>
  evaluate<T>(fn: () => T): Promise<T>
  waitForLoadState(state: string, options?: { timeout?: number }): Promise<void>
  title(): Promise<string>
  setDefaultTimeout(ms: number): void
  on(event: string, handler: (arg: never) => void): void
  url(): string
}

interface Chromium {
  launch(options: { executablePath?: string; args?: readonly string[] }): Promise<{
    newContext(options: unknown): Promise<{ newPage(): Promise<BrowserPage> }>
    close(): Promise<void>
  }>
  /** Where playwright would look for its own Chromium. Throws when none is registered. */
  executablePath(): string
}

/* ------------------------------------------------------------------ availability */

export interface BrowserConfig {
  readonly enabled: boolean
  /** Absolute path to a Chromium. Empty means "let playwright find its own". */
  readonly executablePath: string
  readonly timeoutMs: number
  /**
   * Accept a certificate the browser would refuse. **Off unless a deployment asks for it.**
   *
   * A production journey must fail on an expired or mis-issued certificate — that is one of the
   * few outages a synthetic monitor sees before a customer does, and a monitor that ignores TLS is
   * a monitor that reports green through it.
   *
   * The dev estate is the case that needs it and states why: `deploy/gateway` terminates TLS with
   * Traefik's built-in self-signed default (`CN=TRAEFIK DEFAULT CERT`), because
   * `ui/packages/ui/src/surfaces.ts` emits `https://` unconditionally and there is no CA on a
   * laptop. Without this flag every browser journey against that estate fails at `page.goto` with
   * `ERR_CERT_AUTHORITY_INVALID` — a red that says nothing about the product.
   *
   * Optional so that omitting it is the strict behaviour: a deployment has to say the word.
   */
  readonly ignoreHttpsErrors?: boolean
}

export type Availability =
  | { readonly ok: true; readonly executablePath: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Is there a browser to drive?
 *
 * Answers a reason rather than a boolean, because every caller puts the reason in a skip and a
 * skip whose reason is "no" is a skip nobody can act on.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PACKAGE BEING INSTALLED IS NOT THE BROWSER EXISTING, AND CONFLATING THEM COST A CI RUN.**
 *
 * The first version of this checked `config.executablePath` only when one was configured, and
 * otherwise reported available on the strength of the import alone — "let playwright find its
 * own". CI installs `playwright-core` and downloads no browser, so `browserAvailable` said yes and
 * `chromium.launch()` then threw `Executable doesn't exist at …/chrome-headless-shell`. Five cases
 * went red for a reason that is not a defect in anything they test.
 *
 * In the service the same mistake is worse than a red build: a container with the package and no
 * browser would FAIL every browser journey rather than skipping it, which turns a deployment
 * decision into an outage on the status page.
 *
 * So the executable is resolved and stat'd either way — from the configured path, or from the one
 * `playwright-core` itself would use. It is the difference between asking whether the driver is
 * installed and asking whether there is a browser.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The result is NOT cached. The frozen helper cached it for the life of the process, which is a
 * false economy in a service that runs for weeks: a browser installed by a base-image update, or
 * one whose path was fixed by a redeploy of the config alone, would never be noticed, and every
 * browser journey would skip until somebody restarted the pod.
 */
export async function browserAvailable(config: BrowserConfig): Promise<Availability> {
  if (!config.enabled) return { ok: false, reason: 'BEACON_BROWSER_ENABLED is false' }

  let chromium: Chromium
  try {
    ;({ chromium } = (await import('playwright-core')) as unknown as { chromium: Chromium })
  } catch (err) {
    const detail = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)
    return { ok: false, reason: `playwright-core is not installed (${detail})` }
  }

  let executablePath = config.executablePath
  if (executablePath.length === 0) {
    try {
      executablePath = chromium.executablePath()
    } catch (err) {
      const detail = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)
      return {
        ok: false,
        reason: `playwright-core cannot name a browser executable (${detail}) — set BEACON_BROWSER_EXECUTABLE`,
      }
    }
  }

  try {
    await access(executablePath, constants.X_OK)
  } catch {
    return {
      ok: false,
      reason: `no executable browser at ${executablePath} — set BEACON_BROWSER_EXECUTABLE`,
    }
  }

  return { ok: true, executablePath }
}

/* ------------------------------------------------------------------ what a page did wrong */

export interface FailedRequest {
  readonly url: string
  readonly method: string
  readonly failure: string
}

export interface Collected {
  readonly consoleErrors: readonly string[]
  readonly pageErrors: readonly string[]
  readonly failedRequests: readonly FailedRequest[]
  /**
   * Failures of the browser-observability sink, kept apart from the product's own requests.
   *
   * See `isObservabilitySink`. Reported by `assertClean`, never fatal on their own.
   */
  readonly observabilityFailures: readonly FailedRequest[]
}

interface Sink {
  consoleErrors: string[]
  pageErrors: string[]
  failedRequests: FailedRequest[]
  observabilityFailures: FailedRequest[]
}

/** A fresh collector. One place, so a caller cannot forget the fourth array. */
export function newSink(): Sink {
  return { consoleErrors: [], pageErrors: [], failedRequests: [], observabilityFailures: [] }
}

/**
 * Should this request failure count?
 *
 * Exported so it can be tested directly. Two exclusions, both of which cost a real journey a false
 * red the day they are removed:
 *
 *   * `net::ERR_ABORTED` is what a cancelled navigation looks like, and a SPA that routes during
 *     load cancels its own requests as designed.
 *   * A favicon nobody has is a 404 on every surface in the estate and tells you nothing about
 *     any of them.
 *
 * Everything else counts, including a 4xx or 5xx **response**, which `requestfailed` never fires
 * for: a bundle answering 404 completes the request perfectly happily.
 */
export function countsAsFailure(url: string, failure: string): boolean {
  if (failure === 'net::ERR_ABORTED') return false
  if (/favicon/i.test(url)) return false
  return true
}

/**
 * Is this request the page reporting its own errors, rather than the page working?
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE REPORTER FAILING IS NOT THE PAGE FAILING, AND CONFLATING THEM MAKES EVERY JOURNEY RED.**
 *
 * Every frontend in the estate posts browser errors to Lantern from `src/lib/obs.ts`, whose own
 * rule 1 is "IT NEVER THROWS. Telemetry that can break the page it measures is worse than no
 * telemetry", and whose rule 2 is "IT NEVER REPORTS ITSELF. A failed report must not produce a
 * report — that is an outage amplifier." A journey that goes red because the error-reporter could
 * not report is that same amplifier one layer up: the page is fine and the board is red.
 *
 * This is not hypothetical here. Driving `hub.<apex>/account/register` in Chromium against the
 * running estate produced, on every one of three flows:
 *
 *     net::ERR_FAILED https://lantern.<apex>/ingest/browser
 *
 * for two independent reasons, both real and neither this repository's to fix:
 *
 *   1. **micro-lantern is not in `deploy/compose/docker-compose.estate.yml` at all** — 22 domain
 *      services are, and it is not one of them — so `lantern.<apex>` has no router and no CORS
 *      allowance.
 *   2. **The two sides do not agree on the path.** `hub-web/src/lib/obs.ts:51` posts to
 *      `/ingest/browser`; `lantern/src/server.ts:333` defines `POST /ingest/client` and
 *      `OPTIONS /ingest/client`. Deploying Lantern would turn `ERR_FAILED` into a 404 and change
 *      nothing else. It is the same class of defect doc 22 §8.1 recorded for `/auth/exchange`
 *      against `/auth/handoff/redeem`, found the same way — by driving it.
 *
 * So these are PARTITIONED, not discarded: `assertClean` names them in its message on every
 * failure, and `Collected.observabilityFailures` is there for a caller that wants to assert on
 * them directly. The precedent is in this file already — console errors are collected and reported
 * and are not fatal alone, "because a journey that fails on any `console.error` is a journey that
 * fails for ever for reasons nobody owns". A permanently-failing declared journey is the exact
 * thing `journeys.ts`'s header refuses.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Matched on PATH, not on hostname. A hostname would be a copy of the surface registry, which is
 * the mistake `ui/packages/ui/src/surfaces.ts` exists to end; the path is the contract, and it is
 * the half of the contract that is wrong.
 */
export function isObservabilitySink(url: string): boolean {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return false
  }
  return path === '/ingest/browser' || path === '/ingest/client'
}

/* ------------------------------------------------------------------ the assertions */

export interface Verdict {
  readonly ok: boolean
  readonly reason: string
}

const OK: Verdict = { ok: true, reason: '' }

/**
 * The minimum a body must render before the page counts as having mounted.
 *
 * Forty characters, carried forward from the frozen helper unchanged. It is deliberately low: the
 * assertion is "the application produced something", not "the application produced the right
 * thing", and every surface-specific claim belongs in that surface's own scenario. Raising it
 * would make this a content assertion in a file that has no business having one.
 */
export const MIN_RENDERED_LENGTH = 40

/**
 * Did the application mount?
 *
 * A pure function over what the page reported, so the property this whole file exists for can be
 * proved without a browser at all — and so that proving it does not depend on a Chromium being
 * present in CI. The browser-driven test that runs the same assertion against a real 404ing bundle
 * lives beside it and skips when there is no browser; this one never skips.
 */
export function assertRendered(text: string, collected: Collected, where: string): Verdict {
  const rendered = text.trim().length
  if (rendered > MIN_RENDERED_LENGTH) return OK
  const failures = collected.failedRequests
  return {
    ok: false,
    reason:
      `${where} rendered ${rendered} characters — the shell loaded and the application did not ` +
      `mount. ${failures.length} request(s) failed` +
      (failures.length > 0
        ? `: ${failures.slice(0, 3).map((r) => `${r.failure} ${r.url}`).join(' | ')}`
        : ' — an empty body with no failed request usually means the bundle threw on its first line'),
  }
}

/**
 * Did the page get through the load without breaking?
 *
 * Console errors are collected and reported but are **not** fatal on their own, for the reason the
 * frozen helper gives: third-party widgets and browser extensions produce them, and a journey that
 * fails on any `console.error` is a journey that fails for ever for reasons nobody owns. An
 * uncaught exception and a failed request are different — both are the page not working.
 */
/**
 * A failure the scenario is ABOUT, declared by the scenario that expects it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A REFUSAL SCENARIO'S 4xx IS THE ASSERTION, NOT A DEFECT — AND IT ARRIVES IN THE SAME BUCKET.**
 *
 * BJ-ACC-02 registers with a handle that is already taken and asserts the sentence identity
 * returns. Driven against the estate, the page produced exactly what it should:
 *
 *     HTTP409 https://nimbus.<apex>/auth/register
 *
 * `assertClean` cannot tell that from a bundle 404ing, so a refusal scenario either declares the
 * one exchange it expects or can never be green. Declared, narrow and per-journey — never a
 * blanket "ignore 4xx", which would delete the check for every scenario at once.
 *
 * Both fields must match. `status` alone would let ANY 409 on the page satisfy it; `path` alone
 * would let a 500 on the same route pass as the expected refusal, which is the wrong outcome
 * wearing the right route.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ExpectedFailure {
  /** Exact pathname, as the service routes it. Not a substring — a route is a fact. */
  readonly path: string
  /** The status the scenario asserts the estate answers. */
  readonly status: number
}

function isExpected(request: FailedRequest, expected: readonly ExpectedFailure[]): boolean {
  let path: string
  try {
    path = new URL(request.url).pathname
  } catch {
    return false
  }
  return expected.some((e) => e.path === path && request.failure === `HTTP ${e.status}`)
}

/**
 * Did the page get through the load without breaking?
 *
 * Console errors are collected and reported but are **not** fatal on their own, for the reason the
 * frozen helper gives: third-party widgets and browser extensions produce them, and a journey that
 * fails on any `console.error` is a journey that fails for ever for reasons nobody owns. An
 * uncaught exception and a failed request are different — both are the page not working.
 *
 * Two things are held to that same standard and are reported rather than fatal: the browser
 * observability sink (see `isObservabilitySink`), and the exchanges a refusal scenario declares it
 * expects. Everything else still fails, including a 404 on a chunk, which is the case this exists
 * for.
 */
export function assertClean(
  collected: Collected,
  where: string,
  expected: readonly ExpectedFailure[] = [],
): Verdict {
  // Appended to every failure message rather than hidden: the reporter being broken is worth
  // knowing about, it just is not worth calling the product broken over.
  const aside =
    collected.observabilityFailures.length > 0
      ? ` (also, and NOT counted: ${collected.observabilityFailures.length} browser-observability ` +
        `post(s) failed — ${collected.observabilityFailures[0]?.failure} ` +
        `${collected.observabilityFailures[0]?.url})`
      : ''

  if (collected.pageErrors.length > 0) {
    return {
      ok: false,
      reason:
        `${where}: the page threw ${collected.pageErrors.length} uncaught error(s) — ` +
        collected.pageErrors.slice(0, 3).join(' | ') +
        aside,
    }
  }
  const unexpected = collected.failedRequests.filter((r) => !isExpected(r, expected))
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason:
        `${where}: ${unexpected.length} request(s) failed — ` +
        unexpected
          .slice(0, 3)
          .map((r) => `${r.failure} ${r.url}`)
          .join(' | ') +
        aside,
    }
  }
  return OK
}

/* ------------------------------------------------------------------ driving one page */

export interface PageRun<T> {
  (page: BrowserPage, collected: Collected): Promise<T>
}

/**
 * Drive a page, collecting the failures a human would notice and a fetch cannot see.
 *
 * The collected arrays are the point: a page that renders while throwing a ReferenceError and
 * 404ing its main chunk is a page that is about to be a support ticket, and every server-side
 * check in this repository reports it as healthy.
 *
 * Throws `JourneySkip` when there is no browser, so a caller that forgot to check
 * `browserAvailable` skips rather than reporting the product broken.
 */
export async function withPage<T>(
  config: BrowserConfig,
  run: PageRun<T>,
  options: { viewport?: { width: number; height: number } } = {},
): Promise<T> {
  const availability = await browserAvailable(config)
  if (!availability.ok) throw new JourneySkip(availability.reason)

  const { chromium } = (await import('playwright-core')) as unknown as { chromium: Chromium }
  const browser = await chromium.launch({
    // The path `browserAvailable` resolved and stat'd, never the raw configuration. Launching
    // against a path nothing checked is how "the package is installed" gets mistaken for "there is
    // a browser".
    executablePath: availability.executablePath,
    // --no-sandbox because the container runs as root; --disable-dev-shm-usage because Docker's
    // default 64MB /dev/shm makes Chromium crash on any non-trivial page, and a crashed browser
    // reports as a failing journey rather than as the misconfiguration it is.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })

  const sink: Sink = newSink()

  try {
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      // Defaulted to the strict value HERE rather than in `BrowserConfig`, so that a config object
      // built without the field is strict. An optional field whose absence means "permissive" is
      // how a production deployment ends up ignoring certificates because somebody added a key.
      ignoreHTTPSErrors: config.ignoreHttpsErrors ?? false,
      userAgent: 'CloudsForge-Beacon/1.0 (synthetic monitoring)',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(config.timeoutMs)
    attach(page, sink)
    return await run(page, sink)
  } finally {
    // Swallowed on purpose: a browser that would not close is a leak worth a log line, and
    // rethrowing here would replace the journey's real verdict with a teardown error.
    await browser.close().catch(() => {})
  }
}

/** Wire the four listeners. Separated so a test can drive it with a fake page object. */
export function attach(page: Pick<BrowserPage, 'on'>, sink: Sink): void {
  page.on('console', ((msg: { type(): string; text(): string }) => {
    if (msg.type() === 'error') sink.consoleErrors.push(msg.text().slice(0, 500))
  }) as (arg: never) => void)

  page.on('pageerror', ((err: { message?: string }) => {
    sink.pageErrors.push(String(err?.message ?? err).slice(0, 500))
  }) as (arg: never) => void)

  page.on('requestfailed', ((req: {
    failure(): { errorText: string } | null
    url(): string
    method(): string
  }) => {
    const failure = req.failure()?.errorText ?? 'unknown'
    const url = req.url()
    if (!countsAsFailure(url, failure)) return
    const record = { url: url.slice(0, 300), method: req.method(), failure }
    if (isObservabilitySink(url)) sink.observabilityFailures.push(record)
    else sink.failedRequests.push(record)
  }) as (arg: never) => void)

  // The listener the frozen helper added and the one that catches the 404ing bundle: a request
  // that COMPLETES with a 404 never fires `requestfailed`, and a missing main chunk is exactly
  // that — a perfectly successful HTTP exchange whose answer is "no".
  page.on('response', ((res: {
    status(): number
    url(): string
    request(): { method(): string }
  }) => {
    if (res.status() < 400) return
    const url = res.url()
    if (!countsAsFailure(url, `HTTP ${res.status()}`)) return
    const record = {
      url: url.slice(0, 300),
      method: res.request().method(),
      failure: `HTTP ${res.status()}`,
    }
    if (isObservabilitySink(url)) sink.observabilityFailures.push(record)
    else sink.failedRequests.push(record)
  }) as (arg: never) => void)
}
