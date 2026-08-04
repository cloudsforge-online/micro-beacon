/**
 * The journey objectives, and the seeder that registers them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FIRST SUITE ASSERTS THE OWNER'S NUMBERS LITERALLY, AND THAT IS THE POINT.**
 *
 * A test that recomputed the objective from the tier would pass whatever the table said, which is
 * exactly the failure this repository has been bitten by elsewhere: a check that asserts the code
 * agrees with itself. `slos` was empty for the whole life of the estate precisely because nobody
 * was willing to invent these, so the one thing worth guarding is that they are still the numbers
 * that were agreed and not numbers somebody adjusted to make a gate go green.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bodyFor,
  JOURNEY_SLO_KIND,
  journeySloName,
  OBJECTIVES,
  plan,
  seed,
  SloSeedError,
  WINDOW_DAYS,
} from './sloseed.ts'
import { incidentCauseFor, journeySloName as journeySloNameFromJobs } from './jobs.ts'
import type { JourneyDefinition } from './journeys.ts'

/** A definition carrying only what `plan` reads. `run` is never called here. */
function journey(name: string, service: string): JourneyDefinition {
  return {
    name,
    title: name,
    productGroup: 'Account',
    service,
    critical: false,
    run: async () => {},
  }
}

const REGISTRY: readonly JourneyDefinition[] = [
  journey('ecosystem.one-account', 'identity'),
  journey('ecosystem.one-portfolio', 'hub-api'),
  journey('ecosystem.one-activity', 'hub-api'),
  journey('ecosystem.trial-balance', 'ledger'),
  journey('ecosystem.event-bus', 'activity'),
  // The twelfth, added 2026-08-04 with the journey itself. Its owning service is `wallet` and NOT
  // `ecosystem`, which is the fact `the owning service comes from the definition` below turns into
  // an assertion — this is now the third name in the table whose prefix is not a service.
  journey('ecosystem.deposit-address', 'wallet'),
  journey('identity.signin', 'identity'),
  journey('identity.register', 'identity'),
  journey('identity.handoff', 'identity'),
  journey('market.catalogue', 'market'),
  journey('worlds.registry', 'worlds'),
  journey('estate.reachable', 'beacon'),
]

const NAMES = REGISTRY.map((j) => j.name)

/* ------------------------------------------------------------------ the owner's decision */

test('the owner set 99% on the five ecosystem journeys', () => {
  for (const name of [
    'ecosystem.one-account',
    'ecosystem.one-portfolio',
    'ecosystem.one-activity',
    'ecosystem.trial-balance',
    'ecosystem.event-bus',
  ]) {
    assert.equal(OBJECTIVES[name]?.objectivePpm, 990_000n, name)
    assert.equal(OBJECTIVES[name]?.tier, 1, name)
  }
})

test('the owner set 95% on the other six', () => {
  for (const name of [
    'identity.signin',
    'identity.register',
    'identity.handoff',
    'market.catalogue',
    'worlds.registry',
    'estate.reachable',
  ]) {
    assert.equal(OBJECTIVES[name]?.objectivePpm, 950_000n, name)
    assert.equal(OBJECTIVES[name]?.tier, 2, name)
  }
})

test('the twelfth carries 95%, and is marked as the one the owner has not ruled on', () => {
  // Kept OUT of the test above, deliberately. That one asserts a decision the owner made; this
  // asserts a number chosen under the owner's stated rule while the owner's own has not been set.
  // Folding them together would launder the second into the first, and the whole reason `slos` sat
  // empty for the life of the estate was that nobody would do exactly that.
  assert.equal(OBJECTIVES['ecosystem.deposit-address']?.objectivePpm, 950_000n)
  assert.equal(OBJECTIVES['ecosystem.deposit-address']?.tier, 2)
})

test('the table names exactly twelve journeys and no more', () => {
  // An objective nobody agreed to is the thing three agents refused to write. A thirteenth entry
  // appearing without this test being updated is that happening quietly.
  //
  // It was eleven. The twelfth is `ecosystem.deposit-address`, and the reason it is here at all
  // is that `plan()` refuses to seed ANY row when one registered journey has no objective — so
  // omitting it would have emptied the table this file exists to keep full. The number it carries
  // is the owner's 95%, chosen by the owner's own stated rule for that group rather than by the
  // journey's name prefix; `sloseed.ts` records the reasoning at the row.
  assert.equal(Object.keys(OBJECTIVES).length, 12)
})

test('every objective is inside the range the database will accept', () => {
  for (const [name, objective] of Object.entries(OBJECTIVES)) {
    assert.ok(objective.objectivePpm > 0n && objective.objectivePpm <= 1_000_000n, name)
    assert.ok(objective.tier >= 1 && objective.tier <= 3, name)
  }
  assert.ok(WINDOW_DAYS > 0)
})

/* ------------------------------------------------------------------ the plan */

