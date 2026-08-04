/**
 * The browser driver, and the one assertion the whole browser tier exists for.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TEST THAT MATTERS IS "A PAGE WHOSE BUNDLE 404s MUST GO RED".**
 *
 * It is the defect a browser is here to catch and the one a naive browser test misses: nginx
 * answers 200 for `index.html` whether or not the script it references exists, `domcontentloaded`
 * fires on the empty shell, and a bundle that 404s leaves the network perfectly idle — so waiting
 * for either event and reporting green asserts that nginx is running.
 *
 * It is proved twice, on purpose:
 *
 *   1. **As pure functions, always.** `assertRendered` and `assertClean` take what the page
 *      reported and answer a verdict, so the property is checked in every CI run whether or not a
 *      Chromium exists on the machine. A guard that only runs where a browser happens to be
 *      installed is a guard that is not running.
 *   2. **Against a real Chromium, when one is present.** Two pages are served by a local server:
 *      one whose script exists and mounts, one whose script 404s. The first must pass and the
 *      second must fail — and the second was WATCHED failing, on 2026-08-03, against Chromium
 *      140. Without the second half, the first proves only that a browser can load a page.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
  MIN_RENDERED_LENGTH,
  assertClean,
  assertRendered,
  attach,
  browserAvailable,
  consoleErrorResource,
  countsAsFailure,
  isObservabilitySink,
  newSink,
  unexpectedConsoleErrors,
  withPage,
  type BrowserConfig,
  type Collected,
  type FailedRequest,
} from './driver.ts'
import { JourneySkip } from '../journeys.ts'

const NOTHING: Collected = {
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  observabilityFailures: [],
}

/* ------------------------------------------------------------------ the pure half */

test('a body that rendered nothing is a failure, whatever the HTTP status was', () => {
  const verdict = assertRendered('', NOTHING, 'https://hub.test')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /the shell loaded and the application did not mount/)
})

test('an empty body with no failed request names the likeliest cause', () => {
  // The bundle loaded with a 200 and threw on its first line. Nothing in the network log says so,
  // which is exactly why the message has to.
  assert.match(assertRendered('   ', NOTHING, 'x').reason, /threw on its first line/)
})

test('an empty body WITH a failed request names the request', () => {
  const collected: Collected = {
    ...NOTHING,
    failedRequests: [{ url: 'https://hub.test/assets/index-a1b2.js', method: 'GET', failure: 'HTTP 404' }],
  }
  const verdict = assertRendered('', collected, 'https://hub.test')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /HTTP 404 https:\/\/hub\.test\/assets\/index-a1b2\.js/)
})

test('the threshold is exclusive, so a body of exactly the minimum still fails', () => {
  // Off-by-one deliberately pinned: a shell whose only text is a fixed banner of exactly this
  // length would otherwise pass for ever.
  assert.equal(assertRendered('x'.repeat(MIN_RENDERED_LENGTH), NOTHING, 'x').ok, false)
  assert.equal(assertRendered('x'.repeat(MIN_RENDERED_LENGTH + 1), NOTHING, 'x').ok, true)
})

test('an uncaught exception fails even when the page rendered', () => {
  const collected: Collected = { ...NOTHING, pageErrors: ['ReferenceError: x is not defined'] }
  assert.equal(assertRendered('x'.repeat(200), collected, 'x').ok, true)
  const clean = assertClean(collected, 'web.hub')
  assert.equal(clean.ok, false)
  assert.match(clean.reason, /ReferenceError/)
})

test('a console error alone is reported and is NOT fatal', () => {
  // A journey that fails on any console.error is a journey that fails for ever for reasons nobody
  // owns — third-party widgets and browser extensions produce them.
  assert.equal(assertClean({ ...NOTHING, consoleErrors: ['third-party widget exploded'] }, 'x').ok, true)
})

