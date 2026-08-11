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
  AVAILABILITY_OBJECTIVES,
  catalogue,
  AVAILABILITY_SLO_KIND,
  availabilitySloName,
  bodyFor,
  JOURNEY_SLO_KIND,
  journeySloName,
  OBJECTIVES,
  plan,
  planAvailability,
  seed,
  WINDOW_DAYS,
} from './sloseed.ts'
import {
  availabilitySloName as availabilitySloNameFromJobs,
  incidentCauseFor,
  journeySloName as journeySloNameFromJobs,
} from './jobs.ts'
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
  // The three added 2026-08-11. Two are the browser scenarios micro-org#370 named; the third
  // shipped after that ticket was written and is why the all-or-nothing refusal had to go.
  journey('browser.bj-med-01', 'studio'),
  journey('browser.bj-med-02', 'studio'),
  journey('identity.registration-challenge', 'identity'),
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

test('the table names exactly fifteen journeys and no more', () => {
  // An objective nobody agreed to is the thing three agents refused to write. A thirteenth entry
  // appearing without this test being updated is that happening quietly.
  //
  // It was eleven. The twelfth is `ecosystem.deposit-address`, and the reason it is here at all
  // is that `plan()` refuses to seed ANY row when one registered journey has no objective — so
  // omitting it would have emptied the table this file exists to keep full. The number it carries
  // is the owner's 95%, chosen by the owner's own stated rule for that group rather than by the
  // journey's name prefix; `sloseed.ts` records the reasoning at the row.
  //
  // Twelve became fifteen on 2026-08-11. The three added are `browser.bj-med-01`,
  // `browser.bj-med-02` and `identity.registration-challenge` — all registered on mainnet, none
  // ruled on, and between them they had withheld the other twelve from ever being written.
  assert.equal(Object.keys(OBJECTIVES).length, 15)
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
  assert.equal(planned.slos.length, 15)
  assert.deepEqual(planned.refusals, [])
  for (const slo of planned.slos) {
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
  const byName = new Map(planned.slos.map((slo) => [slo.name, slo.service]))
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

test('REFUSES a registered journey with no objective, AND STILL PLANS THE REST', () => {
  /*
   * ────────────────────────────────────────────────────────────────────────────────────────────
   * **THIS IS THE TEST THAT CHANGED, AND THE MUTATION IT KILLS IS THE ONE THAT SHIPPED.**
   *
   * The old assertion was `assert.throws`, and it passed for months while the estate recorded no
   * error budget at all — `slos` and `slo_observations` both held 0 rows on mainnet, measured
   * 2026-08-11, because three unruled journeys took the twelve agreed ones down with them.
   *
   * A test that asserts only the refusal survives the mutation "refuse everything", which is
   * precisely the bug that shipped. A test that asserts only the rows survives "stop refusing",
   * which is the bug the refusal was written to prevent. So BOTH halves are asserted in one case:
   * the fifteen ruled rows are planned, and the sixteenth is named in a refusal.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   */
  const planned = plan(
    [...REGISTRY, journey('wallet.deposit', 'wallet')],
    [...NAMES, 'wallet.deposit'],
  )
  assert.equal(planned.slos.length, 15)
  assert.ok(!planned.slos.some((slo) => slo.name.startsWith('wallet.deposit')))
  assert.equal(planned.refusals.length, 1)
  assert.match(planned.refusals[0]!, /no objective has been set for: wallet.deposit/)
})

test('REFUSES an objective whose journey the estate is not running, and does not delete it', () => {
  // The other half. An SLO with no journey reports error_budget_no_data for ever, which is an
  // UNKNOWN, which refuses every release on behalf of something nobody is running.
  //
  // Kills the mutation "drop the orphan silently": that would make the command green, make the
  // gate quiet, and decide by itself — at deploy time — that the journey rather than the objective
  // was the mistake. The refusal is a value now, so this asserts it is REPORTED and that the
  // fourteen still-registered rows were written anyway.
  const planned = plan(REGISTRY, NAMES.filter((name) => name !== 'worlds.registry'))
  assert.equal(planned.slos.length, 14)
  assert.equal(planned.refusals.length, 1)
  assert.match(planned.refusals[0]!, /has not registered: worlds.registry/)
})

test('refuses a journey the estate runs but this build cannot describe, and plans no row for it', () => {
  // Kills the mutation "fall back to the name prefix for the service". `ecosystem.one-account`'s
  // prefix is `ecosystem`, which is not a service, so a build that cannot describe it must produce
  // NO row rather than a row whose budget nobody owns.
  const planned = plan(REGISTRY.slice(1), NAMES)
  assert.equal(planned.slos.length, 14)
  assert.ok(!planned.slos.some((slo) => slo.name === 'ecosystem.one-account.runs'))
  assert.equal(planned.refusals.length, 1)
  assert.match(planned.refusals[0]!, /cannot describe: ecosystem.one-account/)
})

/* ------------------------------------------------------------------ availability */

const TARGETS = Object.keys(AVAILABILITY_OBJECTIVES)

test('THE AVAILABILITY SLO NAME IS THE ONE jobs.ts WRITES OBSERVATIONS AGAINST', () => {
  /*
   * micro-org#370's larger half, in one assertion. `jobs.ts` wrote `<target>.availability` after
   * every probe check and NOTHING anywhere created that row, so all 21 targets violated
   * `slo_observations_slo_name_fkey` on every cycle for the whole life of the estate.
   *
   * Kills the mutation "give the seeder its own spelling" — a second `${x}.availability` written in
   * sloseed.ts would pass every other test in this file and reproduce the original defect exactly,
   * silently, with the warn back in the logs.
   */
  assert.equal(availabilitySloName('hub'), availabilitySloNameFromJobs('hub'))
  assert.equal(availabilitySloName('hub'), 'hub.availability')
})

test('plans one availability SLO per probed target', () => {
  const planned = planAvailability(TARGETS)
  assert.equal(planned.slos.length, 21)
  assert.deepEqual(planned.refusals, [])
  for (const slo of planned.slos) {
    assert.equal(slo.kind, AVAILABILITY_SLO_KIND)
    assert.equal(slo.windowDays, WINDOW_DAYS)
    assert.equal(slo.enabled, true)
  }
})

test('every availability objective is the owner’s Tier 3 edge number, literally', () => {
  // 99.9% and tier 3, asserted as literals rather than read back off `EDGE`. A test that read the
  // constant would pass whatever the constant said, which is the check-that-agrees-with-itself this
  // file's header refuses. 13-operational-model.md §8: "Tier 3 — edge. Gateway availability 99.9%".
  assert.equal(Object.keys(AVAILABILITY_OBJECTIVES).length, 21)
  for (const [target, objective] of Object.entries(AVAILABILITY_OBJECTIVES)) {
    assert.equal(objective.objectivePpm, 999_000n, target)
    assert.equal(objective.tier, 3, target)
  }
})

test('REFUSES a probed target with no availability objective, AND STILL PLANS THE REST', () => {
  // The same both-halves assertion as the journey case, for the same reason: refusing to guess must
  // not mean refusing to record. Kills "seed the unknown target at the edge default", which is how
  // a money service would quietly acquire the loosest objective in the estate.
  const planned = planAvailability([...TARGETS, 'ledger'])
  assert.equal(planned.slos.length, 21)
  assert.ok(!planned.slos.some((slo) => slo.name === 'ledger.availability'))
  assert.equal(planned.refusals.length, 1)
  assert.match(planned.refusals[0]!, /no availability objective has been set for: ledger/)
})

test('REFUSES an availability objective with no probe behind it', () => {
  const planned = planAvailability(TARGETS.filter((target) => target !== 'hub'))
  assert.equal(planned.slos.length, 20)
  assert.equal(planned.refusals.length, 1)
  assert.match(planned.refusals[0]!, /is not probing: hub/)
})

test('an availability SLO is attributed to the target, and a journey SLO is not', () => {
  // Two different fields that both land in `slos.service`, and conflating them is the drift
  // `tiers.yaml` exists to prevent. A journey names the service that owes the joined-up answer
  // (`ecosystem.event-bus` -> activity); a probe can only say that one address answered.
  const availability = new Map(planAvailability(TARGETS).slos.map((slo) => [slo.name, slo.service]))
  assert.equal(availability.get('worlds.titles.availability'), 'worlds.titles')
  const journeys = new Map(plan(REGISTRY, NAMES).slos.map((slo) => [slo.name, slo.service]))
  assert.equal(journeys.get('ecosystem.event-bus.runs'), 'activity')
})

/* ------------------------------------------------------------------ the wire */

test('objectivePpm goes on the wire as a STRING', () => {
  // The route refuses a number, and it is right to: an objective sent as a JSON float has already
  // been rounded by whatever produced it.
  const body = bodyFor(plan(REGISTRY, NAMES).slos[0]!)
  assert.equal(typeof body['objectivePpm'], 'string')
  assert.equal(body['objectivePpm'], '990000')
})

test('seed reports each failure rather than throwing on the first', async () => {
  // Twelve PUTs against nothing listening. The point is the shape of the report: a seeder that
  // threw part-way would leave an operator with a stack trace and no statement of which rows exist.
  const results = await seed(plan(REGISTRY, NAMES).slos, {
    baseUrl: 'http://127.0.0.1:1/',
    headers: {},
    timeoutMs: 2_000,
  })
  assert.equal(results.length, 15)
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

test('THE CATALOGUE CAN DESCRIBE EVERY JOURNEY THE OWNER HAS RULED ON', async () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE GAP THIS CAUGHT, WHICH NO OTHER TEST IN THIS FILE COULD.**
   *
   * Every case above builds its own `REGISTRY`, so they prove `plan`'s arithmetic and prove nothing
   * about the catalogue the command actually passes it. `catalogue()` returned only the service and
   * ecosystem journeys, so adding objectives for `browser.bj-med-01` and `browser.bj-med-02` moved
   * them from one refusal to another — "no objective has been set" became "this build cannot
   * describe them" — and the seeder still would not have written their rows. Found by running
   * `beacon slo-seed --dry-run`, which is the only thing that would have found it.
   *
   * Kills the mutation "drop the browser tier from `catalogue()`", and every future variant of it:
   * an objective for a journey nothing can name is an objective that never becomes a row.
   */
  const described = new Set((await catalogue()).map((journey) => journey.name))
  const undescribed = Object.keys(OBJECTIVES).filter((name) => !described.has(name))
  assert.deepEqual(undescribed, [])
})

test('the browser tier is described whether or not this process could RUN it', async () => {
  // The seeder runs from a container with no browser, and the estate's `journeys` table has had
  // `browser.bj-med-01` and `browser.bj-med-02` in it — gated, and skipping — since they shipped.
  // A catalogue that answered "no browser, so no journeys" would describe neither, which is a
  // seeder whose output depends on which process invoked it: exactly what `plan`'s header refuses.
  const described = new Map((await catalogue()).map((journey) => [journey.name, journey.service]))
  // `studio`, not `market`. The service that owns the rule an upload journey asserts is the one
  // that stores and re-serves the bytes; deriving it from the name would give `browser`.
  assert.equal(described.get('browser.bj-med-01'), 'studio')
  assert.equal(described.get('browser.bj-med-02'), 'studio')
})
