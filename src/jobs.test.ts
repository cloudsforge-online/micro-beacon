/**
 * What a journey run is entitled to publish.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A SKIP OPENED A CUSTOMER-FACING SEV2 ON A HEALTHY ESTATE, AND NOTHING COULD EVER CLOSE IT.**
 *
 * The incident, read off the live estate on 2026-08-04:
 *
 *     {"id":"e1ab13e9-…","scope":"journey","subject":"identity.handoff","severity":"sev2",
 *      "state":"detected","productGroup":"Account","openedAt":"2026-08-04T19:23:56.563Z",
 *      "closedAt":null,
 *      "cause":"One account signs into everything, once — skipped: identity refused
 *               \"https://hub.cloudsforge.localtest.me\" as a hand-off origin."}
 *
 * `status.<apex>` showed it as **Account · Investigating · SEV2 · not yet closed**, for two and a
 * half hours, while the hand-off itself was working: driving `IDENTITY_HANDOFF` against the same
 * production identity with the origin that deployment actually serves passes every step. Beacon
 * had not found a broken product. Beacon had been misconfigured, and published its own
 * misconfiguration as an outage in a customer's product.
 *
 * Two defects, and the second is why it lasted:
 *
 *   1. **A skip opened it.** `journeys.ts` defines a skip as "not applicable — never green, never
 *      red", and the incident is the reddest thing this service emits. The handler counted any
 *      non-pass toward its two-consecutive-failures rule, so "we could not measure this" and "this
 *      is broken" produced the same page.
 *   2. **Only a pass could close it.** Which a journey that skips on every cycle can never
 *      produce. Hysteresis was not slow; it was structurally unreachable.
 *
 * The rule these tests pin is the same one the public status page states in its own words —
 * *an incomplete answer can report a problem; it cannot report that there is none*:
 *
 *     A SKIP CAN NEITHER OPEN AN INCIDENT NOR CLOSE ONE.
 *
 * Both halves matter. Opening on a skip invents outages; closing on a skip would let a journey
 * that stopped being able to measure a genuinely broken product mark it healthy.
 *
 * **THE SIGNAL IS NOT LOST, WHICH IS WHAT MAKES THIS SAFE.** A skip still records its run, still
 * scores 0 against the journey SLO (`jobs.ts` — "a skip counts against it, because a skip is not a
 * pass"), still increments `beacon_journey_runs_total{status="skip"}`, and still refuses the
 * release at the gate. Everything that should notice an unmeasured critical journey still notices.
 * The only thing withdrawn is the claim made to a customer about a product.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type postgres from 'postgres'
import { JOURNEY_KIND, registerHandlers } from './jobs.ts'
import { listOpen } from './incidents.ts'
import type { JourneyDefinition } from './journeys.ts'
import {
  db,
  fakeJourney,
  migrateTestDb,
  openDb,
  quietLogger,
  resetBeacon,
  seedJourney,
  skip,
  testMetrics,
} from './testsupport.ts'

describe('what a journey run is entitled to publish', { skip }, () => {
  let sql: postgres.Sql
  const started: JobRunner[] = []

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetBeacon(sql)
  })
  afterEach(async () => {
    await Promise.all(started.splice(0).map((runner) => runner.stop(5_000)))
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  /**
   * Run one journey once, through the real job handler.
   *
   * The handler is what is under test, not `runJourney` — the question is what the SCHEDULER does
   * with an outcome, so the outcome is produced by a real journey body and everything after it is
   * the production path: `recordRun`, the SLO observation, the hysteresis window and the incident.
   */
  async function runOnce(definition: JourneyDefinition): Promise<void> {
    const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
    const runner = new JobRunner({ queue, concurrency: 1, pollMs: 5 })
    started.push(runner)
    registerHandlers(runner, {
      sql: db(sql),
      logger: quietLogger(),
      metrics: testMetrics(),
      queue,
      thresholds: { failThreshold: 3, recoverThreshold: 2 },
      journeys: [definition],
      targets: new Map(),
      journeyDeadlineMs: 5_000,
      journeyIntervalMs: 60_000,
      retention: { checkDays: 14, rollupDays: 400, runDays: 90, incidentDays: 400 },
    })
    await queue.enqueue({
      kind: JOURNEY_KIND,
      key: definition.name,
      payload: { journey: definition.name },
    })
    // `tick()` dispatches without awaiting the handler. Asserting straight after a bare tick would
    // read the table before anything had written to it — and would pass against a handler that
    // does nothing, which is the most expensive kind of green.
    await runner.tick()
    await runner.stop(5_000)
  }

  const SKIPS = fakeJourney('identity.handoff-like', async (ctx) => {
    ctx.skip('BEACON_HANDOFF_ORIGIN is not set')
  })
  const FAILS = fakeJourney('identity.broken', async (ctx) => {
    await ctx.step('sign in', async () => {
      ctx.assert(false, 'expected 200 from /auth/login, got 500')
    })
  })
  const PASSES = fakeJourney('identity.working', async (ctx) => {
    await ctx.step('sign in', async () => {})
  })

  async function openIncidents() {
    return listOpen(db(sql))
  }

  it('OPENS NO INCIDENT FOR A JOURNEY THAT ONLY SKIPS, HOWEVER MANY TIMES IT SKIPS', async () => {
    await seedJourney(sql, SKIPS)
    // Four cycles. The old rule needed two consecutive non-passes, so two would have been enough
    // to open one; four is here to show that nothing accumulates either.
    for (let i = 0; i < 4; i += 1) await runOnce(SKIPS)

    const runs = (await sql`select status from journey_runs`) as unknown as { status: string }[]
    assert.deepEqual(
      runs.map((r) => r.status),
      ['skip', 'skip', 'skip', 'skip'],
      'the runs must still be RECORDED — the skip is measured, it is just not published',
    )
    assert.deepEqual(await openIncidents(), [], 'a skip is not evidence of a broken product')
  })

  it('still opens one for a journey that actually fails twice', async () => {
    // The control. Without this, the fix above could have been "never open an incident", which
    // would pass the previous test and delete the feature.
    await seedJourney(sql, FAILS)
    await runOnce(FAILS)
    assert.deepEqual(await openIncidents(), [], 'one failure is a flake, not an incident')
    await runOnce(FAILS)

    const open = await openIncidents()
    assert.equal(open.length, 1)
    assert.equal(open[0]?.subject, 'identity.broken')
    assert.equal(open[0]?.severity, 'sev2', 'a critical journey opens at SEV2')
    assert.match(String(open[0]?.cause), /fail at step "sign in"/)
  })

  it('does not let a skip stand in for the second failure', async () => {
    // fail, skip, fail. Two reds with an unmeasured cycle between them is not two consecutive
    // reds, and the whole purpose of the two-run rule is that one bad cycle is not news. The
    // alternative — counting the skip toward the streak — is exactly how the SEV2 that prompted
    // this file came to exist.
    await seedJourney(sql, FAILS)
    await runOnce(FAILS)
    // The SAME journey, skipping. `recentRuns` is per-journey, so a skip recorded under another
    // name would prove nothing at all here — the first draft of this test did exactly that and
    // passed against the unfixed handler.
    await runOnce(fakeJourney(FAILS.name, SKIPS.run))
    await runOnce(FAILS)
    assert.deepEqual(
      (await openIncidents()).map((i) => i.subject),
      [],
    )
  })

  it('leaves an OPEN incident open when the journey stops being measurable', async () => {
    // The other half of the rule, and the one that keeps this honest. A journey that was failing
    // and can now only skip has not demonstrated a recovery — it has stopped answering the
    // question. Closing here would mark a broken product healthy on the evidence of nothing.
    await seedJourney(sql, FAILS)
    await runOnce(FAILS)
    await runOnce(FAILS)
    assert.equal((await openIncidents()).length, 1)

    const stopsBeingMeasurable = fakeJourney(FAILS.name, async (ctx) => {
      ctx.skip('the credential this journey needs was removed')
    })
    await runOnce(stopsBeingMeasurable)
    await runOnce(stopsBeingMeasurable)

    const open = await openIncidents()
    assert.equal(open.length, 1, 'a skip must not close what a failure opened')
    assert.equal(open[0]?.closedAt, null)
    assert.equal(
      open[0]?.failures,
      1,
      'and it must not fold into it either: the failure count is the dedupe evidence an operator ' +
        'reads, and two cycles of "we could not measure this" are not two more failures',
    )
  })

  it('closes it the moment the journey actually passes', async () => {
    await seedJourney(sql, FAILS)
    await runOnce(FAILS)
    await runOnce(FAILS)
    assert.equal((await openIncidents()).length, 1)

    await runOnce(fakeJourney(FAILS.name, PASSES.run))
    assert.deepEqual(await openIncidents(), [], 'one pass closes it — hysteresis, unchanged')
  })
})