test('a failed request fails, and the message names it', () => {
  const verdict = assertClean(
    { ...NOTHING, failedRequests: [{ url: 'https://api.test/v1/x', method: 'GET', failure: 'net::ERR_FAILED' }] },
    'web.hub',
  )
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /net::ERR_FAILED https:\/\/api\.test\/v1\/x/)
})

test('THE OBSERVABILITY SINK IS PARTITIONED, REPORTED, AND NEVER FATAL ON ITS OWN', () => {
  // Driving hub.<apex>/account/register against the running estate produced exactly this on all
  // three flows: `net::ERR_FAILED https://lantern.<apex>/ingest/browser`. Two real causes, neither
  // this repository's — lantern is not in the estate compose file at all, and the two sides
  // disagree on the path (obs.ts:51 posts /ingest/browser, lantern/src/server.ts:333 serves
  // /ingest/client). A journey that goes red because the ERROR REPORTER could not report is the
  // outage amplifier obs.ts's own rule 2 forbids, one layer up.
  const beaconFailure = {
    url: 'https://lantern.test/ingest/browser',
    method: 'POST',
    failure: 'net::ERR_FAILED',
  }
  assert.equal(assertClean({ ...NOTHING, observabilityFailures: [beaconFailure] }, 'x').ok, true)

  // Reported, not swallowed: when something else fails, the message says the reporter is down too.
  const verdict = assertClean(
    {
      ...NOTHING,
      observabilityFailures: [beaconFailure],
      failedRequests: [{ url: 'https://hub.test/assets/app.js', method: 'GET', failure: 'HTTP 404' }],
    },
    'web.hub',
  )
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /assets\/app\.js/)
  assert.match(verdict.reason, /NOT counted/)
})

test('the sink is recognised by PATH, so no hostname leaks into this repository', () => {
  assert.equal(isObservabilitySink('https://lantern.example.test/ingest/browser'), true)
  assert.equal(isObservabilitySink('https://anything.at.all/ingest/client'), true)
  // The product's own requests are never the sink, however similar they look.
  assert.equal(isObservabilitySink('https://hub.test/v1/dashboard'), false)
  assert.equal(isObservabilitySink('https://hub.test/ingest/browser/extra'), false)
  assert.equal(isObservabilitySink('not a url'), false)
})

test('attach files an observability failure apart from the product\u2019s own', () => {
  const sink = newSink()
  const handlers = new Map<string, (arg: unknown) => void>()
  attach({ on: (event, handler) => handlers.set(event, handler as (arg: unknown) => void) }, sink)

  handlers.get('response')?.({
    status: () => 404,
    url: () => 'https://lantern.test/ingest/browser',
    request: () => ({ method: () => 'POST' }),
  })
  handlers.get('requestfailed')?.({
    failure: () => ({ errorText: 'net::ERR_FAILED' }),
    url: () => 'https://lantern.test/ingest/browser',
    method: () => 'POST',
  })
  handlers.get('response')?.({
    status: () => 500,
    url: () => 'https://hub.test/v1/dashboard',
    request: () => ({ method: () => 'GET' }),
  })

  assert.equal(sink.observabilityFailures.length, 2)
  assert.deepEqual(sink.failedRequests.map((r) => r.failure), ['HTTP 500'])
})

test('A REFUSAL SCENARIO DECLARES THE ONE EXCHANGE IT EXPECTS, AND NOTHING WIDER', () => {
  // BJ-ACC-02 registers with a taken handle. Driven, the page produced
  // `HTTP409 https://nimbus.<apex>/auth/register` — the assertion, arriving in the same bucket as
  // a 404ing chunk.
  const taken = { url: 'https://nimbus.test/auth/register', method: 'POST', failure: 'HTTP 409' }
  const collected: Collected = { ...NOTHING, failedRequests: [taken] }
  const expected = [{ path: '/auth/register', status: 409 }]
  assert.equal(assertClean(collected, 'x', expected).ok, true)

  // Undeclared is still fatal: without the declaration the same exchange fails the journey, or
  // the exemption would be doing nothing.
  assert.equal(assertClean(collected, 'x').ok, false)

  // The RIGHT ROUTE WITH THE WRONG STATUS is not the expected refusal. A 500 from the route that
  // was supposed to answer 409 is the wrong outcome wearing the right address.
  const brokenInstead: Collected = {
    ...NOTHING,
    failedRequests: [{ ...taken, failure: 'HTTP 500' }],
  }
  assert.equal(assertClean(brokenInstead, 'x', expected).ok, false)

  // And the right status on ANOTHER route is not it either.
  const elsewhere: Collected = {
    ...NOTHING,
    failedRequests: [{ ...taken, url: 'https://nimbus.test/auth/login' }],
  }
  assert.equal(assertClean(elsewhere, 'x', expected).ok, false)
})

