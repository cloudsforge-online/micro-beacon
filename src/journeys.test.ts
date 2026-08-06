/**
 * The journey harness.
 *
 * The three rules of 13-operational-model.md, each asserted rather than described:
 * an assertion failure is `fail` and any other throw is `error`; a skip is never green; teardown
 * runs on every exit path.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  JourneyAssertion,
  JourneySkip,
  journeyStatusValue,
  latestRuns,
  listRegistered,
  recentRuns,
  recordRun,
  runJourney,
  setMuted,
  syncRegistry,
} from './journeys.ts'
import { db, fakeJourney, migrateTestDb, openDb, resetBeacon, skip } from './testsupport.ts'

describe('a failed assertion and a thrown error are different outcomes', () => {
  it('passes a journey that does nothing wrong', async () => {
    const run = await runJourney(fakeJourney('ok', async () => {}))
    assert.equal(run.status, 'pass')
    assert.equal(run.error, null)
  })

  it('FAILS on an assertion — the product is broken', async () => {
    const run = await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.assert(false, 'the withdrawal never credited')
      }),
    )
    assert.equal(run.status, 'fail')
    assert.equal(run.error, 'the withdrawal never credited')
  })

  it('ERRORS on any other throw — Beacon is broken', async () => {
    const run = await runJourney(
      fakeJourney('a', async () => {
        throw new TypeError('cannot read properties of undefined')
      }),
    )
    // Collapsing this into `fail` is how somebody spends an evening debugging a service that was
    // fine.
    assert.equal(run.status, 'error')
    assert.match(run.error ?? '', /^TypeError:/)
  })

  it('names the step an assertion failed in', async () => {
    const run = await runJourney(
      fakeJourney('a', async (ctx) => {
        await ctx.step('sign in', async () => {})
        await ctx.step('withdraw', async () => {
          ctx.assert(false, 'no')
        })
      }),
    )
    assert.equal(run.failedStep, 'withdraw')
  })

  it('records every step it reached, in order', async () => {
    const run = await runJourney(
      fakeJourney('a', async (ctx) => {
        await ctx.step('one', async () => {})
        await ctx.step('two', async () => {})
        await ctx.step('three', async () => {
          ctx.assert(false, 'no')
        })
      }),
    )
    assert.deepEqual(
      run.steps.map((step) => `${step.name}:${step.status}`),
      ['one:pass', 'two:pass', 'three:fail'],
    )
  })

  it('returns a step value to its caller', async () => {
    let captured: string | null = null
    await runJourney(
      fakeJourney('a', async (ctx) => {
        captured = await ctx.step('token', async () => 'abc')
      }),
    )
    assert.equal(captured, 'abc')
  })

  it('never throws, whatever the journey does', async () => {
    await assert.doesNotReject(() =>
      runJourney(
        fakeJourney('a', async () => {
          throw new Error('boom')
        }),
      ),
    )
  })
})

describe('not-run is not passed', () => {
  it('SKIPS when the journey says so', async () => {
    const run = await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.skip('no credentials configured')
      }),
    )
    assert.equal(run.status, 'skip')
    assert.equal(run.error, 'no credentials configured')
  })

  it('skips when an address is not configured, rather than failing', async () => {
    const run = await runJourney(fakeJourney('a', async (ctx) => void ctx.target('identity')))
    assert.equal(run.status, 'skip')
    assert.match(run.error ?? '', /no address configured/)
  })

  it('resolves an address that IS configured', async () => {
    let seen: string | null = null
    await runJourney(
      fakeJourney('a', async (ctx) => {
        seen = ctx.target('identity')
      }),
      { targets: new Map([['identity', 'http://127.0.0.1:4001']]) },
    )
    assert.equal(seen, 'http://127.0.0.1:4001')
  })

  it('A SKIP IS NEVER GREEN in the metric', () => {
    assert.equal(journeyStatusValue('skip'), 0.5)
    assert.notEqual(journeyStatusValue('skip'), 1)
  })

  it('publishes 1 only for a pass', () => {
    assert.equal(journeyStatusValue('pass'), 1)
    assert.equal(journeyStatusValue('fail'), 0)
    assert.equal(journeyStatusValue('error'), 0)
  })
})

describe('cleanup runs on every exit path', () => {
  it('runs teardown after a passing journey', async () => {
    const ran: string[] = []
    await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.cleanup(() => void ran.push('one'))
      }),
    )
    assert.deepEqual(ran, ['one'])
  })

  it('runs teardown after a FAILING journey', async () => {
    const ran: string[] = []
    await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.cleanup(() => void ran.push('one'))
        ctx.assert(false, 'no')
      }),
    )
    assert.deepEqual(ran, ['one'])
  })

  it('runs teardown after a THROWN journey', async () => {
    const ran: string[] = []
    await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.cleanup(() => void ran.push('one'))
        throw new Error('boom')
      }),
    )
    assert.deepEqual(ran, ['one'])
  })

  it('runs teardown after a SKIPPED journey', async () => {
    const ran: string[] = []
    await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.cleanup(() => void ran.push('one'))
        ctx.skip('nope')
      }),
    )
    assert.deepEqual(ran, ['one'])
  })

  it('runs teardown in reverse order', async () => {
    const ran: string[] = []
    await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.cleanup(() => void ran.push('one'))
        ctx.cleanup(() => void ran.push('two'))
      }),
    )
    assert.deepEqual(ran, ['two', 'one'])
  })

  it('keeps running teardown after one of them throws', async () => {
    const ran: string[] = []
    await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.cleanup(() => void ran.push('first-registered'))
        ctx.cleanup(() => {
          throw new Error('teardown failed')
        }, 'bad')
      }),
    )
    assert.deepEqual(ran, ['first-registered'])
  })

  it('does not let a failing teardown overwrite the verdict', async () => {
    const run = await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.cleanup(() => {
          throw new Error('teardown failed')
        }, 'bad')
      }),
    )
    // A journey that passed and then failed to tidy up is still a journey that passed, and the
    // verdict is the part somebody acts on.
    assert.equal(run.status, 'pass')
    assert.ok(run.steps.some((step) => step.name === 'bad (teardown)'))
  })
})

describe('a journey that runs long is a failure, not an error', () => {
  it('fails on its own deadline', async () => {
    const run = await runJourney(
      fakeJourney('a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }),
      { deadlineMs: 60 },
    )
    // `fail`, not `error`: a journey that ran out of time is a product that took too long, and
    // classing it as `error` would send the investigation to the wrong team.
    assert.equal(run.status, 'fail')
    assert.match(run.error ?? '', /exceeded 60ms/)
  })

  it('returns promptly rather than waiting for the work', async () => {
    const started = Date.now()
    await runJourney(
      fakeJourney('a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10_000))
      }),
      { deadlineMs: 60 },
    )
    assert.ok(Date.now() - started < 3_000)
  })

  it('aborts the signal it handed the journey', async () => {
    let aborted = false
    await runJourney(
      fakeJourney('a', async (ctx) => {
        ctx.signal.addEventListener('abort', () => (aborted = true))
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }),
      { deadlineMs: 50 },
    )
    assert.equal(aborted, true)
  })

  it('prefers a journey\'s own deadline over the global one', async () => {
    const run = await runJourney(
      fakeJourney(
        'a',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5_000))
        },
        { deadlineMs: 60 },
      ),
      { deadlineMs: 60_000 },
    )
    assert.equal(run.status, 'fail')
  })
})

describe('the error types are distinguishable', () => {
  it('names JourneyAssertion', () => {
    assert.equal(new JourneyAssertion('x').name, 'JourneyAssertion')
  })
  it('names JourneySkip', () => {
    assert.equal(new JourneySkip('x').name, 'JourneySkip')
  })
})

describe('the registry and the run log', { skip }, () => {
  let sql: postgres.Sql
  const CRITICAL = fakeJourney('identity.register', async () => {})

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

  it('syncs the code registry into the table', async () => {
    const registered = await listRegistered(db(sql))
    assert.equal(registered.length, 1)
    assert.equal(registered[0]?.critical, true)
    assert.equal(registered[0]?.muted, false)
  })

  it('is idempotent', async () => {
    await syncRegistry(db(sql), [CRITICAL])
    assert.equal((await listRegistered(db(sql))).length, 1)
  })

  it('PRESERVES a mute across a sync', async () => {
    // A deploy that silently unmuted every journey would hand an on-call engineer a wall of red
    // at the worst possible moment.
    await setMuted(db(sql), CRITICAL.name, true, 'flaky since the identity deploy', 'user:1')
    await syncRegistry(db(sql), [CRITICAL])
    assert.equal((await listRegistered(db(sql)))[0]?.muted, true)
  })

  it('updates the title and group on a sync', async () => {
    await syncRegistry(db(sql), [{ ...CRITICAL, title: 'a better sentence', productGroup: 'Wallet' }])
    const [registered] = await listRegistered(db(sql))
    assert.equal(registered?.title, 'a better sentence')
    assert.equal(registered?.productGroup, 'Wallet')
  })

  it('refuses a mute with no reason and no owner', async () => {
    // `journeys_mute_is_attributed`. "We'll write it up later" cannot commit.
    await assert.rejects(async () => {
      await sql`update journeys set muted = true where name = ${CRITICAL.name}`
    })
  })

  it('clears the reason and the owner when unmuted', async () => {
    await setMuted(db(sql), CRITICAL.name, true, 'flaky', 'user:1')
    const unmuted = await setMuted(db(sql), CRITICAL.name, false, null, null)
    assert.equal(unmuted?.muted, false)
    assert.equal(unmuted?.mutedReason, null)
  })

  it('records a run and its steps', async () => {
    const run = await runJourney(
      fakeJourney('identity.register', async (ctx) => {
        await ctx.step('one', async () => {})
        await ctx.step('two', async () => {})
      }),
    )
    await recordRun(db(sql), run)
    const steps = (await sql`
      select name from journey_steps where run_id = ${run.runId} order by seq
    `) as unknown as { name: string }[]
    assert.deepEqual(
      steps.map((step) => step.name),
      ['one', 'two'],
    )
  })

  it('reports the latest run per journey', async () => {
    const first = await runJourney(CRITICAL)
    await recordRun(db(sql), { ...first, startedAt: new Date(Date.now() - 60_000) })
    const second = await runJourney(fakeJourney('identity.register', async (ctx) => ctx.assert(false, 'no')))
    await recordRun(db(sql), second)
    const latest = await latestRuns(db(sql))
    assert.equal(latest[0]?.status, 'fail')
  })

  it('EXCLUDES a manual run from the latest, so pressing Run cannot open the gate', async () => {
    const scheduled = await runJourney(fakeJourney('identity.register', async (ctx) => ctx.assert(false, 'no')))
    await recordRun(db(sql), { ...scheduled, startedAt: new Date(Date.now() - 60_000) })
    const manual = await runJourney(CRITICAL)
    await recordRun(db(sql), { ...manual, trigger: 'manual' })
    assert.equal((await latestRuns(db(sql)))[0]?.status, 'fail')
  })

  it('returns fewer recent runs than asked for when there are fewer', async () => {
    await recordRun(db(sql), await runJourney(CRITICAL))
    assert.equal((await recentRuns(db(sql), CRITICAL.name, 3)).length, 1)
  })

  it('returns recent runs newest first', async () => {
    for (let i = 3; i >= 1; i--) {
      const run = await runJourney(CRITICAL)
      await recordRun(db(sql), { ...run, startedAt: new Date(Date.now() - i * 60_000) })
    }
    const recent = await recentRuns(db(sql), CRITICAL.name, 3)
    assert.ok(recent[0]!.startedAt > recent[2]!.startedAt)
  })
})
