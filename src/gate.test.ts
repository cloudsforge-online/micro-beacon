/**
 * The gate.
 *
 * The first suite is pure: `decide()` over a list of reasons. It is where the property this whole
 * repository exists to guarantee is proved, and it needs no database, no clock and no socket —
 * which is deliberate, because a proof that is awkward to run is a proof that stops being run.
 *
 * The second suite drives the real thing against a real Postgres, because "an unknown refuses" is
 * only worth anything if the unknowns are actually produced by the real gathering code.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  addOverride,
  blocksRelease,
  collectReasons,
  decide,
  decisionHistory,
  determinacyOf,
  evaluate,
  exitCodeFor,
  MAX_OVERRIDE_TTL_MS,
  OverrideError,
  type GateOverride,
  type GateReason,
  type ReasonCode,
} from './gate.ts'
import { openIncident } from './incidents.ts'
import { recordConformanceRun } from './conformance.ts'
import { recordRun, setMuted, syncRegistry, type JourneyRun } from './journeys.ts'
import { recordObservation } from './slo.ts'
import {
  TIER2_PPM,
  db,
  fakeJourney,
  migrateTestDb,
  openDb,
  resetBeacon,
  seedSlo,
  skip,
} from './testsupport.ts'

const NOW = new Date('2026-07-31T10:00:00.000Z')

function known(code: ReasonCode, subject = 'x'): GateReason {
  return { code, subject, detail: 'because', determinacy: 'known' }
}
function unknown(code: ReasonCode, subject = 'x'): GateReason {
  return { code, subject, detail: 'because', determinacy: 'unknown' }
}
function override(overrides: Partial<GateOverride> = {}): GateOverride {
  return {
    releaseTag: 'v1',
    reasonCode: 'journey_failing',
    subject: 'x',
    reason: 'accepted knowingly by the on-call',
    requestedBy: 'user:1',
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    ...overrides,
  }
}

describe('decide is fail-closed', () => {
  it('promotes when there is nothing to say', () => {
    const decision = decide('v1', [], [], NOW)
    assert.equal(decision.decision, 'promote')
    assert.equal(decision.indeterminate, false)
  })

  it('refuses on a known failure', () => {
    assert.equal(decide('v1', [known('journey_failing')], [], NOW).decision, 'refuse')
  })

  it('REFUSES ON AN UNKNOWN — an unknown is not a pass', () => {
    const decision = decide('v1', [unknown('journey_never_run')], [], NOW)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
  })

  it('refuses when Beacon cannot read its own state', () => {
    const decision = decide('v1', [unknown('beacon_unavailable', 'beacon')], [], NOW)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
  })

  it('refuses on an unknown even when every other input is clean', () => {
    const decision = decide('v1', [unknown('journey_stale', 'identity.register')], [], NOW)
    assert.equal(decision.decision, 'refuse')
  })

  it('marks a decision indeterminate as soon as ONE input is unknown', () => {
    const decision = decide(
      'v1',
      [known('journey_failing', 'a'), unknown('journey_stale', 'b')],
      [],
      NOW,
    )
    assert.equal(decision.indeterminate, true)
    assert.equal(decision.decision, 'refuse')
  })
})

describe('an override may waive a known failure and may never waive an unknown', () => {
  it('promotes with an override over a matching known failure', () => {
    const decision = decide('v1', [known('journey_failing', 'x')], [override()], NOW)
    assert.equal(decision.decision, 'promote_with_override')
    assert.equal(decision.waived.length, 1)
  })

  it('never reports a plain promote when something was waived', () => {
    // The promotion history must show that this release only shipped because somebody waived
    // something. A `promote` here would read as a clean run to the next person.
    const decision = decide('v1', [known('journey_failing', 'x')], [override()], NOW)
    assert.notEqual(decision.decision, 'promote')
  })

  it('KEEPS REFUSING WHEN AN OVERRIDE NAMES AN UNKNOWN', () => {
    // Even with an override that matches the code exactly, the unknown branch is reached first
    // and the override is never consulted.
    const decision = decide(
      'v1',
      [unknown('journey_stale', 'x')],
      [override({ reasonCode: 'journey_stale' })],
      NOW,
    )
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
    assert.equal(decision.waived.length, 0)
  })

  it('waives nothing at all on an indeterminate evaluation, however many overrides exist', () => {
    const decision = decide(
      'v1',
      [known('journey_failing', 'a'), unknown('journey_never_run', 'b')],
      [override({ subject: '*' }), override({ reasonCode: 'journey_never_run', subject: '*' })],
      NOW,
    )
    assert.deepEqual(decision.waived, [])
  })

  it('does not waive a different subject', () => {
    const decision = decide('v1', [known('journey_failing', 'y')], [override({ subject: 'x' })], NOW)
    assert.equal(decision.decision, 'refuse')
  })

  it('waives every subject when the override says *', () => {
    const decision = decide(
      'v1',
      [known('journey_failing', 'a'), known('journey_failing', 'b')],
      [override({ subject: '*' })],
      NOW,
    )
    assert.equal(decision.decision, 'promote_with_override')
    assert.equal(decision.waived.length, 2)
  })

  it('does not waive a different reason code', () => {
    const decision = decide(
      'v1',
      [known('error_budget_exhausted', 'x')],
      [override({ reasonCode: 'journey_failing' })],
      NOW,
    )
    assert.equal(decision.decision, 'refuse')
  })

  it('ignores an expired override', () => {
    const decision = decide(
      'v1',
      [known('journey_failing', 'x')],
      [override({ expiresAt: new Date(NOW.getTime() - 1) })],
      NOW,
    )
    assert.equal(decision.decision, 'refuse')
  })

  it('ignores an override belonging to a different release', () => {
    const decision = decide('v2', [known('journey_failing', 'x')], [override()], NOW)
    assert.equal(decision.decision, 'refuse')
  })

  it('refuses when only some of the blockers are waived', () => {
    const decision = decide(
      'v1',
      [known('journey_failing', 'x'), known('error_budget_exhausted', 'ledger')],
      [override()],
      NOW,
    )
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.waived.length, 1)
  })

  it('never prunes the reason list, waived or not', () => {
    const decision = decide('v1', [known('journey_failing', 'x')], [override()], NOW)
    assert.equal(decision.reasons.length, 1)
  })
})

describe('the determinacy classification is a single source of truth', () => {
  const unknownCodes: ReasonCode[] = [
    'journey_never_run',
    'journey_stale',
    'journey_insufficient_history',
    'error_budget_no_data',
    'conformance_never_run',
    'beacon_unavailable',
  ]
  const knownCodes: ReasonCode[] = [
    'journey_failing',
    'journey_skipped',
    'journey_muted',
    'journey_recent_failure',
    'error_budget_exhausted',
    'conformance_breaking',
    'incident_open',
  ]

  for (const code of unknownCodes) {
    it(`classifies ${code} as unknown`, () => {
      assert.equal(determinacyOf(code), 'unknown')
    })
  }
  for (const code of knownCodes) {
    it(`classifies ${code} as known`, () => {
      assert.equal(determinacyOf(code), 'known')
    })
  }
})

describe('exit codes and severity thresholds', () => {
  it('exits 0 on promote', () => {
    assert.equal(exitCodeFor(decide('v1', [], [], NOW)), 0)
  })
  it('exits 0 on promote_with_override', () => {
    assert.equal(exitCodeFor(decide('v1', [known('journey_failing', 'x')], [override()], NOW)), 0)
  })
  it('exits 1 on refuse', () => {
    assert.equal(exitCodeFor(decide('v1', [known('journey_failing')], [], NOW)), 1)
  })
  it('blocks on sev1 and sev2', () => {
    assert.equal(blocksRelease('sev1'), true)
    assert.equal(blocksRelease('sev2'), true)
  })
  it('does not block on sev3 or sev4, so the estate can ship its own remedy', () => {
    assert.equal(blocksRelease('sev3'), false)
    assert.equal(blocksRelease('sev4'), false)
  })
})

/* ------------------------------------------------------------------ against a real database */