test('a cancelled navigation and a missing favicon are not failures', () => {
  // A SPA that routes during load cancels its own requests as designed, and a favicon nobody has
  // is a 404 on every surface in the estate.
  assert.equal(countsAsFailure('https://hub.test/x', 'net::ERR_ABORTED'), false)
  assert.equal(countsAsFailure('https://hub.test/favicon.ico', 'HTTP 404'), false)
  assert.equal(countsAsFailure('https://hub.test/assets/main.js', 'HTTP 404'), true)
})

test('a 4xx RESPONSE is collected, which requestfailed never fires for', () => {
  // Annotated rather than inferred. Three empty array literals infer as `never[]` under the
  // TypeScript the CI image resolves, and `sink.failedRequests[0].failure` is then a compile
  // error on a type nobody wrote — which is a build that fails in CI and passes on a machine with
  // an older resolution in node_modules. Exactly the drift a pinned annotation removes.
  const sink = newSink()
  const handlers = new Map<string, (arg: unknown) => void>()
  attach({ on: (event, handler) => handlers.set(event, handler as (arg: unknown) => void) }, sink)

  // A missing main chunk is a perfectly successful HTTP exchange whose answer is "no". Without
  // this listener the whole 404ing-bundle case is invisible to the collector.
  handlers.get('response')?.({
    status: () => 404,
    url: () => 'https://hub.test/assets/index-a1b2.js',
    request: () => ({ method: () => 'GET' }),
  })
  assert.equal(sink.failedRequests.length, 1)
  assert.equal(sink.failedRequests[0]?.failure, 'HTTP 404')

  handlers.get('response')?.({ status: () => 200, url: () => 'https://hub.test/ok.js', request: () => ({ method: () => 'GET' }) })
  assert.equal(sink.failedRequests.length, 1, 'a 200 is not a failure')
})

/* ------------------------------------------------------------------ availability */

test('a disabled browser is unavailable with the variable named, not with a bare false', () => {
  return browserAvailable({ enabled: false, executablePath: '', timeoutMs: 1000 }).then((state) => {
    assert.equal(state.ok, false)
    assert.match(state.ok ? '' : state.reason, /BEACON_BROWSER_ENABLED/)
  })
})

test('a browser path that does not exist is unavailable with the variable named', async () => {
  const state = await browserAvailable({
    enabled: true,
    executablePath: '/nowhere/chromium-that-is-not-here',
    timeoutMs: 1000,
  })
  assert.equal(state.ok, false)
  assert.match(state.ok ? '' : state.reason, /BEACON_BROWSER_EXECUTABLE/)
})

test('withPage skips rather than failing when there is no browser', async () => {
  await assert.rejects(
    () => withPage({ enabled: false, executablePath: '', timeoutMs: 1000 }, async () => undefined),
    // A lean deployment choosing not to ship a browser is a decision, not an outage — and a skip
    // is still not green, so the gate refuses on it either way.
    (err: unknown) => err instanceof JourneySkip,
  )
})

/* ------------------------------------------------------------------ the real browser half */

