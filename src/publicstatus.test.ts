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
  cleanPpm,
  dayState,
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

describe('a projection with nothing behind it makes no claim', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **WHAT THE LIVE ESTATE WAS ACTUALLY PUBLISHING ON 2026-08-04.**
   *
   *     GET https://status.cloudsforge.online/api/status/public
   *     {"generatedAt":"2026-08-04T21:45:14.548Z","state":"operational","groups":[], …}
   *
   * Zero probes were registered in that deployment (`GET /v1/probes` → `{"probes":[]}`), so
   * `byGroup` was empty, so `groups` was empty — and `worst([])` folded from its identity and
   * returned `operational`. The most public document in the estate asserted that everything was
   * fine on the strength of nothing at all.
   *
   * The reading side caught it: `status-web` recomputes the verdict from the groups it holds and
   * refuses to say `operational` from an empty set (`status-web/src/lib/publicstatus.ts`, `worst`
   * — "Empty is `unknown`: nothing measured is not everything healthy"). But that is a second
   * process, deployed on its own schedule, and the fix belongs where the claim is made: this
   * service's own package description says "an unknown is never a pass", and a projection that
   * measured nothing is the purest unknown there is.
   *
   * `worst([])` is left alone — it is a fold and `operational` is its identity, which is right for
   * a GROUP, where the set can never be empty because a group exists only if a probe put it
   * there. The empty case only ever arises at the top level, and it is handled there.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  const nothingMeasured = projectStatus({
    generatedAt: new Date('2026-08-04T21:45:14.548Z'),
    probes: [],
    uptime: [],
    incidents: [],
    maintenance: [],
  })

  it('does not report the estate operational when it holds no groups', () => {
    assert.equal(nothingMeasured.groups.length, 0)
    assert.notEqual(
      nothingMeasured.state,
      'operational',
      'nothing was measured, so "everything is fine" is a claim about an absence we cannot see',
    )
  })

  it('says so as null rather than by inventing a fifth word', () => {
    // Null, not `'unknown'`. `PublicState` is a closed four-word vocabulary and `status-web`'s
    // reader depends on that being true: its comment on `CellState` says `unknown` "is
    // deliberately not in PublicState — Beacon cannot send it", which is what keeps an unknown
    // from being sorted or compared as though it were a verdict. An absent claim is the honest
    // shape, and `readMember` already turns it into the page's own `unknown` and counts it.
    assert.equal(nothingMeasured.state, null)
  })

  it('still emits exactly the allowlisted keys, with state present and empty', () => {
    // The field is not dropped. A missing key and a null one read the same to `status-web`, but a
    // document whose SHAPE changes with its content is one every consumer has to special-case.
    assert.deepEqual(Object.keys(nothingMeasured).sort(), [...PUBLIC_STATUS_FIELDS].sort())
    assert.ok('state' in nothingMeasured)
  })

  it('still carries the observation time, which is what makes the refusal readable', () => {
    // `status-web` refuses a document with no readable `generatedAt` outright and shows nothing at
    // all. "We measured nothing at 21:45" is a far more useful answer than silence.
    assert.equal(nothingMeasured.generatedAt, '2026-08-04T21:45:14.548Z')
  })

  it('makes a claim again as soon as there is one probe to make it from', () => {
    const oneProbe = projectStatus({
      generatedAt: new Date('2026-08-04T21:45:14.548Z'),
      probes: [{ productGroup: 'Wallet', state: 'up' }],
      uptime: [],
      incidents: [],
      maintenance: [],
    })
    assert.equal(oneProbe.state, 'operational')
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
      { productGroup: 'Wallet', day: '2026-07-30', checks: 2880, degraded: 0, down: 0 },
      { productGroup: 'Wallet', day: '2026-07-31', checks: 2880, degraded: 0, down: 2400 },
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
    // searching for a word. The document's ONLY published number is `cleanPpm`, a share of the
    // checks in one product group on one day — see the note on `PublicDay.cleanPpm` for why that
    // is not the per-service error rate 13-operational-model.md withholds, and why the
    // denominator it was computed from is not published beside it.
    const serialised = JSON.stringify(document)
    assert.equal(/"(latencyMs|errorRate|p95|p99|uptimePercent)"/.test(serialised), false)
    assert.equal(/"(checks|total|up|down|degraded|probes)":/.test(serialised), false)
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

/* ─────────────────────────────── the daily bars ─────────────────────────────── */

describe('a day is a ratio, not a boolean', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * THE DOCUMENT THIS SERVICE PUBLISHED FOR FOUR DAYS, AND THE REASON IT IS THE WORST DEFECT ON
   * THE ESTATE'S ONLY PUBLIC TRUST ARTEFACT.
   *
   * `dailyUptime` folded a boolean OR over every check in a day: one failure anywhere in a group
   * at any hour painted the whole day `outage`. On 2026-08-07 `status.cloudsforge.online`
   * reported all twenty product groups out for four consecutive days while the estate was
   * answering 30/30 HTTPS 200s, and `status-web` rendered "0.0% of 4 measured days came back
   * clean" beneath a green `Operational` chip — the chip from the live probe states, the bars
   * from this fold, the two contradicting each other on the same screen.
   *
   * The first case below is that exact shape. It fails against the old fold and is the whole
   * point of this file's existence, so it is written as the measurement rather than as a unit:
   * 2,879 clean checks and one bad one is not an outage, and no reading of the word makes it one.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  it('does not call a day an outage because one check out of 2,880 failed', () => {
    assert.equal(dayState({ checks: 2880, degraded: 0, down: 1 }), 'degraded')
    // And it says how nearly clean it was, rather than leaving the colour to carry the whole
    // claim: 2,879/2,880 is 999,652 parts per million.
    assert.equal(cleanPpm({ checks: 2880, degraded: 0, down: 1 }), 999_652)
  })

  it('still calls a majority-down day an outage', () => {
    // The replacement is not a softening. More down than up is the comparison, and it needs no
    // threshold anybody had to choose — which is rule 1 of 32-roadmap-ui-and-content.md applied
    // to a constant that decides a colour rather than to one that is printed.
    assert.equal(dayState({ checks: 2880, degraded: 0, down: 2400 }), 'outage')
    assert.equal(dayState({ checks: 100, degraded: 0, down: 51 }), 'outage')
    assert.equal(dayState({ checks: 100, degraded: 0, down: 50 }), 'degraded')
  })

  it('degrades on a degraded check even when nothing was ever down', () => {
    assert.equal(dayState({ checks: 2880, degraded: 3, down: 0 }), 'degraded')
  })

  it('reserves operational for a day in which nothing failed at all', () => {
    assert.equal(dayState({ checks: 2880, degraded: 0, down: 0 }), 'operational')
    assert.equal(cleanPpm({ checks: 2880, degraded: 0, down: 0 }), 1_000_000)
  })

  it('counts a degraded check as not clean, so the ratio and the colour agree', () => {
    // A degraded check is a check that did not come back clean. If `cleanPpm` counted it as clean
    // the page could show a `degraded` bar reading 100%, which reads as a rendering bug and
    // teaches the reader to disbelieve the number.
    assert.equal(cleanPpm({ checks: 1000, degraded: 10, down: 0 }), 990_000)
  })

  it('rounds DOWN, so the page never claims a day was cleaner than it was', () => {
    // 999/1000 is 999,000 exactly; 2/3 is 666,666.67 and must not become 666,667.
    assert.equal(cleanPpm({ checks: 3, degraded: 0, down: 1 }), 666_666)
  })

  it('gives a day nobody measured no bar at all, rather than a green one', () => {
    /*
     * The other half of what made that page wrong. `status-web` reported "86 days we never
     * measured" alongside the four it had, and the honest shape for an unmeasured day is
     * ABSENCE — rule 2 of the roadmap, render a named hole rather than a plausible screen over
     * nothing. A zero-check row must not be given a colour, because every colour available is a
     * claim about an observation that was never made.
     */
    const document = projectStatus({
      generatedAt: new Date('2026-07-31T10:00:00.000Z'),
      probes: [{ productGroup: 'Wallet', state: 'up' }],
      uptime: [
        { productGroup: 'Wallet', day: '2026-07-29', checks: 0, degraded: 0, down: 0 },
        { productGroup: 'Wallet', day: '2026-07-30', checks: 2880, degraded: 0, down: 0 },
      ],
      incidents: [],
      maintenance: [],
    })
    assert.deepEqual(
      document.groups[0]?.uptime.map((day) => day.date),
      ['2026-07-30'],
      'a day with no checks in it was given a bar, and therefore a verdict',
    )
  })

  it('publishes the ratio on every bar, so a reader is never left with only a colour', () => {
    const document = projectStatus({
      generatedAt: new Date('2026-07-31T10:00:00.000Z'),
      probes: [{ productGroup: 'Wallet', state: 'up' }],
      uptime: [{ productGroup: 'Wallet', day: '2026-07-30', checks: 2880, degraded: 0, down: 1 }],
      incidents: [],
      maintenance: [],
    })
    const day = document.groups[0]?.uptime[0]
    assert.equal(day?.state, 'degraded')
    assert.equal(day?.cleanPpm, 999_652)
  })

  it('publishes the share and never the denominator it was computed from', () => {
    // The count of checks in a group in a day is (probes in the group) × (cadence), which is
    // internal topology by arithmetic. `PUBLIC_DAY_FIELDS` is what enforces this and `seal` is
    // the runtime backstop; this asserts the consequence on the wire.
    const document = projectStatus({
      generatedAt: new Date('2026-07-31T10:00:00.000Z'),
      probes: [{ productGroup: 'Wallet', state: 'up' }],
      uptime: [{ productGroup: 'Wallet', day: '2026-07-30', checks: 2880, degraded: 4, down: 1 }],
      incidents: [],
      maintenance: [],
    })
    const serialised = JSON.stringify(document)
    assert.equal(serialised.includes('2880'), false, 'the check count reached the public document')
    assert.deepEqual(Object.keys(document.groups[0]?.uptime[0] ?? {}).sort(), [
      ...PUBLIC_DAY_FIELDS,
    ].sort())
  })
})
