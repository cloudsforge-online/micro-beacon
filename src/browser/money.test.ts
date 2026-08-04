/**
 * The money oracle's arithmetic, proved without an estate and without a chain.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`BigInt('')` IS `0n`, AND THIS ESTATE HAS BEEN BITTEN BY IT REPEATEDLY.**
 *
 * So is `BigInt('0x')`, which is what `eth_call` answers for an address holding no code. Both are
 * how "we could not read this balance" silently becomes "this balance is zero" — and a zero is the
 * one wrong answer nobody questions. `micro-wallet/src/pricingclient.ts` states the rule for
 * prices: "a zero would be a valuation, and a valuation of zero is a lie about a holding that
 * exists." These cases are that rule made mechanical for balances.
 *
 * Everything below is a pure function of data, so it runs in CI with no browser, no Postgres and
 * no node — which matters, because the assertions these back are the ones a browser journey makes
 * about somebody's money.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MoneyError,
  decodeUintAt,
  digitRuns,
  encodeAddress,
  encodeCall,
  encodeUint,
  money,
  moneyOrNull,
  rendersAmount,
  weiToDecimal,
} from './money.ts'

test('an empty string is refused rather than read as zero', () => {
  // The whole file in one case. `BigInt('')` is 0n; `money('')` is a thrown error naming the field.
  assert.throws(() => money('', 'a balance'), MoneyError)
  assert.throws(() => money(undefined, 'a balance'), MoneyError)
  assert.throws(() => money(null, 'a balance'), MoneyError)
  // A NUMBER is refused too, and this is not pedantry: 1234567890123456789 as a JS number is
  // 1234567890123456800, and the digits it loses are the least significant ones.
  assert.throws(() => money(1234, 'a balance'), MoneyError)
  assert.throws(() => money(' 12 ', 'a balance'), MoneyError)
  assert.throws(() => money('1.5', 'a balance'), MoneyError)
  assert.throws(() => money('0x10', 'a balance'), MoneyError)
})

test('a real balance survives past 2^53 exactly', () => {
  assert.equal(money('0', 'x'), 0n)
  assert.equal(money('700000000000000000', 'x'), 700000000000000000n)
  // The one that a float would round. 2^53 + 1.
  assert.equal(money('9007199254740993', 'x'), 9007199254740993n)
  assert.equal(money('-42', 'x'), -42n)
})

test('moneyOrNull answers null for absent, never 0n', () => {
  assert.equal(moneyOrNull(''), null)
  assert.equal(moneyOrNull(undefined), null)
  assert.equal(moneyOrNull('0'), 0n)
  // The distinction the whole oracle turns on: an absent balance and a zero balance are two
  // different values here, and a caller that conflates them has to do it on purpose.
  assert.notEqual(moneyOrNull(''), moneyOrNull('0'))
})

test('an eth_call that answered nothing decodes to null, not to a zero balance', () => {
  // `0x` is what a node answers for an address with no code, for a call to a selector no function
  // has, and while it is syncing. `BigInt('0x')` is 0n, which would reach a journey as "this market
  // holds nothing" about a market holding a real pool.
  assert.equal(decodeUintAt('0x'), null)
  assert.equal(decodeUintAt(''), null)
  assert.equal(decodeUintAt(null), null)
  assert.equal(decodeUintAt(undefined), null)
  // A short word is not a zero either.
  assert.equal(decodeUintAt('0x00ff'), null)
  // And a well-formed zero IS a zero.
  assert.equal(decodeUintAt(`0x${'0'.repeat(64)}`), 0n)
})

test('a two-word return is read by index, which is how stakeOf gets its second number', () => {
  const yes = 300000000000000000n
  const no = 700000000000000000n
  const data = `0x${yes.toString(16).padStart(64, '0')}${no.toString(16).padStart(64, '0')}`
  assert.equal(decodeUintAt(data, 0), yes)
  assert.equal(decodeUintAt(data, 1), no)
  // Reading past the end is null rather than zero, for the same reason as everything above.
  assert.equal(decodeUintAt(data, 2), null)
})

test('calldata is a selector and 32-byte words, and a bad address is refused', () => {
  const call = encodeCall('pool(uint256)', [{ type: 'uint256', value: 1n }])
  assert.equal(call, `0xfe313112${'0'.repeat(63)}1`)
  assert.equal(call.length, 2 + 8 + 64)
  assert.equal(
    encodeAddress('0x0f3aAd2C4d56C473ab1F34a8c1a3Cf24F9cd3933'),
    `${'0'.repeat(24)}0f3aad2c4d56c473ab1f34a8c1a3cf24f9cd3933`,
  )
  assert.throws(() => encodeAddress('0x1234'), MoneyError)
  assert.throws(() => encodeAddress('not an address'), MoneyError)
  assert.throws(() => encodeUint(-1n), MoneyError)
  assert.throws(() => encodeUint(1n << 256n), MoneyError)
})

test('wei renders to the exact decimal the page has to show', () => {
  // The bridge between "the contract holds 300000000000000000" and "the page says 0.3 EMBER". The
  // decimal is DERIVED from the bigint by string arithmetic, so both sides of the assertion stay
  // exact and nothing is compared as a float.
  assert.equal(weiToDecimal(300000000000000000n), '0.3')
  assert.equal(weiToDecimal(1000000000000000000n), '1')
  assert.equal(weiToDecimal(986000000000000000n), '0.986')
  assert.equal(weiToDecimal(1n), '0.000000000000000001')
  assert.equal(weiToDecimal(0n), '0')
  // Not a division: this value is past 2^53 and every digit of it survives.
  assert.equal(weiToDecimal(12345678901234567890n), '12.34567890123456789')
  assert.equal(weiToDecimal(1234567n, 0), '1234567')
})

test('a rendered figure is matched on its digits, with the separators a locale added removed', () => {
  // `1,234,567` and `1234567` are the same amount; failing on the comma would be testing
  // Intl.NumberFormat. `1.5` and `15` are NOT, and are not conflated: the point stays a boundary.
  assert.ok(rendersAmount('SHARDS 1,234,567 EMBER 0', 1234567n))
  assert.ok(rendersAmount('Available: 1234567 SHARD', 1234567n))
  assert.ok(!rendersAmount('Available: 1234568 SHARD', 1234567n))
  // The failure this guards: a page showing a TRUNCATED figure. `1,234,567` contains no run equal
  // to `123456`, so a page that dropped a digit is red rather than a substring match away from green.
  assert.ok(!rendersAmount('SHARDS 1,234,567', 123456n))
  assert.deepEqual([...digitRuns('0.3 EMBER')].sort(), ['0', '3'])
})