/** Two pages: one that mounts, one whose bundle is missing. */
async function serveBundles(): Promise<{ url: string; close(): Promise<void> }> {
  const shell = (script: string) =>
    `<!doctype html><html><head><title>surface</title><script type="module" src="${script}"></script></head><body><div id="root"></div></body></html>`

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path === '/good') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(shell('/assets/good.js'))
      return
    }
    if (path === '/broken') {
      // The whole point. The SHELL is a 200; the script it points at is not there.
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(shell('/assets/missing-a1b2c3.js'))
      return
    }
    if (path === '/assets/good.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(
        `document.getElementById('root').textContent = ` +
          `'Portfolio · Wallet · Activity · Security · Entitlements · Settings · Search';`,
      )
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const CONFIG: BrowserConfig = {
  enabled: true,
  // Empty lets playwright-core find its own Chromium, which is what a developer machine with an
  // ms-playwright cache has. A container sets BEACON_BROWSER_EXECUTABLE.
  executablePath: process.env['BEACON_BROWSER_EXECUTABLE'] ?? '',
  timeoutMs: 15_000,
}

const availability = await browserAvailable(CONFIG)
/**
 * Skipped, loudly, rather than silently absent.
 *
 * The pure half above proves the property in every run. This half proves the plumbing — that the
 * listeners fire, that a 404 script is really collected, that `document.body.innerText` really is
 * empty for an unmounted shell — and it needs a browser to do it. The reason is in the skip so
 * that "0 browser cases ran" is never a thing somebody has to work out.
 */
const noBrowser = availability.ok ? false : `no browser: ${availability.reason}`

test('a page that mounts passes both assertions', { skip: noBrowser }, async () => {
  const bundles = await serveBundles()
  try {
    await withPage(CONFIG, async (page, collected) => {
      const response = await page.goto(`${bundles.url}/good`, { waitUntil: 'domcontentloaded' })
      assert.equal(response?.status(), 200)
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      const text = await page.evaluate(() => document.body?.innerText ?? '')
      assert.equal(assertRendered(text, collected, 'good').ok, true, `rendered: ${JSON.stringify(text)}`)
      assert.equal(assertClean(collected, 'good').ok, true, JSON.stringify(collected.failedRequests))
    })
  } finally {
    await bundles.close()
  }
})

test('A PAGE WHOSE BUNDLE 404s GOES RED, even though the shell answered 200', { skip: noBrowser }, async () => {
  const bundles = await serveBundles()
  try {
    await withPage(CONFIG, async (page, collected) => {
      const response = await page.goto(`${bundles.url}/broken`, { waitUntil: 'domcontentloaded' })
      // The shell is fine. Every server-side check in this repository is green right here.
      assert.equal(response?.status(), 200, 'the shell must be a 200 or this proves nothing')
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

      const text = await page.evaluate(() => document.body?.innerText ?? '')
      const rendered = assertRendered(text, collected, 'broken')
      assert.equal(rendered.ok, false, 'a blank page must not pass')
      assert.match(rendered.reason, /did not mount/)

      // And the collector saw the missing chunk, which is the other half of the evidence: the
      // failure is named, not merely detected.
      const clean = assertClean(collected, 'broken')
      assert.equal(clean.ok, false)
      assert.match(clean.reason, /missing-a1b2c3\.js/)
    })
  } finally {
    await bundles.close()
  }
})

