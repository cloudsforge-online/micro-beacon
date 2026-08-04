/**
 * The bounded wait, proved bounded — because it is the one exemption to CI rule 8.
 *
 * An exemption that is asserted rather than checked is an exemption that stops being true. Rule 8
 * permits exactly one `setTimeout` outside the two deadline races, in `backoff.ts`, on the strength
 * of three claims: it is bounded, nothing recurs, and it is abortable. These are those three.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_WAIT_MS, wait, waitMsFor } from './backoff.ts'

test('a retry-after is read in seconds, and anything unusable becomes the floor', () => {
  assert.equal(waitMsFor('2'), 2_000)
  // The ordinary case: no header at all. Not an error — a fixture stricter than the specification
  // it reads is a fixture that fails on a compliant service.
  assert.equal(waitMsFor(null), 5_000)
  assert.equal(waitMsFor(''), 5_000)
  assert.equal(waitMsFor('not a number'), 5_000)
  assert.equal(waitMsFor('-1'), 5_000)
  assert.equal(waitMsFor('0'), 5_000)
})

test('THE BOUND IS ENFORCED, NOT DOCUMENTED', () => {
  // A service asking for an hour is a service a fixture should give up against rather than sit out.
  // Clamped here rather than trusted, so a caller cannot sleep for ever by echoing a header.
  assert.equal(waitMsFor('3600'), MAX_WAIT_MS)
  assert.equal(waitMsFor('1e308'), MAX_WAIT_MS)
})

test('a nonsense duration waits nothing at all rather than for ever', async () => {
  const started = Date.now()
  await wait(Number.NaN)
  await wait(-1)
  await wait(0)
  assert.ok(Date.now() - started < 200, 'a non-positive wait should return immediately')
})

test('it waits once, and it stops when the run is abandoned', async () => {
  // Abortable, which is what stops a cancelled run holding the process open for a rate-limit
  // window. Asserted on the clock rather than on a mock: the property is about real elapsed time.
  //
  // ── AbortSignal.timeout, NOT AN AbortController ─────────────────────────────────────────────
  // The obvious way to write this is a controller and `setTimeout(() => controller.abort(), 50)`.
  // That is what the first draft did, and `smoke.test.ts`'s interception scanner went red on it:
  // it forbids `.abort(` anywhere in this directory because `route.abort()` is how a suite blocks a
  // request. The pattern is broad ON PURPOSE — a scanner that tried to tell `controller.abort()`
  // from `route.abort()` is one that can be talked round — so the fix belongs here, and
  // `AbortSignal.timeout` expresses the same thing without a call the guard has to judge.
  const started = Date.now()
  await wait(MAX_WAIT_MS, AbortSignal.timeout(50))
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2_000, `abandoning the run should cut the wait short, and it took ${elapsed}ms`)
})

test('a real wait actually elapses, so the previous case is not passing for free', async () => {
  const started = Date.now()
  await wait(120)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 100, `a 120ms wait returned after ${elapsed}ms — it did not wait at all`)
})
