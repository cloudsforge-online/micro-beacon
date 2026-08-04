/**
 * keccak-256, pinned against the published vectors and against the estate's own recorded selector.
 *
 * This file is the reason `keccak.ts` is allowed to exist at all. A hand-written hash is only worth
 * having if it is checked, and the check has to be able to catch the two mistakes that actually
 * happen: a transposed ρ offset (which produces a plausible-looking digest that is wrong for every
 * input), and SHA3-256 substituted for keccak-256 (which differs only in one padding byte and is
 * what `node:crypto` gives you if you reach for `createHash('sha3-256')`).
 *
 * Both were live here. The first draft of the ρ table repeated `25` and dropped the trailing `14`;
 * every vector below failed, which is how it was found within a minute of being written.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { keccak256, selector, sha3_256, toHex } from './keccak.ts'
import { MARKET_ABI, STAKED_EVENT } from './money.ts'

const hash = (input: string): string => toHex(keccak256(new TextEncoder().encode(input)))

test('the published keccak-256 vectors', () => {
  // The empty string. This is the one that separates keccak-256 from SHA3-256: SHA3-256 of the
  // empty string is a6…8a, and if this file ever starts printing that, somebody has swapped the
  // padding byte from 0x01 to 0x06 and every selector below is silently wrong.
  assert.equal(hash(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  assert.equal(hash('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
})

test('the permutation agrees with OpenSSL at every length across the rate boundary', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE CHECK THAT IS NOT THIS FILE MARKING ITS OWN HOMEWORK.
  //
  // keccak-256 and SHA3-256 are the same sponge and differ in one padding byte, and node ships
  // SHA3-256 from OpenSSL. So every length from 0 to 200 is compared against an implementation
  // this repository did not write — covering the single-block case, the exact-fit case where the
  // padding byte and the 0x80 land on the same byte, and the multi-block case.
  //
  // This is what caught the first draft: a ρ table with a repeated 25 and a missing 14 produced a
  // 64-character digest for every input and disagreed with OpenSSL at length 0.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  for (let length = 0; length <= 200; length += 1) {
    const message = randomBytes(length)
    assert.equal(
      toHex(sha3_256(new Uint8Array(message))),
      createHash('sha3-256').update(message).digest('hex'),
      `disagreed at length ${length}`,
    )
  }
  for (const length of [1_000, 4_096]) {
    const message = randomBytes(length)
    assert.equal(
      toHex(sha3_256(new Uint8Array(message))),
      createHash('sha3-256').update(message).digest('hex'),
      `disagreed at length ${length}`,
    )
  }
})

test('it is NOT SHA3-256, which is the one thing the OpenSSL comparison cannot check', () => {
  // One byte of domain separation, and reaching for node's sha3-256 would produce plausible-looking
  // wrong answers — a wrong selector that is still eight valid hex characters. The vectors above
  // are the only guard against that, and this states it as its own case so deleting them is a red.
  const message = new TextEncoder().encode('claim()')
  assert.notEqual(toHex(keccak256(message)), toHex(sha3_256(message)))
  assert.notEqual(toHex(keccak256(message)), createHash('sha3-256').update('claim()').digest('hex'))
})

test('claim() is 0x4e71d92d, which the frontend recorded independently', () => {
  // `foresight-web/src/lib/abi.ts` states this value in prose — "selector('claim()') is
  // 0x4e71d92d" — and explains that it is written in a test rather than in the source so the build
  // checks it. This is that check, on the other side of the wire. Two implementations, one number.
  assert.equal(selector('claim()'), '0x4e71d92d')
})

test('every selector this tier actually sends is pinned', () => {
  // Pinned rather than derived-and-trusted. A wrong selector does not error: `eth_call` against a
  // function that does not exist answers `0x`, `decodeUintAt` turns that into `null`, and a
  // journey that treated null as "no stake" would report a market with money in it as empty.
  assert.equal(selector(MARKET_ABI.pool), '0xfe313112')
  assert.equal(selector(MARKET_ABI.stakeOf), '0x42623360')
  assert.equal(selector(MARKET_ABI.payoutOf), '0x6da61d1e')
  assert.equal(selector(MARKET_ABI.status), '0x200d2ed2')
  assert.equal(selector(MARKET_ABI.winningOutcome), '0x9b34ae03')
  assert.equal(selector(MARKET_ABI.feeAmount), '0x69e15404')
})

test('an event topic is the WHOLE digest, not a four-byte selector', () => {
  // The mistake this catches: reusing `selector()` for a log topic. A truncated topic matches no
  // log at all, so `stakersOf` would answer "this market has no stakers" about a market with two —
  // a wrong answer wearing the costume of an empty one.
  const topic = hash(STAKED_EVENT)
  assert.equal(topic.length, 64)
  assert.ok(topic.startsWith(selector(STAKED_EVENT).slice(2)))
})