test('a page that renders but throws goes red on the exception', { skip: noBrowser }, async () => {
  const server: Server = createServer((req, res) => {
    if (req.url === '/boom.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(`document.getElementById('root').textContent = 'a'.repeat(200); throw new Error('mounted then exploded');`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><body><div id="root"></div><script src="/boom.js"></script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    await withPage(CONFIG, async (page, collected) => {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      const text = await page.evaluate(() => document.body?.innerText ?? '')
      // It rendered plenty. A length check alone would pass this, which is why assertClean exists.
      assert.equal(assertRendered(text, collected, 'boom').ok, true)
      assert.equal(assertClean(collected, 'boom').ok, false)
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('the package being installed is not the browser existing', async () => {
  // The CI failure this check exists for. `playwright-core` is installed there and no browser is
  // downloaded, so an availability check that stopped at the import reported yes and
  // `chromium.launch()` threw. In the service that is worse than a red build: a container with the
  // package and no browser would FAIL every browser journey instead of skipping it.
  const state = await browserAvailable({
    enabled: true,
    executablePath: '/definitely/not/a/browser',
    timeoutMs: 1000,
  })
  assert.equal(state.ok, false)
  assert.match(state.ok ? '' : state.reason, /no executable browser at/)
})

test('an available browser answers with the path it resolved', { skip: noBrowser }, async () => {
  const state = await browserAvailable(CONFIG)
  assert.equal(state.ok, true)
  // Returned rather than recomputed at launch, so the thing that was stat'd is the thing that is
  // launched. Two resolutions of "which browser" is one resolution too many.
  assert.ok(state.ok && state.executablePath.length > 0)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ALLOWANCE, AND THAT IT CANNOT WIDEN.
 *
 * `ExpectedFailure` now carries a host, and the console half honours the same triple. Both exist
 * for one entry — emberkin's `/v1/saves/me`, whose 404 IS the empty state — and the entire value
 * of the design is in what it refuses, so that is what is tested. A suppression that leaked to a
 * neighbouring host or to a different status would turn this tier's most useful signal into noise
 * it had been taught to ignore.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

const SAVES = { path: '/v1/saves/me', status: 404, host: 'emberkin.cloudsforge.localtest.me' }
const LINE = (status: number, url: string): string =>
  `Failed to load resource: the server responded with a status of ${status} () @ ${url}`

test('a console error naming NO resource is never excused — that is the page\'s own code', () => {
  const lines = ['ReferenceError: x is not defined']
  assert.deepEqual(unexpectedConsoleErrors(lines, [SAVES]), lines)
})

test('the paired console line for an allowed exchange is excused', () => {
  const lines = [LINE(404, 'https://emberkin.cloudsforge.localtest.me/v1/saves/me')]
  assert.deepEqual(unexpectedConsoleErrors(lines, [SAVES]), [])
})

test('the SAME path on ANOTHER HOST is not excused', () => {
  const lines = [LINE(404, 'https://nimbus.cloudsforge.localtest.me/v1/saves/me')]
  assert.deepEqual(unexpectedConsoleErrors(lines, [SAVES]), lines)
})

test('the same host and path with a DIFFERENT status is not excused', () => {
  const lines = [LINE(500, 'https://emberkin.cloudsforge.localtest.me/v1/saves/me')]
  assert.deepEqual(unexpectedConsoleErrors(lines, [SAVES]), lines)
})

test('a path the allowance does not name is not excused, even as a prefix of one that it does', () => {
  const lines = [LINE(404, 'https://emberkin.cloudsforge.localtest.me/v1/saves/me/achievements')]
  assert.deepEqual(unexpectedConsoleErrors(lines, [SAVES]), lines)
})

test('no allowances means nothing is filtered, and the array is handed back as it came', () => {
  const lines = [LINE(404, 'https://emberkin.cloudsforge.localtest.me/v1/saves/me')]
  assert.deepEqual(unexpectedConsoleErrors(lines, []), lines)
})

test('a message whose own text contains " @ " is not mistaken for a location', () => {
  assert.equal(consoleErrorResource('that address, a @ b, is not valid'), null)
  assert.equal(
    consoleErrorResource('rejected a @ b @ https://x.example/y')?.pathname,
    '/y',
  )
})

test('a failed REQUEST is bound to the host too, not just the path', () => {
  const at = (url: string): FailedRequest => ({ url, method: 'GET', failure: 'HTTP 404' })
  const own = { ...NOTHING, failedRequests: [at('https://emberkin.cloudsforge.localtest.me/v1/saves/me')] }
  const other = { ...NOTHING, failedRequests: [at('https://nimbus.cloudsforge.localtest.me/v1/saves/me')] }
  assert.equal(assertClean(own, 'emberkin', [SAVES]).ok, true)
  assert.equal(assertClean(other, 'emberkin', [SAVES]).ok, false)
})
