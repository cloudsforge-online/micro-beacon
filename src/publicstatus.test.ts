/**
 * The redaction tests.
 *
 * FEA-42's acceptance criterion is "a redaction test asserting no internal target name appears in
 * the pre-auth response". These are that test, plus the one that matters more: that a field added
 * to the INTERNAL type tomorrow does not appear either. A test that only checks today's fields
 * passes for ever while the leak it was written to prevent walks straight past it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Incident, IncidentUpdate } from './incidents.ts'
import {
  PUBLIC_DAY_FIELDS,
  PUBLIC_GROUP_FIELDS,
  PUBLIC_INCIDENT_FIELDS,
  PUBLIC_MAINTENANCE_FIELDS,
  PUBLIC_STATUS_FIELDS,
  PUBLIC_UPDATE_FIELDS,
  projectIncident,
  projectStatus,
  publicStateOf,
  publicStateOfProbe,
  worst,
} from './publicstatus.ts'

const INTERNAL_ERROR = 'ECONNREFUSED 10.4.2.19:5432 while posting to the ledger'
const INTERNAL_SUBJECT = 'ledger.postings'

function internalIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    scope: 'probe',
    subject: INTERNAL_SUBJECT,
    severity: 'sev2',
    state: 'declared',
    productGroup: 'Wallet',
    openedAt: new Date('2026-07-31T09:00:00.000Z'),
    closedAt: null,
    cause: 'the primary replica stopped accepting writes',
    lastError: INTERNAL_ERROR,
    failures: 41,
    detectedBy: 'probe',
    ...overrides,
  }
}

function update(overrides: Partial<IncidentUpdate> = {}): IncidentUpdate {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    incidentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    at: new Date('2026-07-31T09:05:00.000Z'),
    author: 'user:9f2',
    body: 'We are investigating elevated errors on withdrawals.',
    isPublic: true,
    ...overrides,
  }
}

describe('an incident is projected by an allowlist, not by a filter', () => {
  it('emits exactly the allowlisted keys and no others', () => {
    const projected = projectIncident(internalIncident())
    assert.deepEqual(Object.keys(projected).sort(), [...PUBLIC_INCIDENT_FIELDS].sort())
  })

  it('omits the internal subject', () => {
    const projected = projectIncident(internalIncident())
    assert.equal(JSON.stringify(projected).includes(INTERNAL_SUBJECT), false)
  })

  it('omits the upstream error string', () => {
    const projected = projectIncident(internalIncident())
    assert.equal(JSON.stringify(projected).includes(INTERNAL_ERROR), false)
  })

  it('omits the cause, the failure count, the scope and the detection source', () => {
    const serialised = JSON.stringify(projectIncident(internalIncident()))
    for (const leak of ['the primary replica', '41', 'probe', 'cause', 'failures', 'detectedBy']) {
      assert.equal(serialised.includes(leak), false, `"${leak}" reached the public projection`)
    }
  })

  it('publishes the product group instead of the subject', () => {
    assert.equal(projectIncident(internalIncident()).group, 'Wallet')
  })

  it('does not leak an internal field added to the source type after this test was written', () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // THE TEST THIS FILE EXISTS FOR.
    //
    // A field is attached to the internal object that no version of `Incident` has ever declared
    // — which is exactly what a future `Incident` field looks like to today's projection code. It
    // must not appear, and it must not appear because nothing reads the source generically, not
    // because a denylist happened to name it.
    // ════════════════════════════════════════════════════════════════════════════════════════
    const smuggled = {
      ...internalIncident(),
      internalRunbookUrl: 'https://runbooks.internal/ledger-primary-failover',
      pagedEngineer: 'user:9f2',
      replicaCount: 3,
    } as unknown as Incident

    const projected = projectIncident(smuggled)
    const serialised = JSON.stringify(projected)
    assert.deepEqual(Object.keys(projected).sort(), [...PUBLIC_INCIDENT_FIELDS].sort())
    assert.equal(serialised.includes('runbooks.internal'), false)
    assert.equal(serialised.includes('pagedEngineer'), false)
    assert.equal(serialised.includes('replicaCount'), false)
  })

  it('publishes public updates', () => {
    const projected = projectIncident(internalIncident(), [update()])
    assert.equal(projected.updates.length, 1)
    assert.equal(projected.updates[0]?.body, 'We are investigating elevated errors on withdrawals.')
  })

  it('never publishes an internal update', () => {
    const projected = projectIncident(internalIncident(), [
      update({ isPublic: false, body: 'rolled back deploy 4c1f, still seeing 502s from the pool' }),
    ])
    assert.equal(projected.updates.length, 0)
    assert.equal(JSON.stringify(projected).includes('4c1f'), false)
  })

  it('never publishes an update author', () => {
    const projected = projectIncident(internalIncident(), [update()])
    assert.deepEqual(Object.keys(projected.updates[0] ?? {}).sort(), [...PUBLIC_UPDATE_FIELDS].sort())
    assert.equal(JSON.stringify(projected).includes('user:9f2'), false)
  })
})

describe('the public lifecycle is its own vocabulary', () => {
  it('maps detected to investigating', () => {
    assert.equal(publicStateOf('detected'), 'investigating')
  })
  it('maps declared to identified', () => {
    assert.equal(publicStateOf('declared'), 'identified')
  })
  it('maps mitigated to monitoring', () => {
    assert.equal(publicStateOf('mitigated'), 'monitoring')
  })
  it('maps resolved to resolved', () => {
    assert.equal(publicStateOf('resolved'), 'resolved')
  })
  it('maps reviewed to resolved, because a review is an internal milestone', () => {
    assert.equal(publicStateOf('reviewed'), 'resolved')
  })
  it('never emits an internal state name', () => {
    for (const state of ['detected', 'declared', 'mitigated', 'reviewed'] as const) {
      assert.notEqual(publicStateOf(state), state)
    }
  })
})

describe('probe states become customer-facing words', () => {
  it('maps up to operational', () => {
    assert.equal(publicStateOfProbe('up'), 'operational')
  })
  it('maps degraded to degraded', () => {
    assert.equal(publicStateOfProbe('degraded'), 'degraded')
  })
  it('maps down to outage', () => {
    assert.equal(publicStateOfProbe('down'), 'outage')
  })
  it('maps a never-run probe to operational rather than to an outage', () => {
    assert.equal(publicStateOfProbe('pending'), 'operational')
  })
})

describe('a group is as healthy as its unhealthiest part', () => {
  it('is operational when everything is', () => {
    assert.equal(worst(['operational', 'operational']), 'operational')
  })
  it('is degraded when one part is', () => {
    assert.equal(worst(['operational', 'degraded']), 'degraded')
  })
  it('is an outage when one part is down, whatever else is true', () => {
    assert.equal(worst(['operational', 'degraded', 'outage', 'maintenance']), 'outage')
  })
  it('is operational for an empty set', () => {
    assert.equal(worst([]), 'operational')
  })
})

describe('the whole public document', () => {
  const generatedAt = new Date('2026-07-31T10:00:00.000Z')

  const document = projectStatus({
    generatedAt,
    probes: [
      { productGroup: 'Wallet', state: 'down' },
      { productGroup: 'Wallet', state: 'up' },
      { productGroup: 'Account', state: 'up' },
    ],
    uptime: [
      { productGroup: 'Wallet', day: '2026-07-30', state: 'operational' },
      { productGroup: 'Wallet', day: '2026-07-31', state: 'outage' },
    ],
    incidents: [{ incident: internalIncident(), updates: [update()] }],
    maintenance: [
      {
        productGroup: 'Account',
        summary: 'Scheduled database upgrade',
        startsAt: new Date('2026-07-31T09:30:00.000Z'),
        endsAt: new Date('2026-07-31T11:30:00.000Z'),
      },
    ],
  })

  it('emits exactly the allowlisted top-level keys', () => {
    assert.deepEqual(Object.keys(document).sort(), [...PUBLIC_STATUS_FIELDS].sort())
  })

  it('emits exactly the allowlisted group keys', () => {
    for (const group of document.groups) {
      assert.deepEqual(Object.keys(group).sort(), [...PUBLIC_GROUP_FIELDS].sort())
    }
  })

  it('emits exactly the allowlisted day keys', () => {
    for (const day of document.groups.flatMap((group) => group.uptime)) {
      assert.deepEqual(Object.keys(day).sort(), [...PUBLIC_DAY_FIELDS].sort())
    }
  })

  it('emits exactly the allowlisted maintenance keys', () => {
    for (const window of document.maintenance) {
      assert.deepEqual(Object.keys(window).sort(), [...PUBLIC_MAINTENANCE_FIELDS].sort())
    }
  })

  it('names product groups and never a probe or a service', () => {
    assert.deepEqual(
      document.groups.map((group) => group.group),
      ['Account', 'Wallet'],
    )
  })

  it('rolls a group up to its worst member', () => {
    assert.equal(document.groups.find((group) => group.group === 'Wallet')?.state, 'outage')
  })

  it('shows an announced window as maintenance rather than as an outage', () => {
    assert.equal(document.groups.find((group) => group.group === 'Account')?.state, 'maintenance')
  })

  it('takes the hero chip from the worst group', () => {
    assert.equal(document.state, 'outage')
  })

  it('carries no internal identifier anywhere in the serialised document', () => {
    const serialised = JSON.stringify(document)
    for (const leak of [INTERNAL_SUBJECT, INTERNAL_ERROR, 'user:9f2', 'ledger', 'probe', 'latency']) {
      assert.equal(serialised.includes(leak), false, `"${leak}" reached the public document`)
    }
  })

  it('carries no numeric latency or error rate', () => {
    // Named separately from the string check because a number that leaked would not be caught by
    // searching for a word. The public document's only numbers are timestamps inside ISO strings.
    const serialised = JSON.stringify(document)
    assert.equal(/"(latencyMs|errorRate|p95|p99|uptimePercent)"/.test(serialised), false)
  })

  it('is stable under a probe whose state has never been read', () => {
    const empty = projectStatus({
      generatedAt,
      probes: [{ productGroup: 'Market', state: 'pending' }],
      uptime: [],
      incidents: [],
      maintenance: [],
    })
    assert.equal(empty.state, 'operational')
    assert.equal(empty.groups[0]?.uptime.length, 0)
  })
})
