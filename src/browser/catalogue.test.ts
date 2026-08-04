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
  // `chain` is not a service and not a surface: it is the JSON-RPC endpoint of the estate's own
  // node, resolved through BEACON_TARGETS like everything else so that pointing the suite at a
  // different testnet is a variable rather than an edit. It is named here rather than added to
  // ESTATE_SERVICES because nothing probes it as a service — no health endpoint, no journey group.
  const resolvable = new Set([...SURFACE_KEYS, ...ESTATE_SERVICES, 'policy', 'custody', 'indexer', 'pricing', 'studio', 'community', 'devplatform', 'admin-api', 'faucet', 'trade', 'emberkin', 'aetherholm', 'mint', 'chain'])
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

test('THE UNBLOCKED SET IS PINNED, BECAUSE REMOVING A BLOCKER IS A CLAIM ABOUT THE ESTATE', () => {
  // This list was six, then fifty-six, and is now sixty-four. Two changes, both of which are
  // claims about the estate rather than about this file:
  //
  //   * Five Forge Foresight rows, added when the tier gained a chain client and could assert
  //     against `ForesightMarket`'s own storage rather than the mirror the page renders.
  //   * THREE WALLET ROWS, because `NO_WALLET_WRITE` — the largest blocker in the catalogue —
  //     was disproved by driving it. hub-web serves a Send form, a Receive panel and a key
  //     export panel; the claim survived because it was checked against `wallet.tsx`, which
  //     still has no button, rather than against the screen, which does. BJ-WAL-08 and
  //     BJ-WAL-09 are now implemented; BJ-XS-03 is unblocked and not yet written.
  //
  //   * TWO MORE WALLET ROWS — BJ-WAL-16 and BJ-WAL-18 — because `NO_CUSTODY_ADDRESS` was
  //     re-driven and its premise had stopped being true. It said POST /v1/deposits answers 500;
  //     it now answers 201 with an address custody serves back at GET /v1/addresses/:address.
  //     That blocker was CORRECT when written and was falsified by the estate being repaired,
  //     which is the shape of staleness nothing here was watching for — see the note above
  //     `NO_SIGNER` in catalogue.ts. `ecosystem.deposit-address` now drives it on a schedule.
  //
  // The rows that stay blocked moved to blockers naming what was actually found: no fee is
  // configured for any asset, there is no signer in any bundle, there is no MFA enrolment screen,
  // and the withdrawal path consults no policy service. Each was driven.
  //
  // This list was six. It is now sixty-one, because three blockers were removed after being disproved
  // in Chromium against the running estate — see the note above `NO_WALLET_WRITE` in catalogue.ts
  // for what was driven. Pinned as a LIST rather than a count so that removing a fourth blocker is
  // a reviewable change to this file and not a number quietly going up.
  //
  // Unblocked is NOT runnable. It means "can be written"; `journeys.ts` decides what is declared,
  // and `unimplemented()` names every one of these that is not.
  assert.deepEqual(unblocked().map((s) => s.id).sort(), [
    'BJ-ACC-01', 'BJ-ACC-02', 'BJ-ACC-03', 'BJ-ACC-04', 'BJ-ACC-05', 'BJ-ACC-09',
    'BJ-ACC-12', 'BJ-ACC-13', 'BJ-ADM-09', 'BJ-ADM-10', 'BJ-ADM-14', 'BJ-ADM-16',
    'BJ-ADM-19', 'BJ-ADV-01-H5', 'BJ-AET-03', 'BJ-AET-10', 'BJ-AET-11', 'BJ-CRE-03',
    'BJ-CRE-04', 'BJ-CRE-05', 'BJ-DEV-03', 'BJ-DEV-04', 'BJ-DEV-08', 'BJ-DEV-09',
    'BJ-DEV-10', 'BJ-DEV-12', 'BJ-DEV-13', 'BJ-DEV-14', 'BJ-DEV-15', 'BJ-DSH-01',
    'BJ-DSH-17', 'BJ-DSH-20', 'BJ-EMB-01', 'BJ-EMB-11', 'BJ-MKT-03', 'BJ-MKT-08',
    'BJ-MKT-12', 'BJ-NET-09', 'BJ-NET-14', 'BJ-NET-18', 'BJ-NET-20', 'BJ-NET-21',
    'BJ-TRD-02', 'BJ-TRD-03', 'BJ-TRD-04', 'BJ-TRD-06', 'BJ-TRD-12', 'BJ-TRD-13',
    'BJ-FOR-01', 'BJ-FOR-06', 'BJ-FOR-13', 'BJ-FOR-14', 'BJ-FOR-17',
    'BJ-WAL-01', 'BJ-WAL-08', 'BJ-WAL-09', 'BJ-WAL-16', 'BJ-WAL-18', 'BJ-WLD-05', 'BJ-XS-01', 'BJ-XS-03',
    'BJ-XS-04', 'BJ-XS-05', 'BJ-XS-10',
    'BJ-XS-13', 'BJ-XS-14',
  ].sort())
})

test('THE SIGN-IN BLOCKER IS GONE FROM EVERY ROW, NOT JUST FROM THE ONES SOMEBODY REMEMBERED', () => {
  // The failure this guards is the one the estate keeps repeating: a claim corrected in one place
  // and left standing in nineteen others. `NO_SIGNIN`, `EXCHANGE_ROUTE` and `SESSION_DOWNSTREAM`
  // between them blocked forty-four rows, and every one of those rows had to move.
  const stale = T3_SCENARIOS.filter(
    (s) =>
      s.blocked !== null &&
      (/sign a browser in|serves a sign-in page|auth\/exchange/.test(s.blocked.reason) ||
        s.blocked.doc === '22 §8.1'),
  )
  assert.deepEqual(
    stale.map((s) => s.id),
    [],
    'these rows still cite a sign-in blocker that was disproved by driving it in a browser',
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
  // §8.1 is deliberately ABSENT now. It was the largest blocker in the catalogue — the sign-in
  // surface — and it is closed: hub-web serves the page, and BJ-ACC-01 drives it. Asserted as an
  // absence rather than deleted, so that a blocker re-appearing there is a visible change.
  assert.equal(byDoc.has('22 §8.1'), false, 'the sign-in blocker is closed and must not return quietly')
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