test('plans one journey SLO per registered journey', () => {
  const planned = plan(REGISTRY, NAMES)
  assert.equal(planned.length, 12)
  for (const slo of planned) {
    assert.equal(slo.kind, JOURNEY_SLO_KIND)
    assert.equal(slo.windowDays, WINDOW_DAYS)
    assert.equal(slo.enabled, true)
  }
})

test('THE SLO NAME IS THE ONE jobs.ts WRITES OBSERVATIONS AGAINST', () => {
  // `slo_observations` carries a foreign key onto `slos(name)`. If these two spellings ever
  // diverge every observation is rejected — which is the exact failure the estate ran with for its
  // whole life, arrived at from the other direction.
  assert.equal(journeySloName('identity.register'), journeySloNameFromJobs('identity.register'))
  assert.equal(journeySloName('identity.register'), 'identity.register.runs')
})

test('the owning service comes from the definition, never from the name', () => {
  const planned = plan(REGISTRY, NAMES)
  const byName = new Map(planned.map((slo) => [slo.name, slo.service]))
  // The three that prove it. Slicing the name at the dot would give `ecosystem` and `estate`,
  // neither of which is a service this estate runs.
  assert.equal(byName.get('ecosystem.trial-balance.runs'), 'ledger')
  assert.equal(byName.get('ecosystem.event-bus.runs'), 'activity')
  assert.equal(byName.get('estate.reachable.runs'), 'beacon')
  // The fourth, and the newest. Its budget belongs to `wallet` — the service that owns the route
  // and has to produce the joined-up answer — not to a service called `ecosystem`, which is a
  // budget nobody owns.
  assert.equal(byName.get('ecosystem.deposit-address.runs'), 'wallet')
})

test('REFUSES to seed when a registered journey has no objective', () => {
  // A seeder that skipped what it did not recognise would be the empty table again, one journey at
  // a time — and the journey it skipped would silently violate the foreign key for ever after.
  assert.throws(
    () => plan([...REGISTRY, journey('wallet.deposit', 'wallet')], [...NAMES, 'wallet.deposit']),
    (err: unknown) => err instanceof SloSeedError && /no objective has been set/.test(err.message),
  )
})

test('REFUSES to seed an objective whose journey the estate is not running', () => {
  // The other half. An SLO with no journey reports error_budget_no_data for ever, which is an
  // UNKNOWN, which refuses every release on behalf of something nobody is running.
  assert.throws(
    () => plan(REGISTRY, NAMES.filter((name) => name !== 'worlds.registry')),
    (err: unknown) => err instanceof SloSeedError && /has not registered/.test(err.message),
  )
})

test('refuses a journey the estate runs but this build cannot describe', () => {
  assert.throws(
    () => plan(REGISTRY.slice(1), NAMES),
    (err: unknown) => err instanceof SloSeedError && /cannot describe/.test(err.message),
  )
})

/* ------------------------------------------------------------------ the wire */

test('objectivePpm goes on the wire as a STRING', () => {
  // The route refuses a number, and it is right to: an objective sent as a JSON float has already
  // been rounded by whatever produced it.
  const body = bodyFor(plan(REGISTRY, NAMES)[0]!)
  assert.equal(typeof body['objectivePpm'], 'string')
  assert.equal(body['objectivePpm'], '990000')
})

test('seed reports each failure rather than throwing on the first', async () => {
  // Twelve PUTs against nothing listening. The point is the shape of the report: a seeder that
  // threw part-way would leave an operator with a stack trace and no statement of which rows exist.
  const results = await seed(plan(REGISTRY, NAMES), {
    baseUrl: 'http://127.0.0.1:1/',
    headers: {},
    timeoutMs: 2_000,
  })
  assert.equal(results.length, 12)
  assert.ok(results.every((result) => !result.ok))
  assert.ok(results.every((result) => result.error !== null))
})

/* ------------------------------------------------------------------ the incident cause line */

/**
 * The sentence an operator reads first, when a journey opens an incident.
 *
 * Lives here rather than in a scheduler test because it is a pure function and the failure it
 * prevents is a sentence — the three SEV2s open on the live estate on 2026-08-04 all said
 * "failing at step \"unknown\"" about journeys that had skipped and had said exactly why.
 */
test('A SKIP SAYS IT SKIPPED, AND SAYS WHY', () => {
  assert.equal(
    incidentCauseFor('An existing account can sign in', {
      status: 'skip',
      failedStep: null,
      error: 'registration is rate limited',
    }),
    'An existing account can sign in — skipped: registration is rate limited',
  )
})

test('a skip with no recorded reason still does not claim a failing step', () => {
  const cause = incidentCauseFor('t', { status: 'skip', failedStep: null, error: null })
  assert.match(cause, /skipped/)
  assert.doesNotMatch(cause, /failing|step/)
})

test('a fail and an error are named apart, because they have different owners', () => {
  assert.equal(
    incidentCauseFor('t', { status: 'fail', failedStep: 'sign in', error: 'expected 200' }),
    't — fail at step "sign in"',
  )
  assert.equal(
    incidentCauseFor('t', { status: 'error', failedStep: 'register', error: 'boom' }),
    't — error at step "register"',
  )
})
