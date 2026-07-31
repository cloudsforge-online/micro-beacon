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
})
