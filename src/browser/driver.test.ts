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
  countsAsFailure,
  withPage,
  type BrowserConfig,
  type Collected,
} from './driver.ts'
import { JourneySkip } from '../journeys.ts'

const NOTHING: Collected = { consoleErrors: [], pageErrors: [], failedRequests: [] }

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

test('a cancelled navigation and a missing favicon are not failures', () => {
  // A SPA that routes during load cancels its own requests as designed, and a favicon nobody has
  // is a 404 on every surface in the estate.
  assert.equal(countsAsFailure('https://hub.test/x', 'net::ERR_ABORTED'), false)
  assert.equal(countsAsFailure('https://hub.test/favicon.ico', 'HTTP 404'), false)
  assert.equal(countsAsFailure('https://hub.test/assets/main.js', 'HTTP 404'), true)
})

test('a 4xx RESPONSE is collected, which requestfailed never fires for', () => {
  const sink = { consoleErrors: [], pageErrors: [], failedRequests: [] }
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
