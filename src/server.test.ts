/**
 * The HTTP surface, driven over a real socket.
 *
 * The pre-auth projection is asserted on the RESPONSE BODY rather than on the projection function,
 * because that is what FEA-42 requires and because it is the only version of the test that would
 * still catch a leak introduced between `projectStatus` and the wire.
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { TokenError, type Principal } from '@cloudsforge/auth'
import { createServer, scrapeRefresh, type ServerDeps } from './server.ts'
import { openIncident } from './incidents.ts'
import { recordConformanceRun } from './conformance.ts'
import { recordCheck } from './probes.ts'
import { recordRun, runJourney, syncRegistry } from './journeys.ts'
import { recordObservation } from './slo.ts'
import {
  TIER2_PPM,
  db,
  fakeJourney,
  migrateTestDb,
  openDb,
  quietLogger,
  resetBeacon,
  seedProbe,
  seedSlo,
  skip,
  testMetrics,
} from './testsupport.ts'

const TOKEN = 'a-real-looking-break-glass-token-value'

/** A verifier that needs no JWKS. Admin for `admin-token`, a service for `service-token`. */
const verifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'admin-token') {
      return { kind: 'user', userId: 'u1', handle: 'ops', roles: ['admin'] }
    }
    if (token === 'user-token') {
      return { kind: 'user', userId: 'u2', handle: 'player', roles: ['player'] }
    }
    if (token === 'service-token') {
      return { kind: 'service', service: 'cfctl', scopes: ['beacon:read', 'beacon:gate'] }
    }
    throw new TokenError('unknown token', 'invalid')
  },
}

