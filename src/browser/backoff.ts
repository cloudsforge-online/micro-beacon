/**
 * The one place in this repository outside the two deadline races where time is allowed to pass.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **CI RULE 8 CAUGHT THE FIRST VERSION OF THIS, AND THE RULE WAS RIGHT.**
 *
 * `.github/workflows/ci.yml` bans `setTimeout` anywhere but `probes.ts` and `journeys.ts`, and
 * states why: the service this replaces had its entire schedule in module-scope timers, so two
 * replicas did every job twice. Deadline timers are exempt "and named explicitly… It is a
 * deadline, not a schedule; the difference is that nothing recurs."
 *
 * The browser tier's fixtures need to wait, for a reason that fits that distinction exactly:
 * identity rate-limits `/auth/register` to five per window and `/auth/login` to ten
 * (`identity/src/server.ts:421-422`), taken at dispatch so a refusal costs what a success does. A
 * shard of six money journeys reaches both. Honouring the `retry-after` the service ITSELF names is
 * a harness waiting its turn; the alternative is a harness that reports the product broken because
 * it was throttled.
 *
 * The first attempt put a `setTimeout` in each of two files and CI went red. The fix is not to
 * widen the rule's allowlist to two more paths — a guard that grows an exemption per caller stops
 * being a guard. It is to make the exemption exactly ONE file, which is this one, and to make that
 * file impossible to misuse:
 *
 *   * **It is bounded, and the bound is enforced rather than documented.** Anything over
 *     `MAX_WAIT_MS` is clamped, and a non-finite or negative value waits nothing at all. A caller
 *     cannot sleep for ever by passing a header it did not check.
 *   * **Nothing recurs.** There is no `setInterval` here and no self-rescheduling. One call, one
 *     wait, one resolution — which is the property Rule 8's own text turns on.
 *   * **It is abortable.** The journey's own `AbortSignal` cuts it short, so a cancelled run does
 *     not hold the process open for the length of a rate-limit window.
 *   * **`backoff.test.ts` proves all three**, so the exemption is checked rather than asserted.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The longest a fixture may wait for a limiter, whatever the service asked for.
 *
 * Thirty seconds: longer than any window this estate configures, and short enough that four
 * attempts cannot outlast a journey's own 120s deadline by so much that the deadline stops being
 * the thing that fails. A service asking for more than this is a service whose limiter a journey
 * should give up against rather than sit out.
 */
export const MAX_WAIT_MS = 30_000

/**
 * How long to wait, given whatever a `retry-after` header said.
 *
 * A pure function, so the clamping is provable without waiting for anything. `retry-after` is in
 * SECONDS. Everything that is not a positive finite number becomes the floor rather than an error:
 * a missing header is the ordinary case, and a fixture that threw on one would be stricter than the
 * specification it is reading.
 */
export function waitMsFor(retryAfterHeader: string | null, floorSeconds = 5): number {
  const parsed = Number(retryAfterHeader ?? '')
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : floorSeconds
  return Math.min(seconds, MAX_WAIT_MS / 1_000) * 1_000
}

/**
 * Wait, once, for at most `MAX_WAIT_MS`, and stop early if the run is abandoned.
 *
 * The `setTimeout` below is the only one in `src/` outside `probes.ts` and `journeys.ts`, and
 * `ci.yml` names this file to permit it. Read the header before adding a second anywhere.
 */
export async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  const bounded = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_WAIT_MS) : 0
  if (bounded === 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, bounded)
    function onAbort(): void {
      clearTimeout(timer)
      // Resolved rather than rejected: the caller's next request carries the same signal and will
      // report the abort itself, with its own context. Throwing here would replace "the run was
      // cancelled while seeding" with a bare AbortError from a sleep.
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
