/**
 * Two replicas must not double-probe.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * This is the test that justifies replacing the frozen service's schedule wholesale.
 *
 * `infra/beacon/src/probe.js:98` arms a `setInterval` and guards overlap with a module-scope
 * boolean at `:22`. Both are per-process. Two replicas therefore probe every target twice, write
 * two check rows per cycle, and inflate the denominator of every uptime figure — and if one of the
 * journeys moves money, they move it twice.
 *
 * Here the schedule is a leased job claimed with `for update skip locked`, so the test is
 * straightforward and the result is not: two independent workers, one due row, exactly one
 * execution.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type postgres from 'postgres'
import { PROBE_KIND, SYNC_KIND, registerHandlers, truncateToMinute } from './jobs.ts'
import { listStates } from './probes.ts'
import {
  db,
  fakeTarget,
  migrateTestDb,
  openDb,
  quietLogger,
  resetBeacon,
  seedProbe,
  skip,
  testMetrics,
  type FakeTarget,
} from './testsupport.ts'

const THRESHOLDS = { failThreshold: 3, recoverThreshold: 2 }

describe('the leased schedule', { skip }, () => {
  let sql: postgres.Sql
  let target: FakeTarget

  /**
   * Every worker and every socket this file opens, torn down after each case.
   *
   * Not hygiene: a `JobRunner` that is never stopped holds a poll timer and a listening socket
   * holds a handle, so without this the process runs every assertion, passes, and then never
   * exits. A suite that hangs after it is green is a suite CI kills at its job timeout and reports
   * as a failure nobody can reproduce locally.
   */
  const started: JobRunner[] = []

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetBeacon(sql)
    target = await fakeTarget()
  })
  afterEach(async () => {
    await Promise.all(started.splice(0).map((runner) => runner.stop(5_000)))
    await target.close()
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  /** A runner wired exactly as `index.ts` wires one, with its own owner. */
  function worker(owner: string, onRun: () => void): { queue: JobQueue; runner: JobRunner } {
    const queue = new JobQueue(sql as unknown as JobsSql, { owner, leaseMs: 60_000 })
    const runner = new JobRunner({ queue, concurrency: 2, pollMs: 5 })
    started.push(runner)
    registerHandlers(runner, {
      sql: db(sql),
      logger: quietLogger(),
      metrics: testMetrics(),
      queue,
      thresholds: THRESHOLDS,
      journeys: [],
      targets: new Map(),
      journeyDeadlineMs: 5_000,
      journeyIntervalMs: 60_000,
      retention: { checkDays: 14, rollupDays: 400, runDays: 90, incidentDays: 400 },
      execute: {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          onRun()
          return fetch(input, init)
        }) as typeof globalThis.fetch,
      },
    })
    return { queue, runner }
  }

  /**
   * Tick once and wait for the handler to finish.
   *
   * `JobRunner.tick()` claims and DISPATCHES; it does not await the handlers it started. A test
   * that asserted straight after a bare `tick()` would be reading the table before the handler had
   * written to it — and would therefore pass against a handler that does nothing at all, which is
   * the most expensive kind of green.
   */
  async function tickAndSettle(runner: JobRunner): Promise<void> {
    await runner.tick()
    await runner.stop(5_000)
  }

  it('EXECUTES A DUE PROBE EXACTLY ONCE ACROSS TWO WORKERS', async () => {
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez` })

    let executions = 0
    const a = worker('replica-a', () => (executions += 1))
    const b = worker('replica-b', () => (executions += 1))

    await a.queue.enqueue({ kind: PROBE_KIND, key: 'ledger.livez', payload: { probe: 'ledger.livez' } })

    // Both tick at the same moment, deliberately. `Promise.all` rather than sequential ticks is
    // the whole point: sequential ticks would pass even against an implementation with no lease
    // at all, because the first would have completed and deleted the row before the second looked.
    await Promise.all([a.runner.tick(), b.runner.tick()])
    await Promise.all([a.runner.stop(5_000), b.runner.stop(5_000)])

    assert.equal(executions, 1)
    assert.equal(target.hits.length, 1)

    const checks = (await sql`select count(*)::int as n from checks`) as unknown as { n: number }[]
    assert.equal(checks[0]?.n, 1)
  })

  it('executes exactly once across four workers ticking together', async () => {
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez` })
    let executions = 0
    const workers = ['a', 'b', 'c', 'd'].map((name) => worker(`replica-${name}`, () => (executions += 1)))
    await workers[0]!.queue.enqueue({
      kind: PROBE_KIND,
      key: 'ledger.livez',
      payload: { probe: 'ledger.livez' },
    })
    await Promise.all(workers.map((w) => w.runner.tick()))
    await Promise.all(workers.map((w) => w.runner.stop(5_000)))
    assert.equal(executions, 1)
  })

  it('lets two workers run two DIFFERENT probes at once', async () => {
    // The lease bounds one probe, not the whole schedule. If it serialised everything, nineteen
    // targets against a five-second deadline would make a worst case of ninety-five seconds and
    // the monitor's resolution would collapse the first time the network went bad.
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez` })
    await seedProbe(sql, 'market.livez', { url: `${target.baseUrl}/livez`, target: 'market' })

    let executions = 0
    const a = worker('replica-a', () => (executions += 1))
    const b = worker('replica-b', () => (executions += 1))
    for (const name of ['ledger.livez', 'market.livez']) {
      await a.queue.enqueue({ kind: PROBE_KIND, key: name, payload: { probe: name } })
    }
    await Promise.all([a.runner.tick(), b.runner.tick()])
    await Promise.all([a.runner.stop(5_000), b.runner.stop(5_000)])
    assert.equal(executions, 2)
  })

  it('collapses three enqueues of one probe into a single pending run', async () => {
    // The property the sync relies on. Three sweeps landing before the first run must produce ONE
    // run, not three — otherwise a slow target would accumulate a queue of probes of itself and
    // the monitor would become the load.
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez` })
    const a = worker('replica-a', () => {})
    for (let i = 0; i < 3; i++) {
      await a.queue.enqueue({
        kind: PROBE_KIND,
        key: 'ledger.livez',
        payload: { probe: 'ledger.livez' },
        onConflict: 'keep',
      })
    }
    const rows = (await sql`
      select count(*)::int as n from jobs where kind = ${PROBE_KIND}
    `) as unknown as { n: number }[]
    assert.equal(rows[0]?.n, 1)
  })

  it('enqueues exactly one run per due probe on a sync sweep', async () => {
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez` })
    await seedProbe(sql, 'market.livez', { url: `${target.baseUrl}/livez`, target: 'market' })
    const a = worker('replica-a', () => {})
    await a.queue.enqueue({ kind: SYNC_KIND, key: 'global' })
    await tickAndSettle(a.runner)
    const rows = (await sql`
      select key from jobs where kind = ${PROBE_KIND} order by key
    `) as unknown as { key: string }[]
    assert.deepEqual(rows.map((row) => row.key), ['ledger.livez', 'market.livez'])
  })

  it('does not schedule a disabled probe', async () => {
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez`, enabled: false })
    const a = worker('replica-a', () => {})
    await a.queue.enqueue({ kind: SYNC_KIND, key: 'global' })
    await tickAndSettle(a.runner)
    const rows = (await sql`
      select count(*)::int as n from jobs where kind = ${PROBE_KIND}
    `) as unknown as { n: number }[]
    assert.equal(rows[0]?.n, 0)
  })

  it('does not re-enqueue a probe that ran inside its own interval', async () => {
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez`, intervalMs: 3_600_000 })
    const a = worker('replica-a', () => {})
    await a.queue.enqueue({ kind: PROBE_KIND, key: 'ledger.livez', payload: { probe: 'ledger.livez' } })
    await tickAndSettle(a.runner)
    // The probe has now run and its state row carries `updated_at`.
    const b = worker('replica-b', () => {})
    await b.queue.enqueue({ kind: SYNC_KIND, key: 'global' })
    await tickAndSettle(b.runner)
    const rows = (await sql`
      select count(*)::int as n from jobs where kind = ${PROBE_KIND}
    `) as unknown as { n: number }[]
    assert.equal(rows[0]?.n, 0)
  })

  it('survives a probe deleted between enqueue and claim without burning an attempt', async () => {
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez` })
    const a = worker('replica-a', () => {})
    await a.queue.enqueue({ kind: PROBE_KIND, key: 'ledger.livez', payload: { probe: 'ledger.livez' } })
    await sql`delete from probes where name = 'ledger.livez'`
    await tickAndSettle(a.runner)
    // Completed, not dead-lettered. An operator removing a probe is a thing operators may do.
    const rows = (await sql`select count(*)::int as n from jobs where dead = true`) as unknown as {
      n: number
    }[]
    assert.equal(rows[0]?.n, 0)
  })

  it('records the check and the state under whichever worker won', async () => {
    await seedProbe(sql, 'ledger.livez', { url: `${target.baseUrl}/livez` })
    const a = worker('replica-a', () => {})
    const b = worker('replica-b', () => {})
    await a.queue.enqueue({ kind: PROBE_KIND, key: 'ledger.livez', payload: { probe: 'ledger.livez' } })
    await Promise.all([a.runner.tick(), b.runner.tick()])
    await Promise.all([a.runner.stop(5_000), b.runner.stop(5_000)])
    const [state] = await listStates(db(sql))
    assert.equal(state?.reported, 'up')
  })
})

describe('SLO buckets', () => {
  it('rounds down to the minute', () => {
    assert.equal(
      truncateToMinute(new Date('2026-07-31T10:07:41.912Z')).toISOString(),
      '2026-07-31T10:07:00.000Z',
    )
  })

  it('leaves an exact minute alone', () => {
    assert.equal(
      truncateToMinute(new Date('2026-07-31T10:07:00.000Z')).toISOString(),
      '2026-07-31T10:07:00.000Z',
    )
  })
})