describe('the http surface', { skip }, () => {
  let sql: postgres.Sql
  let server: Server
  let base: string
  let publicStatus = false

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  beforeEach(async () => {
    await resetBeacon(sql)
    const metrics = testMetrics()
    const lifecycle = new Lifecycle()
    lifecycle.markReady()
    const deps: ServerDeps = {
      lifecycle,
      logger: quietLogger(),
      metrics,
      verifier,
      sql: db(sql),
      token: TOKEN,
      publicStatus,
      incidentWindowDays: 400,
      gate: { freshnessMs: 3_600_000, consecutiveGreen: 3 },
      beforeScrape: scrapeRefresh({ sql: db(sql), metrics }),
    }
    server = createServer(deps)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeIdleConnections()
      server.close(() => resolve())
    })
  })

  const call = (
    path: string,
    init: { method?: string; token?: string; bearer?: string; body?: unknown } = {},
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.token ? { 'x-beacon-token': init.token } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

  /* ---------------------------------------------------------------- health */

  it('serves /livez without a credential', async () => {
    assert.equal((await call('/livez')).status, 200)
  })

  it('serves /readyz without a credential', async () => {
    assert.equal((await call('/readyz')).status, 200)
  })

  it('answers 404 with a request id on an unknown route', async () => {
    const response = await call('/nope')
    assert.equal(response.status, 404)
    assert.ok(response.headers.get('x-request-id'))
  })

  /* ---------------------------------------------------------------- metrics */

  it('REFUSES /metrics without a credential', async () => {
    // The correction AD-20 needed. An open /metrics publishes the shape of the estate.
    assert.equal((await call('/metrics')).status, 401)
  })

  it('serves /metrics to the static token', async () => {
    const response = await call('/metrics', { token: TOKEN })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/)
  })

  it('refuses /metrics to a wrong static token of the same length', async () => {
    assert.equal((await call('/metrics', { token: 'a'.repeat(TOKEN.length) })).status, 401)
  })

  it('publishes beacon_up on every scrape', async () => {
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /^beacon_up 1$/m)
  })

  it('publishes beacon_target_up for a probe that has run', async () => {
    const probe = await seedProbe(sql, 'ledger.livez')
    await recordCheck(
      db(sql),
      probe,
      { state: 'up', statusCode: 200, latencyMs: 3, error: null },
      { failThreshold: 3, recoverThreshold: 2 },
    )
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /beacon_target_up\{probe="ledger\.livez",target="ledger",group="Wallet"\} 1/)
  })

  it('publishes NOTHING for a probe that has never run', async () => {
    await seedProbe(sql, 'ledger.livez')
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.equal(/beacon_target_up\{/.test(body), false)
  })

  it('publishes beacon_journey_status at 0.5 for a skip', async () => {
    const journey = fakeJourney('identity.register', async (ctx) => ctx.skip('no credentials'))
    await syncRegistry(db(sql), [journey])
    await recordRun(db(sql), await runJourney(journey))
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /beacon_journey_status\{journey="identity\.register",group="Account"\} 0\.5/)
  })

  it('publishes the journey staleness timestamp', async () => {
    const journey = fakeJourney('identity.register', async () => {})
    await syncRegistry(db(sql), [journey])
    await recordRun(db(sql), await runJourney(journey))
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /beacon_journey_last_run_timestamp_seconds\{journey="identity\.register"\} \d+/)
  })

  it('publishes the muted count', async () => {
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /^beacon_journeys_muted 0$/m)
  })

  it('publishes conformance vectors by result', async () => {
    await recordConformanceRun(db(sql), {
      suite: 'wallet',
      status: 'fail',
      identical: 57,
      breaking: 1,
    })
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /beacon_conformance_vectors\{suite="wallet",result="failed"\} 1/)
  })

  /**
   * micro-org#310, the conformance row.
   *
   * These four assert on the SCRAPED BODY rather than on `scrapeRefresh`, because the defect the
   * issue names is precisely a metric that exists in code and not on the wire — and the reason
   * `beacon_conformance_vectors` was measured absent from the estate on 2026-08-09 is that a gauge
   * with no samples renders as help text alone and Prometheus never learns the name.
   */
  it('publishes NO conformance vectors when no suite has ever run', async () => {
    // The honest empty, and the one that must stay empty: a vector count needs a suite to belong
    // to, and there is no suite to name. This is the state the estate has been in since the table
    // was created.
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.equal(/beacon_conformance_vectors\{/.test(body), false)
  })

  it('STILL publishes beacon_conformance_suites when no suite has ever run', async () => {
    // The series that makes the empty above readable instead of mysterious. All four zeroes on a
    // fresh estate; `sum() == 0` is "no corpus has been replayed", which is a different fact from
    // "everything passes" and, before this, was a fact no scrape could carry.
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /^beacon_conformance_suites\{status="pass"\} 0$/m)
    assert.match(body, /^beacon_conformance_suites\{status="fail"\} 0$/m)
    assert.match(body, /^beacon_conformance_suites\{status="skip"\} 0$/m)
    assert.match(body, /^beacon_conformance_suites\{status="error"\} 0$/m)
  })

  it('counts a suite under the status of its most recent run', async () => {
    await recordConformanceRun(db(sql), {
      suite: 'wallet',
      status: 'fail',
      identical: 57,
      breaking: 1,
    })
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /^beacon_conformance_suites\{status="fail"\} 1$/m)
    // And the zero is still there. A `fail` that emptied `pass` would leave an alert on `pass`
    // evaluating a stale sample rather than a zero.
    assert.match(body, /^beacon_conformance_suites\{status="pass"\} 0$/m)
  })

  it('NEVER counts a skipped suite as a passing one', async () => {
    // The same rule `conformance.ts` states and `gate.ts` enforces, now on the wire: a suite that
    // could not be run is not a suite that passed. A gauge that folded `skip` into `pass` would
    // report a corpus nobody executed as a corpus that is green.
    await recordConformanceRun(db(sql), { suite: 'chain', status: 'skip', skipped: 8 })
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /^beacon_conformance_suites\{status="skip"\} 1$/m)
    assert.match(body, /^beacon_conformance_suites\{status="pass"\} 0$/m)
  })

  it('publishes a zero for every severity with no open incident', async () => {
    // A series that stops when the last incident closes leaves an alert evaluating a stale sample
    // rather than a zero.
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /beacon_incidents_open\{severity="sev1"\} 0/)
  })

  it('publishes the error budget as a ratio and as whole events', async () => {
    await seedSlo(sql, 'ledger.availability', TIER2_PPM)
    await recordObservation(db(sql), 'ledger.availability', new Date(), 1_000n, 1_000n)
    const body = await (await call('/metrics', { token: TOKEN })).text()
    assert.match(body, /beacon_slo_budget_remaining_ratio\{slo="ledger\.availability"\} 1/)
    assert.match(body, /beacon_slo_budget_remaining_events\{slo="ledger\.availability"\} 5/)
  })

  /* ---------------------------------------------------------------- the gate */

  it('refuses the gate without a credential', async () => {
    assert.equal((await call('/v1/gate?release=v1')).status, 401)
  })

  it('answers the gate with 200 and a refusal body, not a 4xx', async () => {
    // A refused release must not be indistinguishable from a malformed request to a retry wrapper.
    const response = await call('/v1/gate?release=v1', { token: TOKEN })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { decision: string; promote: boolean }
    assert.equal(body.decision, 'refuse')
    assert.equal(body.promote, false)
  })

  it('reports indeterminate on the wire', async () => {
    const body = (await (await call('/v1/gate?release=v1', { token: TOKEN })).json()) as {
      indeterminate: boolean
      reasons: { code: string }[]
    }
    assert.equal(body.indeterminate, true)
    assert.ok(body.reasons.some((reason) => reason.code === 'conformance_never_run'))
  })

  it('refuses a malformed release tag', async () => {
    assert.equal((await call('/v1/gate?release=../etc', { token: TOKEN })).status, 400)
  })

  it('refuses a missing release tag', async () => {
    assert.equal((await call('/v1/gate', { token: TOKEN })).status, 400)
  })

  it('does NOT record on a GET', async () => {
    await call('/v1/gate?release=v1', { token: TOKEN })
    const rows = (await sql`select count(*)::int as n from gate_decisions`) as unknown as {
      n: number
    }[]
    assert.equal(rows[0]?.n, 0)
  })

  it('records on a POST', async () => {
    await call('/v1/gate?release=v1', { method: 'POST', token: TOKEN })
    const rows = (await sql`select count(*)::int as n from gate_decisions`) as unknown as {
      n: number
    }[]
    assert.equal(rows[0]?.n, 1)
  })

  it('accepts a service token carrying beacon:gate', async () => {
    assert.equal((await call('/v1/gate?release=v1', { bearer: 'service-token' })).status, 200)
  })

  it('serves the decision history', async () => {
    await call('/v1/gate?release=v1', { method: 'POST', token: TOKEN })
    const body = (await (await call('/v1/gate/history?release=v1', { token: TOKEN })).json()) as {
      decisions: unknown[]
    }
    assert.equal(body.decisions.length, 1)
  })

  /* ---------------------------------------------------------------- overrides */

  it('records an override for an admin', async () => {
    const response = await call('/v1/gate/overrides', {
      method: 'POST',
      bearer: 'admin-token',
      body: {
        release: 'v1',
        reasonCode: 'journey_failing',
        reason: 'known upstream outage, fix is in this release',
        ttlMs: 3_600_000,
      },
    })
    assert.equal(response.status, 201)
  })

  it('REFUSES an override of an indeterminate reason code with a 422', async () => {
    const response = await call('/v1/gate/overrides', {
      method: 'POST',
      bearer: 'admin-token',
      body: {
        release: 'v1',
        reasonCode: 'journey_stale',
        reason: 'the scheduler is down, ship anyway',
        ttlMs: 3_600_000,
      },
    })
    // 422, not 400: the request was well formed and the gate refused it on policy.
    assert.equal(response.status, 422)
  })

  it('refuses an override from a non-admin user', async () => {
    const response = await call('/v1/gate/overrides', {
      method: 'POST',
      bearer: 'user-token',
      body: {
        release: 'v1',
        reasonCode: 'journey_failing',
        reason: 'known upstream outage, fix is in this release',
        ttlMs: 3_600_000,
      },
    })
    assert.equal(response.status, 403)
  })

  it('ATTRIBUTES the override to who authenticated, never to the body', async () => {
    await call('/v1/gate/overrides', {
      method: 'POST',
      bearer: 'admin-token',
      body: {
        release: 'v1',
        reasonCode: 'journey_failing',
        reason: 'known upstream outage, fix is in this release',
        requestedBy: 'somebody-else',
        ttlMs: 3_600_000,
      },
    })
    const rows = (await sql`select requested_by from gate_overrides`) as unknown as {
      requested_by: string
    }[]
    assert.equal(rows[0]?.requested_by, 'user:u1')
  })

  /* ---------------------------------------------------------------- public status */

  it('refuses the public projection while BEACON_PUBLIC_STATUS is off', async () => {
    assert.equal((await call('/api/status/public')).status, 401)
  })

  describe('served pre-auth', () => {
    before(() => {
      publicStatus = true
    })
    after(() => {
      publicStatus = false
    })

    it('serves the projection with no credential', async () => {
      assert.equal((await call('/api/status/public')).status, 200)
    })

    it('NAMES NO INTERNAL TARGET IN THE PRE-AUTH RESPONSE BODY', async () => {
      // FEA-42's acceptance criterion, asserted on the wire.
      await seedProbe(sql, 'ledger.postings', { target: 'ledger', productGroup: 'Wallet' })
      await openIncident(db(sql), {
        scope: 'probe',
        subject: 'ledger.postings',
        severity: 'sev2',
        productGroup: 'Wallet',
        lastError: 'ECONNREFUSED 10.4.2.19:5432',
        cause: 'the primary replica stopped accepting writes',
      })
      const body = await (await call('/api/status/public')).text()
      for (const leak of ['ledger.postings', 'ECONNREFUSED', '10.4.2.19', 'primary replica']) {
        assert.equal(body.includes(leak), false, `"${leak}" reached the pre-auth body`)
      }
    })

    it('names the product group instead', async () => {
      await seedProbe(sql, 'ledger.postings', { productGroup: 'Wallet' })
      const body = (await (await call('/api/status/public')).json()) as {
        groups: { group: string }[]
      }
      assert.deepEqual(
        body.groups.map((group) => group.group),
        ['Wallet'],
      )
    })

    it('carries no latency, error rate or replica count', async () => {
      await seedProbe(sql, 'ledger.postings')
      const body = await (await call('/api/status/public')).text()
      assert.equal(/latency|errorRate|replicas|p95|p99/.test(body), false)
    })
  })

  /* ---------------------------------------------------------------- alertmanager */

  it('opens an incident from an Alertmanager webhook', async () => {
    const response = await call('/api/alerts/webhook', {
      method: 'POST',
      token: TOKEN,
      body: {
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'LedgerDown', service: 'ledger', severity: 'critical', team: 'Wallet' },
            annotations: { summary: 'the ledger is not answering' },
          },
        ],
      },
    })
    assert.equal(response.status, 200)
    const rows = (await sql`select subject, severity from incidents`) as unknown as {
      subject: string
      severity: string
    }[]
    assert.equal(rows[0]?.subject, 'ledger/LedgerDown')
    assert.equal(rows[0]?.severity, 'sev1')
  })

  it('closes it again on the resolved delivery', async () => {
    const alert = {
      labels: { alertname: 'LedgerDown', service: 'ledger', severity: 'critical', team: 'Wallet' },
    }
    await call('/api/alerts/webhook', {
      method: 'POST',
      token: TOKEN,
      body: { alerts: [{ ...alert, status: 'firing' }] },
    })
    await call('/api/alerts/webhook', {
      method: 'POST',
      token: TOKEN,
      body: { alerts: [{ ...alert, status: 'resolved' }] },
    })
    const rows = (await sql`select closed_at from incidents`) as unknown as {
      closed_at: Date | null
    }[]
    assert.notEqual(rows[0]?.closed_at, null)
  })

  it('dedupes a redelivered alert into one incident', async () => {
    const body = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'LedgerDown', service: 'ledger', severity: 'critical' },
        },
      ],
    }
    for (let i = 0; i < 4; i++) {
      await call('/api/alerts/webhook', { method: 'POST', token: TOKEN, body })
    }
    const rows = (await sql`select count(*)::int as n from incidents`) as unknown as { n: number }[]
    assert.equal(rows[0]?.n, 1)
  })

  it('refuses an unauthenticated webhook', async () => {
    // An incident-opening endpoint anyone can reach is a way to put a false outage on the public
    // status page.
    assert.equal((await call('/api/alerts/webhook', { method: 'POST', body: {} })).status, 401)
  })

  it('ALERTMANAGER CAN OPEN AN INCIDENT, WHICH MEANS THE TOKEN IS TAKEN AS A BEARER', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // micro-org#311. Alertmanager's `webhook_configs` has `basic_auth`, `authorization` and
    // `oauth2`, and NO way to set an arbitrary header — so a route that only reads
    // `x-beacon-token` is a route Alertmanager cannot reach. On mainnet every delivery to this
    // endpoint failed 401 while `BeaconScrapeFailing` fired correctly for four days.
    //
    // The assertion is the incident ROW and not the status code: a 200 from a handler that
    // authorised and then did nothing would be the same failure with a better colour.
    // ════════════════════════════════════════════════════════════════════════════════════════
    const response = await call('/api/alerts/webhook', {
      method: 'POST',
      bearer: TOKEN,
      body: {
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'BeaconScrapeFailing', service: 'beacon', severity: 'critical' },
          },
        ],
      },
    })
    assert.equal(response.status, 200)
    const rows = (await sql`select subject from incidents`) as unknown as { subject: string }[]
    assert.equal(rows[0]?.subject, 'beacon/BeaconScrapeFailing')
  })

  it('the token presented as a bearer is STILL not an administrator', async () => {
    // The whole point of the header change is that it moves one credential and no privilege. A
    // break-glass that could mute a journey would be a shared secret that can silence the thing
    // watching the estate — and it would arrive in the header a client is most likely to set from
    // an environment variable by reflex.
    const response = await call('/v1/journeys/checkout/mute', {
      method: 'POST',
      bearer: TOKEN,
      body: { muted: true, reason: 'a reason long enough to be accepted' },
    })
    assert.equal(response.status, 403)
  })

  it('an EMPTY configured token is not a credential anybody can present', async () => {
    // `BEACON_TOKEN` interpolates to '' in the estate compose file when it is unset, and the two
    // header paths must agree that nothing matches nothing. Presented empty, both are absent
    // headers as far as fetch is concerned, so this asserts the closest reachable case: a caller
    // sending an empty-looking credential gets 401 and not a service principal.
    for (const init of [{ token: ' ' }, { bearer: ' ' }] as const) {
      const response = await call('/api/alerts/webhook', { method: 'POST', body: {}, ...init })
      assert.equal(response.status, 401, `${JSON.stringify(init)} was accepted`)
    }
  })

  it('keeps a misspelled severity label rather than dropping the alert', async () => {
    await call('/api/alerts/webhook', {
      method: 'POST',
      token: TOKEN,
      body: {
        alerts: [{ status: 'firing', labels: { alertname: 'Odd', severity: 'urgentish' } }],
      },
    })
    const rows = (await sql`select severity from incidents`) as unknown as { severity: string }[]
    assert.equal(rows[0]?.severity, 'sev3')
  })

  /* ---------------------------------------------------------------- the rest */

  it('lists probes with their state', async () => {
    await seedProbe(sql, 'ledger.livez')
    const body = (await (await call('/v1/probes', { token: TOKEN })).json()) as {
      probes: { name: string; state: string }[]
    }
    assert.equal(body.probes[0]?.state, 'pending')
  })

  it('creates a probe for an admin', async () => {
    const response = await call('/v1/probes/market.livez', {
      method: 'PUT',
      bearer: 'admin-token',
      body: {
        target: 'market',
        productGroup: 'Market',
        url: 'http://market:4000/livez',
        intervalMs: 30_000,
        deadlineMs: 5_000,
      },
    })
    assert.equal(response.status, 200)
  })

  it('refuses a probe whose deadline is not below its interval', async () => {
    const response = await call('/v1/probes/bad.livez', {
      method: 'PUT',
      bearer: 'admin-token',
      body: {
        target: 'market',
        productGroup: 'Market',
        url: 'http://market:4000/livez',
        intervalMs: 5_000,
        deadlineMs: 5_000,
      },
    })
    assert.equal(response.status, 500)
  })

  it('refuses a mute with no reason', async () => {
    await syncRegistry(db(sql), [fakeJourney('identity.register', async () => {})])
    const response = await call('/v1/journeys/identity.register/mute', {
      method: 'POST',
      bearer: 'admin-token',
      body: { muted: true },
    })
    assert.equal(response.status, 400)
  })

  it('mutes with a reason and attributes it', async () => {
    await syncRegistry(db(sql), [fakeJourney('identity.register', async () => {})])
    const response = await call('/v1/journeys/identity.register/mute', {
      method: 'POST',
      bearer: 'admin-token',
      body: { muted: true, reason: 'flaky since the identity deploy' },
    })
    assert.equal(response.status, 200)
    const rows = (await sql`select muted_by from journeys`) as unknown as { muted_by: string }[]
    assert.equal(rows[0]?.muted_by, 'user:u1')
  })

  it('serves budgets as strings, never as JSON numbers', async () => {
    await seedSlo(sql, 'ledger.availability', TIER2_PPM)
    await recordObservation(db(sql), 'ledger.availability', new Date(), 1_000n, 1_000n)
    const body = (await (await call('/v1/slos', { token: TOKEN })).json()) as {
      budgets: { total: unknown }[]
    }
    // A JSON number above 2^53 has already lost its low bits by the time anyone reads it.
    assert.equal(typeof body.budgets[0]?.total, 'string')
  })

  it('refuses an objective sent as a JSON number', async () => {
    const response = await call('/v1/slos/ledger.availability', {
      method: 'PUT',
      bearer: 'admin-token',
      body: { service: 'ledger', tier: 1, kind: 'availability', objectivePpm: 999500 },
    })
    assert.equal(response.status, 400)
  })

  it('accepts an objective sent as a decimal string', async () => {
    const response = await call('/v1/slos/ledger.availability', {
      method: 'PUT',
      bearer: 'admin-token',
      body: { service: 'ledger', tier: 1, kind: 'availability', objectivePpm: '999500' },
    })
    assert.equal(response.status, 200)
  })

  it('derives a conformance status from the counts rather than trusting the caller', async () => {
    const response = await call('/v1/conformance', {
      method: 'POST',
      token: TOKEN,
      body: { suite: 'wallet', identical: 57, breaking: 1, status: 'pass' },
    })
    assert.equal(response.status, 201)
    const rows = (await sql`select status from conformance_runs`) as unknown as {
      status: string
    }[]
    assert.equal(rows[0]?.status, 'fail')
  })

  it('lists open incidents', async () => {
    await openIncident(db(sql), {
      scope: 'probe',
      subject: 'ledger.postings',
      severity: 'sev2',
      productGroup: 'Wallet',
    })
    const body = (await (await call('/v1/incidents?open=true', { token: TOKEN })).json()) as {
      incidents: unknown[]
    }
    assert.equal(body.incidents.length, 1)
  })

  it('rejects a body that is not a JSON object', async () => {
    const response = await fetch(`${base}/v1/incidents`, {
      method: 'POST',
      headers: { 'x-beacon-token': TOKEN, 'content-type': 'application/json' },
      body: '[1,2,3]',
    })
    assert.equal(response.status, 400)
  })

  /* ------------------------------------------------- the break-glass token is not an admin */

  /**
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * ONE STATIC SHARED SECRET MUST NOT BE A FULL ADMINISTRATIVE CREDENTIAL.
   *
   * `BEACON_TOKEN` is a long-lived value sitting in the estate compose file, in Prometheus's
   * secrets directory and in CI. Four routes are declared `adminOnly`, and until this section
   * existed all four admitted it: `authorise` returned on the token match BEFORE the `adminOnly`
   * branch was reached, so the declaration was decorative on exactly the routes that decide
   * whether a release may ship.
   *
   * Each case below is a route that answered 2xx to the static token before the fix. They are the
   * proof, not the guard — the guards are the section underneath.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */

  it('REFUSES a gate override to the static break-glass token', async () => {
    const response = await call('/v1/gate/overrides', {
      method: 'POST',
      token: TOKEN,
      body: {
        release: 'v1',
        reasonCode: 'journey_failing',
        reason: 'holding the shared secret is not being an administrator',
        ttlMs: 3_600_000,
      },
    })
    // 403 rather than 401: the credential WAS recognised, and an operator who gets a bare 401
    // here retries with the same token instead of reaching for an identity.
    assert.equal(response.status, 403)
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    assert.equal(body.error?.code, 'forbidden')
    // Names what is missing. "role:admin" is what sends an operator to an identity rather than
    // back to the same token.
    assert.match(body.error?.message ?? '', /role:admin/)
    // Nothing was written. A 403 that still recorded the override would be worse than no check.
    const rows = (await sql`select count(*)::int as n from gate_overrides`) as unknown as {
      n: number
    }[]
    assert.equal(rows[0]?.n, 0)
  })

  it('REFUSES a probe write to the static break-glass token', async () => {
    const response = await call('/v1/probes/market.livez', {
      method: 'PUT',
      token: TOKEN,
      body: {
        target: 'market',
        productGroup: 'Market',
        url: 'http://market:4000/livez',
        intervalMs: 30_000,
        deadlineMs: 5_000,
      },
    })
    assert.equal(response.status, 403)
    const rows = (await sql`select count(*)::int as n from probes`) as unknown as { n: number }[]
    assert.equal(rows[0]?.n, 0)
  })

  it('REFUSES a journey mute to the static break-glass token', async () => {
    // The one that matters most. A mute silences a journey, and a silenced journey is a green
    // gate — so a credential that can mute is a credential that can approve its own release.
    await syncRegistry(db(sql), [fakeJourney('identity.register', async () => {})])
    const response = await call('/v1/journeys/identity.register/mute', {
      method: 'POST',
      token: TOKEN,
      body: { muted: true, reason: 'silencing the thing that is watching me' },
    })
    assert.equal(response.status, 403)
    const rows = (await sql`select muted from journeys`) as unknown as { muted: boolean }[]
    assert.equal(rows[0]?.muted, false)
  })

  it('REFUSES an SLO write to the static break-glass token', async () => {
    const response = await call('/v1/slos/ledger.availability', {
      method: 'PUT',
      token: TOKEN,
      body: { service: 'ledger', tier: 1, kind: 'availability', objectivePpm: '999500' },
    })
    assert.equal(response.status, 403)
    const rows = (await sql`select count(*)::int as n from slos`) as unknown as { n: number }[]
    assert.equal(rows[0]?.n, 0)
  })

  it('refuses EVERY adminOnly route to the static token, enumerated from one list', async () => {
    // Enumerated rather than trusted to the four cases above: a fifth `adminOnly` route added
    // later is the one nobody writes a case for. If this list and `server.ts` drift, that is a
    // review finding — but a list of four that all pass is still four assertions, not zero.
    const adminOnly: readonly [string, string][] = [
      ['POST', '/v1/gate/overrides'],
      ['PUT', '/v1/probes/some.probe'],
      ['POST', '/v1/journeys/some.journey/mute'],
      ['PUT', '/v1/slos/some.slo'],
    ]
    for (const [method, path] of adminOnly) {
      const response = await call(path, { method, token: TOKEN, body: {} })
      assert.equal(response.status, 403, `${method} ${path} admitted the static token`)
    }
  })

  /* ------------------------------------------------- and it keeps everything it is deployed for */

  /**
   * Guards, not proof: these passed before the fix too. They are here because the cost of getting
   * this wrong in the other direction is a blind Prometheus, an Alertmanager that cannot open an
   * incident, and a CI job that cannot ask the gate — every one of them a holder of this token
   * with no identity to fall back on.
   */

  it('still admits the static token to /metrics, the gate, the webhook and conformance', async () => {
    assert.equal((await call('/metrics', { token: TOKEN })).status, 200)
    assert.equal((await call('/v1/gate?release=v1', { token: TOKEN })).status, 200)
    assert.equal(
      (await call('/api/alerts/webhook', { method: 'POST', token: TOKEN, body: { alerts: [] } }))
        .status,
      200,
    )
    assert.equal(
      (
        await call('/v1/conformance', {
          method: 'POST',
          token: TOKEN,
          body: { suite: 'wallet', identical: 57, breaking: 0 },
        })
      ).status,
      201,
    )
  })

  it('admits an admin bearer on an adminOnly route even when the static token is also sent', async () => {
    // The static token must not COUNT on these routes; it must not POISON them either. A client
    // that sets the header from an environment variable and also signs in is not an attacker.
    const response = await call('/v1/slos/ledger.availability', {
      method: 'PUT',
      token: TOKEN,
      bearer: 'admin-token',
      body: { service: 'ledger', tier: 1, kind: 'availability', objectivePpm: '999500' },
    })
    assert.equal(response.status, 200)
  })

  it('attributes an adminOnly write to the identity, never to service:beacon-token', async () => {
    await syncRegistry(db(sql), [fakeJourney('identity.register', async () => {})])
    await call('/v1/journeys/identity.register/mute', {
      method: 'POST',
      token: TOKEN,
      bearer: 'admin-token',
      body: { muted: true, reason: 'a real person, named in the record' },
    })
    const rows = (await sql`select muted_by from journeys`) as unknown as { muted_by: string }[]
    assert.equal(rows[0]?.muted_by, 'user:u1')
  })
})
