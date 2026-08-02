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
}

/* ------------------------------------------------------------------ availability */

export interface BrowserConfig {
  readonly enabled: boolean
  /** Absolute path to a Chromium. Empty means "let playwright find its own". */
  readonly executablePath: string
  readonly timeoutMs: number
}

export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Is there a browser to drive?
 *
 * Answers a reason rather than a boolean, because every caller puts the reason in a skip and a
 * skip whose reason is "no" is a skip nobody can act on.
 *
 * The result is NOT cached. The frozen helper cached it for the life of the process, which is a
 * false economy in a service that runs for weeks: a browser installed by a base-image update, or
 * one whose path was fixed by a redeploy of the config alone, would never be noticed, and every
 * browser journey would skip until somebody restarted the pod.
 */
export async function browserAvailable(config: BrowserConfig): Promise<Availability> {
  if (!config.enabled) return { ok: false, reason: 'BEACON_BROWSER_ENABLED is false' }

  try {
    await import('playwright-core')
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return { ok: false, reason: `playwright-core is not installed (${detail})` }
  }

  if (config.executablePath.length > 0) {
    try {
      await access(config.executablePath, constants.X_OK)
    } catch {
      return {
        ok: false,
        reason: `no executable browser at ${config.executablePath} — set BEACON_BROWSER_EXECUTABLE`,
      }
    }
  }

  return { ok: true }
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
}

interface Sink {
  consoleErrors: string[]
  pageErrors: string[]
  failedRequests: FailedRequest[]
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
export function assertClean(collected: Collected, where: string): Verdict {
  if (collected.pageErrors.length > 0) {
    return {
      ok: false,
      reason:
        `${where}: the page threw ${collected.pageErrors.length} uncaught error(s) — ` +
        collected.pageErrors.slice(0, 3).join(' | '),
    }
  }
  if (collected.failedRequests.length > 0) {
    return {
      ok: false,
      reason:
        `${where}: ${collected.failedRequests.length} request(s) failed — ` +
        collected.failedRequests
          .slice(0, 3)
          .map((r) => `${r.failure} ${r.url}`)
          .join(' | '),
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
    ...(config.executablePath.length > 0 ? { executablePath: config.executablePath } : {}),
    // --no-sandbox because the container runs as root; --disable-dev-shm-usage because Docker's
    // default 64MB /dev/shm makes Chromium crash on any non-trivial page, and a crashed browser
    // reports as a failing journey rather than as the misconfiguration it is.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })

  const sink: Sink = { consoleErrors: [], pageErrors: [], failedRequests: [] }

  try {
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      ignoreHTTPSErrors: false,
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
    sink.failedRequests.push({ url: url.slice(0, 300), method: req.method(), failure })
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
    sink.failedRequests.push({
      url: url.slice(0, 300),
      method: res.request().method(),
      failure: `HTTP ${res.status()}`,
    })
  }) as (arg: never) => void)
}