const RELEASE = 'v1.4.2'

function run(journey: string, status: JourneyRun['status'], startedAt: Date): JourneyRun {
  return {
    runId: crypto.randomUUID(),
    journey,
    startedAt,
    durationMs: 10,
    status,
    failedStep: null,
    error: null,
    trigger: 'schedule',
    releaseTag: null,
    steps: [],
  }
}

describe('the gate against a real estate', { skip }, () => {
  let sql: postgres.Sql

  const CRITICAL = fakeJourney('identity.register', async () => {})
  const OPTIONS = { now: NOW, freshnessMs: 3_600_000, consecutiveGreen: 3, record: false } as const

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetBeacon(sql)
    await syncRegistry(db(sql), [CRITICAL])
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  /** Three green runs at one-minute intervals, ending just before `NOW`. */
  async function threeGreen(journey = CRITICAL.name): Promise<void> {
    for (let i = 3; i >= 1; i--) {
      await recordRun(db(sql), run(journey, 'pass', new Date(NOW.getTime() - i * 60_000)))
    }
  }

  /**
   * An estate with nothing wrong with it.
   *
   * The conformance run is part of the baseline rather than an extra, because a gate with no
   * conformance run at all is `conformance_never_run` — an UNKNOWN. That is deliberate and it is
   * asserted on its own below; here it would only make every other case indeterminate and hide
   * what each one is actually testing.
   */
  async function cleanEstate(): Promise<void> {
    await threeGreen()
    await recordConformanceRun(db(sql), { suite: 'wallet', status: 'pass', identical: 40 })
  }

  it('promotes a clean estate', async () => {
    await cleanEstate()
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.deepEqual(
      decision.reasons.map((reason) => reason.code),
      [],
    )
    assert.equal(decision.decision, 'promote')
  })

  it('REFUSES a journey that has never run', async () => {
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
    assert.ok(decision.reasons.some((reason) => reason.code === 'journey_never_run'))
  })

  it('REFUSES a journey whose last run is stale — this is how a dead scheduler is caught', async () => {
    await recordRun(db(sql), run(CRITICAL.name, 'pass', new Date(NOW.getTime() - 86_400_000)))
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
    assert.ok(decision.reasons.some((reason) => reason.code === 'journey_stale'))
  })

  it('refuses a failing journey', async () => {
    await cleanEstate()
    await recordRun(db(sql), run(CRITICAL.name, 'fail', new Date(NOW.getTime() - 10_000)))
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, false)
    assert.ok(decision.reasons.some((reason) => reason.code === 'journey_failing'))
  })

  it('refuses a SKIPPED journey — a skip is not a pass', async () => {
    await cleanEstate()
    await recordRun(db(sql), run(CRITICAL.name, 'skip', new Date(NOW.getTime() - 10_000)))
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.ok(decision.reasons.some((reason) => reason.code === 'journey_skipped'))
  })

  it('refuses on fewer than three recorded runs, however green they are', async () => {
    await recordRun(db(sql), run(CRITICAL.name, 'pass', new Date(NOW.getTime() - 60_000)))
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
    assert.ok(decision.reasons.some((reason) => reason.code === 'journey_insufficient_history'))
  })

  it('refuses on a red run inside the last three, even though the latest is green', async () => {
    await recordRun(db(sql), run(CRITICAL.name, 'pass', new Date(NOW.getTime() - 180_000)))
    await recordRun(db(sql), run(CRITICAL.name, 'fail', new Date(NOW.getTime() - 120_000)))
    await recordRun(db(sql), run(CRITICAL.name, 'pass', new Date(NOW.getTime() - 60_000)))
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.ok(decision.reasons.some((reason) => reason.code === 'journey_recent_failure'))
  })

  it('ignores manual runs when counting green, so pressing Run cannot open the gate', async () => {
    await cleanEstate()
    await recordRun(db(sql), {
      ...run(CRITICAL.name, 'fail', new Date(NOW.getTime() - 30_000)),
      trigger: 'schedule',
    })
    await recordRun(db(sql), {
      ...run(CRITICAL.name, 'pass', new Date(NOW.getTime() - 10_000)),
      trigger: 'manual',
    })
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
  })

  it('refuses while ANY journey is muted, critical or not', async () => {
    await cleanEstate()
    const optional = fakeJourney('market.catalogue', async () => {}, { critical: false })
    await syncRegistry(db(sql), [optional])
    await setMuted(db(sql), optional.name, true, 'flaky since the market deploy', 'user:1')
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.ok(decision.reasons.some((reason) => reason.code === 'journey_muted'))
  })

  it('ignores a non-critical journey that is failing but not muted', async () => {
    await cleanEstate()
    const optional = fakeJourney('market.catalogue', async () => {}, { critical: false })
    await syncRegistry(db(sql), [optional])
    await recordRun(db(sql), run(optional.name, 'fail', new Date(NOW.getTime() - 10_000)))
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'promote')
  })

  it('REFUSES A PASSING ESTATE WHOSE ERROR BUDGET IS EXHAUSTED', async () => {
    await cleanEstate()
    await seedSlo(sql, 'ledger.availability', TIER2_PPM)
    // 1000 observations, 5 permitted to fail, 6 did.
    await recordObservation(db(sql), 'ledger.availability', new Date(NOW.getTime() - 60_000), 994n, 1_000n)
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, false)
    assert.ok(decision.reasons.some((reason) => reason.code === 'error_budget_exhausted'))
  })

  it('promotes a passing estate whose budget is merely spent-down', async () => {
    await cleanEstate()
    await seedSlo(sql, 'ledger.availability', TIER2_PPM)
    await recordObservation(db(sql), 'ledger.availability', new Date(NOW.getTime() - 60_000), 996n, 1_000n)
    assert.equal((await evaluate(db(sql), RELEASE, OPTIONS)).decision, 'promote')
  })

  it('REFUSES an SLO with no observations at all, as indeterminate', async () => {
    await cleanEstate()
    await seedSlo(sql, 'ledger.availability', TIER2_PPM)
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
    assert.ok(decision.reasons.some((reason) => reason.code === 'error_budget_no_data'))
  })

  it('refuses on a breaking conformance difference', async () => {
    await threeGreen()
    await recordConformanceRun(db(sql), {
      suite: 'wallet',
      status: 'fail',
      identical: 40,
      benign: 2,
      breaking: 1,
    })
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.ok(decision.reasons.some((reason) => reason.code === 'conformance_breaking'))
  })

  it('promotes on a benign-only conformance difference', async () => {
    await threeGreen()
    await recordConformanceRun(db(sql), {
      suite: 'wallet',
      status: 'pass',
      identical: 40,
      benign: 2,
      breaking: 0,
    })
    assert.equal((await evaluate(db(sql), RELEASE, OPTIONS)).decision, 'promote')
  })

  it('refuses on an open sev2 incident', async () => {
    await cleanEstate()
    await openIncident(db(sql), {
      scope: 'probe',
      subject: 'ledger.postings',
      severity: 'sev2',
      productGroup: 'Wallet',
    })
    const decision = await evaluate(db(sql), RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.ok(decision.reasons.some((reason) => reason.code === 'incident_open'))
  })

  it('promotes with an open sev3 incident', async () => {
    await cleanEstate()
    await openIncident(db(sql), {
      scope: 'probe',
      subject: 'market.listings',
      severity: 'sev3',
      productGroup: 'Market',
    })
    assert.equal((await evaluate(db(sql), RELEASE, OPTIONS)).decision, 'promote')
  })

  it('collects every reason rather than stopping at the first', async () => {
    await seedSlo(sql, 'ledger.availability', TIER2_PPM)
    const reasons = await collectReasons(db(sql), {
      freshnessMs: 3_600_000,
      consecutiveGreen: 3,
      now: NOW,
    })
    const codes = new Set(reasons.map((reason) => reason.code))
    assert.ok(codes.has('journey_never_run'))
    assert.ok(codes.has('error_budget_no_data'))
    assert.ok(codes.has('conformance_never_run'))
  })

  it('records a decision when asked to, and does not when not', async () => {
    await cleanEstate()
    await evaluate(db(sql), RELEASE, { ...OPTIONS, record: false })
    assert.equal((await decisionHistory(db(sql), RELEASE)).length, 0)
    await evaluate(db(sql), RELEASE, { ...OPTIONS, record: true })
    const history = await decisionHistory(db(sql), RELEASE)
    assert.equal(history.length, 1)
    assert.equal(history[0]?.decision, 'promote')
  })

  it('records a refusal with its reasons', async () => {
    await evaluate(db(sql), RELEASE, { ...OPTIONS, record: true })
    const [recorded] = await decisionHistory(db(sql), RELEASE)
    assert.equal(recorded?.decision, 'refuse')
    assert.equal(recorded?.indeterminate, true)
    assert.ok(recorded?.reasons.some((reason) => reason.code === 'journey_never_run'))
  })

  it('THE DATABASE REFUSES A PROMOTION RECORDED AGAINST AN INDETERMINATE EVALUATION', async () => {
    // The second of the three independent enforcements. Even a caller that bypassed `decide()`
    // entirely cannot write this row.
    await assert.rejects(async () => {
      await sql`
        insert into gate_decisions (release_tag, decision, indeterminate)
        values (${RELEASE}, 'promote', true)
      `
    })
  })

  it('refuses when the database itself cannot be read, without throwing', async () => {
    const broken = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async unsafe() {
        throw new Error('connection terminated unexpectedly')
      },
    }
    const brokenSql = Object.assign(
      () => Promise.reject(new Error('connection terminated unexpectedly')),
      broken,
    )
    const decision = await evaluate(brokenSql as never, RELEASE, OPTIONS)
    assert.equal(decision.decision, 'refuse')
    assert.equal(decision.indeterminate, true)
    assert.equal(decision.reasons[0]?.code, 'beacon_unavailable')
  })

  it('promotes under a recorded override', async () => {
    await cleanEstate()
    await recordRun(db(sql), run(CRITICAL.name, 'fail', new Date(NOW.getTime() - 10_000)))
    await addOverride(db(sql), {
      releaseTag: RELEASE,
      reasonCode: 'journey_failing',
      subject: CRITICAL.name,
      reason: 'known upstream outage, fix is in this release',
      requestedBy: 'user:1',
      ttlMs: 3_600_000,
    })
    const decision = await evaluate(db(sql), RELEASE, { ...OPTIONS, now: new Date() })
    assert.equal(decision.decision, 'promote_with_override')
  })
})

