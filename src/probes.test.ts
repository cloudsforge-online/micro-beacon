/**
 * Probe execution and hysteresis.
 *
 * The deadline test is the one that matters. `fakeTarget().hang(true)` accepts the socket and then
 * writes nothing, which is what a wedged upstream actually looks like — a genuinely different
 * failure from a refused connection, and the only one that can hold a job lease open for ever.
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import { execute, listStates, recordCheck, stateValue, upsertProbe, type Probe } from './probes.ts'
import {
  db,
  fakeTarget,
  migrateTestDb,
  openDb,
  resetBeacon,
  seedProbe,
  skip,
  type FakeTarget,
} from './testsupport.ts'

const THRESHOLDS = { failThreshold: 3, recoverThreshold: 2 }

function probeFor(url: string, overrides: Partial<Probe> = {}): Probe {
  return {
    id: 'p1',
    name: 'ledger.livez',
    target: 'ledger',
    productGroup: 'Wallet',
    url,
    method: 'GET',
    expectStatus: 200,
    intervalMs: 30_000,
    deadlineMs: 5_000,
    critical: true,
    enabled: true,
    ...overrides,
  }
}

describe('a probe that hangs is a probe that fails', () => {
  let target: FakeTarget

  beforeEach(async () => {
    target = await fakeTarget()
  })
  afterEach(async () => {
    await target.close()
  })

  it('records a hung target as DOWN rather than leaving it pending', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // The socket is accepted and nothing is ever written. Without the race in `execute`, this
    // await never settles, the job holds its lease until it expires, another replica claims it
    // and hangs on the same socket, and the monitor goes quiet exactly when the estate is in
    // trouble.
    // ════════════════════════════════════════════════════════════════════════════════════════
    target.hang(true)
    const started = Date.now()
    const result = await execute(probeFor(`${target.baseUrl}/livez`, { deadlineMs: 150 }))
    const elapsed = Date.now() - started

    assert.equal(result.state, 'down')
    assert.match(result.error ?? '', /deadline exceeded/)
    // Bounded well below the five-second default, so this asserts the DEADLINE fired rather than
    // some other timeout happening to land first.
    assert.ok(elapsed < 2_000, `took ${elapsed}ms`)
  })

  it('never throws on a hung target', async () => {
    target.hang(true)
    // A throw would reach the job runner as a handler failure, be retried with backoff and
    // dead-lettered after five attempts — so a target that was merely down would end up deleting
    // its own monitoring.
    await assert.doesNotReject(() =>
      execute(probeFor(`${target.baseUrl}/livez`, { deadlineMs: 100 })),
    )
  })

  it('reports the deadline as the latency rather than a partial measurement', async () => {
    target.hang(true)
    const result = await execute(probeFor(`${target.baseUrl}/livez`, { deadlineMs: 120 }))
    assert.equal(result.latencyMs, 120)
  })

  it('records a hung probe as a real check row, not a gap', { skip }, async () => {
    const sql = openDb()
    try {
      await migrateTestDb(sql)
      await resetBeacon(sql)
      const probe = await seedProbe(sql, 'ledger.livez', {
        url: `${target.baseUrl}/livez`,
        deadlineMs: 120,
      })
      target.hang(true)
      const result = await execute(probe)
      await recordCheck(db(sql), probe, result, THRESHOLDS)
      const rows = (await sql`select state, error from checks`) as unknown as {
        state: string
        error: string
      }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.state, 'down')
      assert.match(rows[0]?.error ?? '', /deadline exceeded/)
    } finally {
      await sql.end({ timeout: 5 })
    }
  })

  it('is up when the target answers', async () => {
    const result = await execute(probeFor(`${target.baseUrl}/livez`))
    assert.equal(result.state, 'up')
    assert.equal(result.statusCode, 200)
  })

  it('is down on the wrong status code', async () => {
    target.setStatus(503)
    const result = await execute(probeFor(`${target.baseUrl}/livez`))
    assert.equal(result.state, 'down')
    assert.match(result.error ?? '', /expected 200, got 503/)
  })

  it('is degraded when it answers slowly', async () => {
    const result = await execute(probeFor(`${target.baseUrl}/livez`), { slowMs: 0 })
    assert.equal(result.state, 'degraded')
  })

  it('is down when nothing is listening', async () => {
    const result = await execute(probeFor('http://127.0.0.1:1/livez', { deadlineMs: 2_000 }))
    assert.equal(result.state, 'down')
    assert.equal(result.statusCode, null)
  })

  it('does not follow a redirect', async () => {
    // A probe that silently follows a 302 reports the health of whatever it was redirected to,
    // which on a misconfigured gateway is a login page answering 200 for every dead service.
    target.setStatus(302)
    const result = await execute(probeFor(`${target.baseUrl}/livez`))
    assert.equal(result.statusCode, 302)
    assert.equal(result.state, 'down')
  })
})

describe('the metric value of a state', () => {
  it('publishes 1 for up', () => {
    assert.equal(stateValue('up'), 1)
  })
  it('publishes 0.5 for degraded', () => {
    assert.equal(stateValue('degraded'), 0.5)
  })
  it('publishes 0 for down', () => {
    assert.equal(stateValue('down'), 0)
  })
  it('publishes NOTHING for a probe that has never run', () => {
    // Not 0. A gap in a graph is readable; a zero would make every deploy look like an outage
    // for the first cycle after it.
    assert.equal(stateValue('pending'), null)
  })
})

describe('hysteresis', { skip }, () => {
  let sql: postgres.Sql
  let probe: Probe

  const down = { state: 'down' as const, statusCode: null, latencyMs: 5, error: 'refused' }
  const up = { state: 'up' as const, statusCode: 200, latencyMs: 5, error: null }

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetBeacon(sql)
    probe = await seedProbe(sql, 'ledger.livez')
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  it('does not open on one failure', async () => {
    const recorded = await recordCheck(db(sql), probe, down, THRESHOLDS)
    assert.equal(recorded.transition, null)
    assert.equal(recorded.reported, 'pending')
  })

  it('does not open on two failures', async () => {
    await recordCheck(db(sql), probe, down, THRESHOLDS)
    const recorded = await recordCheck(db(sql), probe, down, THRESHOLDS)
    assert.equal(recorded.transition, null)
  })

  it('opens on the third consecutive failure', async () => {
    await recordCheck(db(sql), probe, down, THRESHOLDS)
    await recordCheck(db(sql), probe, down, THRESHOLDS)
    const recorded = await recordCheck(db(sql), probe, down, THRESHOLDS)
    assert.equal(recorded.transition, 'opened')
    assert.equal(recorded.reported, 'down')
  })

  it('does not open twice while it stays down', async () => {
    for (let i = 0; i < 3; i++) await recordCheck(db(sql), probe, down, THRESHOLDS)
    const recorded = await recordCheck(db(sql), probe, down, THRESHOLDS)
    assert.equal(recorded.transition, null)
    assert.equal(recorded.consecutiveFail, 4)
  })

  it('resets the failure count on a single success', async () => {
    await recordCheck(db(sql), probe, down, THRESHOLDS)
    await recordCheck(db(sql), probe, down, THRESHOLDS)
    await recordCheck(db(sql), probe, up, THRESHOLDS)
    const recorded = await recordCheck(db(sql), probe, down, THRESHOLDS)
    assert.equal(recorded.consecutiveFail, 1)
    assert.equal(recorded.transition, null)
  })

  it('does not close on one success', async () => {
    for (let i = 0; i < 3; i++) await recordCheck(db(sql), probe, down, THRESHOLDS)
    const recorded = await recordCheck(db(sql), probe, up, THRESHOLDS)
    assert.equal(recorded.transition, null)
    assert.equal(recorded.reported, 'down')
  })

  it('closes on the second consecutive success', async () => {
    for (let i = 0; i < 3; i++) await recordCheck(db(sql), probe, down, THRESHOLDS)
    await recordCheck(db(sql), probe, up, THRESHOLDS)
    const recorded = await recordCheck(db(sql), probe, up, THRESHOLDS)
    assert.equal(recorded.transition, 'closed')
    assert.equal(recorded.reported, 'up')
  })

  it('produces no paired open/close from a flapping target', async () => {
    // down, up, down, up, down, up — no run of three or of two. A monitor that paged on this is a
    // monitor whose channel gets muted, and a muted channel is worse than no channel.
    const transitions: unknown[] = []
    for (const result of [down, up, down, up, down, up]) {
      const recorded = await recordCheck(db(sql), probe, result, THRESHOLDS)
      if (recorded.transition) transitions.push(recorded.transition)
    }
    assert.deepEqual(transitions, [])
  })

  it('records every check regardless of the reported state', async () => {
    for (const result of [down, up, down]) await recordCheck(db(sql), probe, result, THRESHOLDS)
    const rows = (await sql`select count(*)::int as n from checks`) as unknown as { n: number }[]
    assert.equal(rows[0]?.n, 3)
  })

  it('moves `since` only on a transition', async () => {
    const at = new Date('2026-07-31T10:00:00.000Z')
    await recordCheck(db(sql), probe, up, THRESHOLDS, at)
    const first = (await listStates(db(sql)))[0]?.since
    await recordCheck(db(sql), probe, up, THRESHOLDS, new Date(at.getTime() + 30_000))
    const second = (await listStates(db(sql)))[0]?.since
    assert.deepEqual(first, second)
  })

  it('starts a probe that has never run with a null updated_at, so it is due at once', async () => {
    await upsertProbe(db(sql), { ...probe, name: 'market.livez', target: 'market' })
    const state = (await listStates(db(sql))).find((row) => row.probe === 'market.livez')
    assert.equal(state?.updatedAt, null)
    assert.equal(state?.reported, 'pending')
  })

  it('refuses a probe whose deadline is not below its interval', async () => {
    // A deadline at or above the cadence lets one attempt still be running when the next is due.
    await assert.rejects(() =>
      upsertProbe(db(sql), { ...probe, name: 'bad.livez', deadlineMs: 30_000, intervalMs: 30_000 }),
    )
  })
})
