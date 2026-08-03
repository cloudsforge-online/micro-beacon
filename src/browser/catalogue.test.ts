/**
 * The meta-test doc 22 §3.2 asks for, plus the ones that stop the catalogue lying about itself.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **"THE SUITE REFUSES TO RUN RATHER THAN REPORTING GREEN."**
 *
 * Doc 22 §3.2 sets the rule and says why advice will not do: a browser scenario may never assert a
 * business rule, because a client-side test asserting "the four withdrawn SKUs are not shown"
 * passes, green, against the defect where hiding them was the entire control. So the boundary is
 * mechanical — a scenario whose expected outcome is a refusal, and which does not name the
 * server-side test that owns the refusal, fails this file.
 *
 * The rest of the cases here defend the catalogue against the specific ways a table of 86 rows
 * goes wrong: a duplicate id (two scenarios sharing one metric series), a blocker with no citation
 * (an assertion of impossibility nobody can check), a scenario that needs a service nobody names,
 * and — the one that matters most — a blocked scenario silently becoming unblocked because
 * somebody deleted a field.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTINUOUS_T3, T3_IDS, T3_SCENARIOS, blockedByDoc, unblocked } from './catalogue.ts'
import { SURFACE_KEYS } from './journeys.ts'
import { ESTATE_SERVICES } from '../estate.ts'

const ASSERTS = new Set(['presentation', 'client-request', 'navigation'])

test('every scenario declares one of the three assertion kinds, and nothing else', () => {
  for (const scenario of T3_SCENARIOS) {
    assert.ok(ASSERTS.has(scenario.asserts), `${scenario.id} asserts "${scenario.asserts}"`)
  }
  // There is no `absence` kind, deliberately: a scenario that would assert something is NOT on
  // screen must assert the positive presentation fact instead, or it is not a browser scenario.
  assert.equal(ASSERTS.size, 3)
})

test('A SCENARIO THAT EXPECTS A REFUSAL MUST NAME THE SERVER TEST THAT OWNS THE RULE', () => {
  const offenders = T3_SCENARIOS.filter((s) => s.outcome === 'refusal' && s.ownedBy === null)
  assert.deepEqual(
    offenders.map((s) => s.id),
    [],
    'each of these ends in a 4xx, a denial or an absence and cites no owner. The browser asserts ' +
      'the sentence the user is shown; the refusal itself belongs to the service that enforces it.',
  )
  // And the set is not empty, or the rule above would be a rule about nothing.
  assert.ok(
    T3_SCENARIOS.some((s) => s.outcome === 'refusal'),
    'no scenario expects a refusal, which means this check has never fired on anything',
  )
})

test('an ownedBy is a path a grep can resolve, never a description', () => {
  // "The identity service's registration test" is not something anybody can find. A path is.
  const shape = /^[a-z][a-z0-9-]*\/(src|test)\/[A-Za-z0-9._/-]+\.test\.ts$/
  for (const scenario of T3_SCENARIOS) {
    if (scenario.ownedBy === null) continue
    assert.match(scenario.ownedBy, shape, `${scenario.id} owns-by "${scenario.ownedBy}"`)
    const repo = scenario.ownedBy.split('/')[0] as string
    assert.ok(
      scenario.needs.includes(repo) || SURFACE_KEYS.includes(repo) || ESTATE_SERVICES.includes(repo),
      `${scenario.id} points its rule at "${repo}", which it does not list as something it needs`,
    )
  }
})

test('ids are unique and stably shaped', () => {
  assert.equal(new Set(T3_IDS).size, T3_IDS.length, 'two scenarios share an id and so share a metric series')
  for (const id of T3_IDS) {
    assert.match(id, /^BJ-[A-Z0-9]+-\d{2}(-H\d)?$/, `${id} is not a doc 22 scenario id`)
  }
})

test('every scenario names something it needs, in a namespace something can resolve', () => {
  const resolvable = new Set([...SURFACE_KEYS, ...ESTATE_SERVICES, 'policy', 'custody', 'indexer', 'pricing', 'studio', 'community', 'devplatform', 'admin-api', 'faucet', 'trade', 'emberkin', 'aetherholm', 'mint'])
  for (const scenario of T3_SCENARIOS) {
    assert.ok(scenario.needs.length > 0, `${scenario.id} needs nothing, which makes it a tier-1 scenario`)
    for (const need of scenario.needs) {
      assert.ok(resolvable.has(need), `${scenario.id} needs "${need}", which nothing can resolve to an address`)
    }
  }
})

test('a blocked scenario cites the section of doc 22 that records the blocker', () => {
  for (const scenario of T3_SCENARIOS) {
    if (scenario.blocked === null) continue
    // An assertion of impossibility with no citation is the one kind of claim nobody re-checks.
    assert.match(scenario.blocked.doc, /^22 §8\.\d$/, `${scenario.id} cites "${scenario.blocked.doc}"`)
    assert.ok(
      scenario.blocked.reason.length > 60,
      `${scenario.id}'s blocker is too short to act on: "${scenario.blocked.reason}"`,
    )
  }
})

test('the six scenarios that need no session are the six that are unblocked', () => {
  // Pinned as a list rather than a count. Doc 22 §8.7 says no T3 scenario can run until a compose
  // profile serves the bundles; these six are the ones that need NOTHING ELSE, so they are what
  // closing §8.7 buys. A change to this list is a change to that claim and should be reviewed as
  // one.
  assert.deepEqual(
    unblocked().map((s) => s.id).sort(),
    ['BJ-NET-09', 'BJ-NET-14', 'BJ-NET-18', 'BJ-NET-20', 'BJ-NET-21', 'BJ-XS-10'],
  )
})

test('the blocked majority is accounted for, section by section', () => {
  const byDoc = blockedByDoc()
  const total = [...byDoc.values()].reduce((sum, list) => sum + list.length, 0)
  assert.equal(total + unblocked().length, T3_SCENARIOS.length)
  // Every section of doc 22 §8 that blocks anything is represented, and none is empty. A section
  // with no scenarios behind it is either a blocker that has been fixed or one that was never
  // real, and both are worth noticing.
  for (const [doc, list] of byDoc) {
    assert.ok(list.length > 0, `${doc} blocks nothing`)
  }
  assert.ok(byDoc.has('22 §8.1'), 'the sign-in surface is the largest blocker and must be present')
  assert.ok(byDoc.has('22 §8.2'), 'the missing wallet write surface must be present')
})

test('the continuously-run T3 set is a subset of the catalogue and of the unblocked set', () => {
  for (const id of CONTINUOUS_T3) {
    const scenario = T3_SCENARIOS.find((s) => s.id === id)
    assert.ok(scenario, `${id} is in the continuous set and not in the catalogue`)
    // A journey beacon holds a browser open for every few minutes must be one that can actually
    // run. "A declared journey that can only skip refuses every release for ever."
    assert.equal(scenario?.blocked, null, `${id} runs continuously and is blocked`)
  }
})

test('every gate scenario is either runnable or blocked with a reason — never quietly neither', () => {
  const gated = T3_SCENARIOS.filter((s) => s.gate)
  assert.ok(gated.length > 0)
  for (const scenario of gated) {
    // A release candidate does not promote until every ★ is green, so a ★ with no implementation
    // and no stated blocker would be a promotion criterion nobody can satisfy or argue with.
    assert.ok(
      scenario.blocked !== null || unblocked().some((s) => s.id === scenario.id),
      `${scenario.id} is a release-gate scenario in neither state`,
    )
  }
})