describe('recording an override', { skip }, () => {
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

  const base = {
    releaseTag: 'v1',
    reasonCode: 'journey_failing' as ReasonCode,
    reason: 'known upstream outage, fix is in this release',
    requestedBy: 'user:1',
    ttlMs: 3_600_000,
  }

  it('records one', async () => {
    const recorded = await addOverride(db(sql), base)
    assert.equal(recorded.reasonCode, 'journey_failing')
    assert.equal(recorded.subject, '*')
  })

  it('REFUSES TO OVERRIDE AN INDETERMINATE REASON CODE', async () => {
    await assert.rejects(
      () => addOverride(db(sql), { ...base, reasonCode: 'journey_stale' }),
      OverrideError,
    )
  })

  it('refuses to override beacon being unavailable', async () => {
    await assert.rejects(
      () => addOverride(db(sql), { ...base, reasonCode: 'beacon_unavailable' }),
      OverrideError,
    )
  })

  it('refuses an unwritten reason', async () => {
    await assert.rejects(() => addOverride(db(sql), { ...base, reason: 'fix' }), OverrideError)
  })

  it('refuses a permanent override', async () => {
    await assert.rejects(
      () => addOverride(db(sql), { ...base, ttlMs: MAX_OVERRIDE_TTL_MS + 1 }),
      OverrideError,
    )
  })

  it('refuses a zero or negative ttl', async () => {
    await assert.rejects(() => addOverride(db(sql), { ...base, ttlMs: 0 }), OverrideError)
  })

  it('is refused by the database too when the reason is too short', async () => {
    await assert.rejects(async () => {
      await sql`
        insert into gate_overrides (release_tag, reason_code, reason, requested_by, expires_at)
        values ('v1', 'journey_failing', 'fix', 'user:1', now() + interval '1 hour')
      `
    })
  })

  it('refuses an override that expires before it was created', async () => {
    await assert.rejects(async () => {
      await sql`
        insert into gate_overrides (release_tag, reason_code, reason, requested_by, created_at, expires_at)
        values ('v1', 'journey_failing', 'a properly written reason', 'user:1', now(), now() - interval '1 hour')
      `
    })
  })
})
