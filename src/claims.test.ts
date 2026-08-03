/**
 * The scoreboard, checked.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A COVERAGE TABLE NOBODY CHECKS IS THE MOST CONFIDENTLY WRONG DOCUMENT IN AN ESTATE.**
 *
 * `17-definition-of-done.md` §7 has said "three of the eleven are true today" since it was written,
 * and nothing anywhere recomputes it — the row for claim 1 names "a journey signing into all eight
 * surfaces" as its evidence, and no such journey exists in any repository. That is not a criticism
 * of the document; it is what happens to any claim held only in prose.
 *
 * So the four cases below are the ones that make `claims.ts` unable to lie in the direction that
 * matters. A claim may not say `partly` or `proven` without naming a journey; a named journey must
 * exist in the registry this build actually ships; and a claim with no journey must carry a
 * blocker specific enough that somebody could go and close it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAIMS, citedJourneys, scoreboard, unresolvedJourneys } from './claims.ts'
import { SERVICE_JOURNEYS } from './estate.ts'
import { ALL_ECOSYSTEM_JOURNEYS } from './ecosystem.ts'
import { T3_SCENARIOS } from './browser/catalogue.ts'

const EVERYTHING = [...SERVICE_JOURNEYS, ...ALL_ECOSYSTEM_JOURNEYS]

test('all eleven claims are present, numbered 1 to 11', () => {
  assert.equal(CLAIMS.length, 11)
  assert.deepEqual(
    CLAIMS.map((c) => c.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  )
})

test('A CLAIM MAY NOT BE PARTLY OR PROVEN WITHOUT NAMING A JOURNEY', () => {
  const offenders = CLAIMS.filter((c) => c.status !== 'unproven' && c.journeys.length === 0)
  assert.deepEqual(
    offenders.map((c) => c.n),
    [],
    'a row that claims coverage and cites nothing is the exact failure this file exists to stop',
  )
})

test('every journey a claim names exists in the registry this build ships', () => {
  // A citation that resolves to nothing is worse than no citation: it reads as evidence.
  assert.deepEqual(unresolvedJourneys(EVERYTHING), [])
  assert.ok(citedJourneys().length > 0, 'no claim cites any journey, so this check has never fired')
})

test('a claim with no journey carries a blocker somebody could act on', () => {
  for (const claim of CLAIMS) {
    if (claim.journeys.length > 0) continue
    assert.ok(claim.gap !== null, `claim ${claim.n} has neither a journey nor a reason`)
    assert.ok((claim.gap ?? '').length > 80, `claim ${claim.n}'s gap is too vague: "${claim.gap}"`)
    // A blocker names a thing: a file, a variable, a route, a document section. "Not built yet" is
    // a mood.
    assert.match(
      claim.gap ?? '',
      /\.(ts|tsx|yml|md)\b|doc 22 §|[A-Z][A-Z_]{6,}/,
      `claim ${claim.n}'s gap names nothing checkable: "${claim.gap}"`,
    )
  }
})

test('a partly-proven claim still says what it does not prove', () => {
  for (const claim of CLAIMS.filter((c) => c.status === 'partly')) {
    assert.ok(claim.gap !== null, `claim ${claim.n} is "partly" and names no remainder`)
    // "Partly" with no remainder is "proven" with a hedge, and a hedge is what gets rounded up in
    // the next status meeting.
    assert.ok((claim.gap ?? '').length > 80)
  }
})

test('nothing is claimed as proven, which is the honest state today', () => {
  const board = scoreboard()
  assert.equal(board.proven, 0, 'if something has become fully proven, this line is what changes')
  assert.equal(board.proven + board.partly + board.unproven, 11)
  // Recorded as a number so the direction of travel is visible in a diff rather than in a memory.
  assert.equal(board.partly, 4)
  assert.equal(board.unproven, 7)
})

test('the claims that browser scenarios would move point at scenarios that exist', () => {
  // Claims 1, 3, 6, 7 and 9 all cite doc 22 blockers. Each of those blockers has scenarios behind
  // it in the T3 catalogue, so "blocked on a screen that does not exist" is a statement with a
  // list attached rather than an assertion.
  const docs = new Set(T3_SCENARIOS.map((s) => s.blocked?.doc).filter((d): d is string => Boolean(d)))
  for (const claim of CLAIMS) {
    const cited = (claim.gap ?? '').match(/doc 22 §8\.\d/g) ?? []
    for (const citation of cited) {
      assert.ok(
        docs.has(citation.replace('doc ', '')),
        `claim ${claim.n} cites ${citation}, which blocks no scenario in the catalogue`,
      )
    }
  }
})

test('the vision’s own wording is used, not a paraphrase', () => {
  // Paraphrasing a claim is how a claim gets easier. These are the eleven sentences from
  // 01-product-vision.md §2, and each carries the word that makes it hard.
  const musts: readonly [number, RegExp][] = [
    [1, /signs into everything, once/],
    [3, /whichever product you came from/],
    [4, /a single number that is the truth/],
    [5, /on one timeline/],
    [6, /spend and earn identically in every product/],
    [9, /any question from one place/],
    [10, /reconciles against the chain/],
  ]
  for (const [n, pattern] of musts) {
    const claim = CLAIMS.find((c) => c.n === n)
    assert.match(claim?.statement ?? '', pattern, `claim ${n} has been softened`)
  }
})
