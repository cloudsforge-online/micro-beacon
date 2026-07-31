/**
 * Incidents, and above all the dedupe.
 *
 * "An incident opens once and dedupes on repeat failures rather than opening a new one per probe"
 * is the property. It is enforced by `incidents_open_uniq`, a partial unique index, and the tests
 * below drive it the way an outage does: repeatedly, from more than one caller, and out of order.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  addUpdate,
  advanceState,
  closeIncident,
  findIncident,
  listOpen,
  listRecent,
  listUpdates,
  markReviewed,
  openIncident,
  severityFor,
} from './incidents.ts'
import { db, migrateTestDb, openDb, resetBeacon, skip } from './testsupport.ts'

const BASE = {
  scope: 'probe' as const,
  subject: 'ledger.postings',
  severity: 'sev2' as const,
  productGroup: 'Wallet',
}

describe('incidents', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetBeacon(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  it('opens one', async () => {
    const result = await openIncident(db(sql), BASE)
    assert.equal(result.opened, true)
    assert.equal(result.incident.failures, 1)
    assert.equal(result.incident.state, 'detected')
  })

  it('OPENS ONCE AND DEDUPES ON REPEAT FAILURES', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // A probe failing every thirty seconds for an hour is ONE incident with failures = 120, not
    // a hundred and twenty incidents. The page that a hundred and twenty incidents opens is
    // unreadable at exactly the moment it matters.
    // ════════════════════════════════════════════════════════════════════════════════════════
    for (let i = 0; i < 20; i++) await openIncident(db(sql), BASE)
    const open = await listOpen(db(sql))
    assert.equal(open.length, 1)
    assert.equal(open[0]?.failures, 20)
  })

  it('reports only the first open as opened', async () => {
    assert.equal((await openIncident(db(sql), BASE)).opened, true)
    for (let i = 0; i < 5; i++) {
      assert.equal((await openIncident(db(sql), BASE)).opened, false)
    }
  })

  it('dedupes across concurrent callers, which is what two replicas are', async () => {
    // Sequential opens would pass against an implementation with no index at all — each caller
    // would simply insert. Concurrency is what makes the constraint the thing under test.
    const results = await Promise.all(Array.from({ length: 8 }, () => openIncident(db(sql), BASE)))
    assert.equal((await listOpen(db(sql))).length, 1)
    assert.equal(results.filter((result) => result.opened).length, 1)
  })

  it('keeps separate incidents for separate subjects', async () => {
    await openIncident(db(sql), BASE)
    await openIncident(db(sql), { ...BASE, subject: 'market.listings', productGroup: 'Market' })
    assert.equal((await listOpen(db(sql))).length, 2)
  })

  it('keeps separate incidents for the same subject in a different scope', async () => {
    await openIncident(db(sql), BASE)
    await openIncident(db(sql), { ...BASE, scope: 'journey' })
    assert.equal((await listOpen(db(sql))).length, 2)
  })

  it('ESCALATES severity and never de-escalates while open', async () => {
    await openIncident(db(sql), { ...BASE, severity: 'sev3' })
    await openIncident(db(sql), { ...BASE, severity: 'sev1' })
    await openIncident(db(sql), { ...BASE, severity: 'sev4' })
    // A page that quietly downgraded itself because a later, milder symptom arrived is a page
    // that stops being answered.
    assert.equal((await listOpen(db(sql)))[0]?.severity, 'sev1')
  })

  it('keeps the first cause and takes the newest error', async () => {
    await openIncident(db(sql), { ...BASE, cause: 'the first thing we noticed', lastError: 'a' })
    await openIncident(db(sql), { ...BASE, cause: 'something later', lastError: 'b' })
    const [incident] = await listOpen(db(sql))
    assert.equal(incident?.cause, 'the first thing we noticed')
    assert.equal(incident?.lastError, 'b')
  })

  it('opens a new incident after the previous one closed', async () => {
    await openIncident(db(sql), BASE)
    await closeIncident(db(sql), 'probe', BASE.subject)
    const reopened = await openIncident(db(sql), BASE)
    assert.equal(reopened.opened, true)
    assert.equal((await listRecent(db(sql), 30)).length, 2)
  })

  it('closes and resolves in one statement', async () => {
    await openIncident(db(sql), BASE)
    const closed = await closeIncident(db(sql), 'probe', BASE.subject)
    assert.ok(closed?.closedAt)
    assert.equal(closed?.state, 'resolved')
  })

  it('closing nothing is not an error', async () => {
    assert.equal(await closeIncident(db(sql), 'probe', 'nothing.here'), null)
  })

  it('refuses a closed incident that is not in a terminal state', async () => {
    // Without this a status page shows a resolved outage for a week.
    const { incident } = await openIncident(db(sql), BASE)
    await assert.rejects(async () => {
      await sql`update incidents set closed_at = now() where id = ${incident.id}`
    })
  })

  it('refuses an open incident that claims to be resolved', async () => {
    const { incident } = await openIncident(db(sql), BASE)
    await assert.rejects(async () => {
      await sql`update incidents set state = 'resolved' where id = ${incident.id}`
    })
  })

  it('advances through the lifecycle', async () => {
    const { incident } = await openIncident(db(sql), BASE)
    assert.equal((await advanceState(db(sql), incident.id, 'declared'))?.state, 'declared')
    assert.equal((await advanceState(db(sql), incident.id, 'mitigated'))?.state, 'mitigated')
  })

  it('marks a closed incident reviewed', async () => {
    const { incident } = await openIncident(db(sql), BASE)
    await closeIncident(db(sql), 'probe', BASE.subject)
    assert.equal((await markReviewed(db(sql), incident.id))?.state, 'reviewed')
  })

  it('will not review an incident that is still open', async () => {
    const { incident } = await openIncident(db(sql), BASE)
    assert.equal(await markReviewed(db(sql), incident.id), null)
  })

  it('will not advance a closed incident', async () => {
    const { incident } = await openIncident(db(sql), BASE)
    await closeIncident(db(sql), 'probe', BASE.subject)
    assert.equal(await advanceState(db(sql), incident.id, 'mitigated'), null)
  })

  it('records updates against one incident, public and internal alike', async () => {
    const { incident } = await openIncident(db(sql), BASE)
    await addUpdate(db(sql), incident.id, 'user:1', 'We are investigating.', true)
    await addUpdate(db(sql), incident.id, 'user:1', 'rolled back deploy 4c1f', false)
    assert.equal((await listUpdates(db(sql), incident.id, false)).length, 2)
    assert.equal((await listUpdates(db(sql), incident.id, true)).length, 1)
  })

  it('finds an incident by id', async () => {
    const { incident } = await openIncident(db(sql), BASE)
    assert.equal((await findIncident(db(sql), incident.id))?.subject, BASE.subject)
  })

  it('orders open incidents worst first', async () => {
    await openIncident(db(sql), { ...BASE, subject: 'a', severity: 'sev3' })
    await openIncident(db(sql), { ...BASE, subject: 'b', severity: 'sev1' })
    assert.equal((await listOpen(db(sql)))[0]?.subject, 'b')
  })

  it('refuses an unknown severity', async () => {
    await assert.rejects(async () => {
      await sql`
        insert into incidents (scope, subject, severity, product_group)
        values ('probe', 'x', 'critical', 'Wallet')
      `
    })
  })
})

describe('the severity a failure opens at', () => {
  it('opens a critical failure at sev2', () => {
    assert.equal(severityFor(true), 'sev2')
  })
  it('opens a non-critical failure at sev3', () => {
    assert.equal(severityFor(false), 'sev3')
  })
  it('never opens a sev1 automatically', () => {
    // SEV1 is "money at risk, or the platform unusable for most users" — a judgement a human
    // makes with the correctness signals in front of them, not something a failed HTTP GET can
    // assert on its own.
    assert.notEqual(severityFor(true), 'sev1')
    assert.notEqual(severityFor(false), 'sev1')
  })
})
