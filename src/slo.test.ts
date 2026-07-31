/**
 * Error budget arithmetic.
 *
 * The cases below are chosen so that a floating-point implementation would fail at least one of
 * them. `28 days at 99.95%` is 21 minutes of budget out of 40,320, and `total * 0.9995` computed
 * in a double is off by enough to move `allowedBad` by one — which is the difference between a
 * release that ships and one that does not on the last day of a bad window.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  PPM,
  budgetFor,
  burnRateMilli,
  computeBudget,
  listSlos,
  policyFor,
  recordObservation,
  remainingRatio,
} from './slo.ts'
import {
  NO_BUDGET_PPM,
  TIER1_PPM,
  TIER2_PPM,
  db,
  migrateTestDb,
  openDb,
  resetBeacon,
  seedSlo,
  skip,
} from './testsupport.ts'

describe('the budget is integer arithmetic', () => {
  it('gives a tier-2 service 0.5% of its events', () => {
    const budget = computeBudget('x', 100_000n, 100_000n, TIER2_PPM)
    assert.equal(budget.allowedBad, 500n)
    assert.equal(budget.remaining, 500n)
    assert.equal(budget.exhausted, false)
  })

  it('gives a tier-1 service 0.05% of its events', () => {
    const budget = computeBudget('x', 100_000n, 100_000n, TIER1_PPM)
    assert.equal(budget.allowedBad, 50n)
  })

  it('rounds the required good count UP, never in the operator\'s favour', () => {
    // 1001 * 0.995 = 995.995. Rounding down would require 995 good and allow 6 bad, which is more
    // budget than 99.5% promises.
    const budget = computeBudget('x', 1_001n, 1_001n, TIER2_PPM)
    assert.equal(budget.allowedBad, 5n)
  })

  it('gives no budget at all at 100%', () => {
    const budget = computeBudget('trial-balance', 40_320n, 40_320n, NO_BUDGET_PPM)
    assert.equal(budget.allowedBad, 0n)
    assert.equal(budget.exhausted, false)
  })

  it('exhausts a no-budget objective on the first bad event', () => {
    const budget = computeBudget('trial-balance', 40_320n, 40_319n, NO_BUDGET_PPM)
    assert.equal(budget.bad, 1n)
    assert.equal(budget.remaining, -1n)
    assert.equal(budget.exhausted, true)
    assert.equal(budget.consumedPpm, PPM)
  })

  it('reports exactly zero remaining as exhausted', () => {
    // The boundary, stated as its own case: `remaining <= 0`, not `< 0`. A budget with nothing
    // left in it is spent, and one more failure is not a thing to find out about afterwards.
    const budget = computeBudget('x', 1_000n, 995n, TIER2_PPM)
    assert.equal(budget.allowedBad, 5n)
    assert.equal(budget.remaining, 0n)
    assert.equal(budget.exhausted, true)
  })

  it('reports the overspend exactly rather than clamping it', () => {
    const budget = computeBudget('x', 1_000n, 900n, TIER2_PPM)
    assert.equal(budget.bad, 100n)
    assert.equal(budget.remaining, -95n)
  })

  it('caps consumption at 100% while remaining stays exact', () => {
    const budget = computeBudget('x', 1_000n, 900n, TIER2_PPM)
    assert.equal(budget.consumedPpm, PPM)
    assert.equal(budget.remaining, -95n)
  })

  it('rounds consumption UP so a policy threshold is never crossed unseen', () => {
    // 3 of 4 spent is 75%. 3 of 5 is 60%, and 4 of 5 is 80% — the case that matters is a fraction
    // just over a threshold reporting as just under it.
    const budget = computeBudget('x', 100_000n, 99_499n, TIER2_PPM)
    assert.equal(budget.allowedBad, 500n)
    assert.equal(budget.bad, 501n)
    assert.equal(budget.consumedPpm, PPM)
  })

  it('loses nothing across a window of a hundred million events', () => {
    // Well past 2^53 when multiplied by a million, which is exactly where a Number-based
    // implementation silently starts returning even results.
    const total = 100_000_000n
    const budget = computeBudget('x', total, total - 49_999n, TIER1_PPM)
    assert.equal(budget.allowedBad, 50_000n)
    assert.equal(budget.remaining, 1n)
    assert.equal(budget.exhausted, false)
  })

  it('is exact at the event that exhausts a hundred-million-event window', () => {
    const total = 100_000_000n
    const budget = computeBudget('x', total, total - 50_000n, TIER1_PPM)
    assert.equal(budget.remaining, 0n)
    assert.equal(budget.exhausted, true)
  })

  it('treats an empty window as indeterminate, never as perfect', () => {
    const budget = computeBudget('x', 0n, 0n, TIER2_PPM)
    assert.equal(budget.indeterminate, true)
    // And explicitly NOT exhausted, so the two states are distinguishable: "no data" and "out of
    // budget" are different problems and the gate reports them with different reason codes.
    assert.equal(budget.exhausted, false)
  })

  it('refuses more good events than total', () => {
    assert.throws(() => computeBudget('x', 10n, 11n, TIER2_PPM), RangeError)
  })

  it('refuses a negative count', () => {
    assert.throws(() => computeBudget('x', -1n, 0n, TIER2_PPM), RangeError)
  })

  it('refuses an objective outside (0, 1000000]', () => {
    assert.throws(() => computeBudget('x', 10n, 10n, 0n), RangeError)
    assert.throws(() => computeBudget('x', 10n, 10n, PPM + 1n), RangeError)
  })
})

describe('the budget renders for display without becoming a float internally', () => {
  it('reports a full budget as 1', () => {
    assert.equal(remainingRatio(computeBudget('x', 1_000n, 1_000n, TIER2_PPM)), 1)
  })

  it('reports an overspent budget as 0 rather than as a negative ratio', () => {
    assert.equal(remainingRatio(computeBudget('x', 1_000n, 900n, TIER2_PPM)), 0)
  })

  it('reports a no-budget objective as 1 while it is clean', () => {
    assert.equal(remainingRatio(computeBudget('x', 10n, 10n, NO_BUDGET_PPM)), 1)
  })

  it('reports a no-budget objective as 0 the moment it is spent', () => {
    assert.equal(remainingRatio(computeBudget('x', 10n, 9n, NO_BUDGET_PPM)), 0)
  })

  it('halves the ratio when half the budget is spent', () => {
    const budget = computeBudget('x', 1_000n, 997n, TIER2_PPM)
    assert.equal(budget.allowedBad, 5n)
    assert.equal(budget.bad, 3n)
    assert.equal(remainingRatio(budget), 0.4)
  })
})

describe('burn rate', () => {
  it('is 1.0x when the observed error rate equals the allowance', () => {
    assert.equal(burnRateMilli(1_000n, 995n, TIER2_PPM), 1_000n)
  })

  it('is 14.4x at the paging threshold', () => {
    // 14.4x of a 0.5% allowance is a 7.2% error rate: 72 bad in 1000.
    assert.equal(burnRateMilli(1_000n, 928n, TIER2_PPM), 14_400n)
  })

  it('is zero when nothing failed', () => {
    assert.equal(burnRateMilli(1_000n, 1_000n, TIER2_PPM), 0n)
  })

  it('is zero on an empty window rather than dividing by nothing', () => {
    assert.equal(burnRateMilli(0n, 0n, TIER2_PPM), 0n)
  })
})

describe('the budget policy', () => {
  it('is ok below half', () => {
    assert.equal(policyFor(computeBudget('x', 10_000n, 9_990n, TIER2_PPM)), 'ok')
  })

  it('tickets at half consumed', () => {
    // 50 allowed, 25 spent.
    assert.equal(policyFor(computeBudget('x', 10_000n, 9_975n, TIER2_PPM)), 'ticket')
  })

  it('reprioritises at three quarters', () => {
    assert.equal(policyFor(computeBudget('x', 10_000n, 9_962n, TIER2_PPM)), 'reprioritise')
  })

  it('freezes at a hundred percent', () => {
    assert.equal(policyFor(computeBudget('x', 10_000n, 9_950n, TIER2_PPM)), 'freeze')
  })
})

describe('observations accumulate', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetBeacon(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  it('adds to a bucket rather than replacing it', async () => {
    await seedSlo(sql, 'ledger.availability', TIER1_PPM)
    const bucket = new Date('2026-07-31T10:00:00.000Z')
    await recordObservation(db(sql), 'ledger.availability', bucket, 1n, 1n)
    await recordObservation(db(sql), 'ledger.availability', bucket, 0n, 1n)
    await recordObservation(db(sql), 'ledger.availability', bucket, 1n, 1n)

    const [slo] = await listSlos(db(sql))
    assert.ok(slo)
    const budget = await budgetFor(db(sql), slo, new Date('2026-07-31T10:05:00.000Z'))
    assert.equal(budget.total, 3n)
    assert.equal(budget.good, 2n)
    assert.equal(budget.bad, 1n)
  })

  it('excludes observations older than the window', async () => {
    await seedSlo(sql, 'ledger.availability', TIER1_PPM, 1)
    await recordObservation(
      db(sql),
      'ledger.availability',
      new Date('2026-07-01T00:00:00.000Z'),
      0n,
      1n,
    )
    await recordObservation(
      db(sql),
      'ledger.availability',
      new Date('2026-07-31T09:00:00.000Z'),
      1n,
      1n,
    )
    const [slo] = await listSlos(db(sql))
    assert.ok(slo)
    const budget = await budgetFor(db(sql), slo, new Date('2026-07-31T10:00:00.000Z'))
    assert.equal(budget.total, 1n)
    assert.equal(budget.good, 1n)
  })

  it('refuses to record more good than total', async () => {
    await seedSlo(sql, 'ledger.availability', TIER1_PPM)
    await assert.rejects(
      () => recordObservation(db(sql), 'ledger.availability', new Date(), 2n, 1n),
      RangeError,
    )
  })

  it('is refused by the database too, not only by the function', async () => {
    // The constraint is what protects a writer that bypasses `recordObservation`.
    await seedSlo(sql, 'ledger.availability', TIER1_PPM)
    await assert.rejects(async () => {
      await sql`
        insert into slo_observations (slo_name, bucket, good, total)
        values ('ledger.availability', now(), 5, 1)
      `
    })
  })

  it('reads a budget of zero observations as indeterminate', async () => {
    await seedSlo(sql, 'ledger.availability', TIER1_PPM)
    const [slo] = await listSlos(db(sql))
    assert.ok(slo)
    const budget = await budgetFor(db(sql), slo)
    assert.equal(budget.indeterminate, true)
  })

  it('refuses an objective above one million', async () => {
    await assert.rejects(async () => {
      await sql`
        insert into slos (name, service, tier, kind, objective_ppm)
        values ('bad', 'x', 2, 'availability', 1000001)
      `
    })
  })
})
