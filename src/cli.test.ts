/**
 * The CLI.
 *
 * The exit code is the product, so the exit code is what is asserted. `main` is driven against a
 * real HTTP server rather than a stub, because the case that matters most — Beacon unreachable —
 * only exists at the socket.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { main, parseArgs, render } from './cli.ts'
import type { GateDecision } from './gate.ts'

describe('argument parsing', () => {
  it('requires a release', () => {
    assert.equal(parseArgs([]), null)
  })

  it('parses --release', () => {
    assert.equal(parseArgs(['--release', 'v1'])?.release, 'v1')
  })

  it('parses --release=', () => {
    assert.equal(parseArgs(['--release=v1'])?.release, 'v1')
  })

  it('parses a url and a token', () => {
    const args = parseArgs(['--release', 'v1', '--url', 'http://beacon:4011', '--token', 't'])
    assert.equal(args?.url, 'http://beacon:4011')
    assert.equal(args?.token, 't')
  })

  it('does not record by default', () => {
    assert.equal(parseArgs(['--release', 'v1'])?.record, false)
  })

  it('records when asked', () => {
    assert.equal(parseArgs(['--release', 'v1', '--record'])?.record, true)
  })

  it('REFUSES AN UNKNOWN FLAG rather than ignoring it', () => {
    // `--force` in particular. A typo that is silently ignored is a gate somebody believes they
    // bypassed and did not, or believes they did not and did.
    assert.equal(parseArgs(['--release', 'v1', '--force']), null)
  })
})

describe('rendering a decision', () => {
  const base: GateDecision = {
    releaseTag: 'v1.4.2',
    decision: 'refuse',
    reasons: [
      {
        code: 'journey_failing',
        subject: 'identity.register',
        detail: 'the most recent run was a fail',
        determinacy: 'known',
      },
    ],
    waived: [],
    indeterminate: false,
  }

  it('leads with the verdict and the release', () => {
    assert.match(render(base), /^REFUSE {2}v1\.4\.2/)
  })

  it('says INDETERMINATE in the verdict line', () => {
    assert.match(render({ ...base, indeterminate: true }), /REFUSE — indeterminate/)
  })

  it('explains that an unknown is not a pass', () => {
    assert.match(render({ ...base, indeterminate: true }), /An unknown is not a pass/)
  })

  it('says an indeterminate result cannot be overridden', () => {
    assert.match(render({ ...base, indeterminate: true }), /cannot be overridden/)
  })

  it('marks a blocking reason', () => {
    assert.match(render(base), /\[blocks\] journey_failing/)
  })

  it('marks a waived reason', () => {
    const waived = { ...base, decision: 'promote_with_override' as const, waived: base.reasons }
    assert.match(render(waived), /\[waived\] journey_failing/)
  })

  it('marks an unknown reason', () => {
    const unknown: GateDecision = {
      ...base,
      indeterminate: true,
      reasons: [
        {
          code: 'journey_stale',
          subject: 'identity.register',
          detail: 'last run was 90000s ago',
          determinacy: 'unknown',
        },
      ],
    }
    assert.match(render(unknown), /\[unknown\] journey_stale/)
  })

  it('says a promotion under override IS one', () => {
    const waived = { ...base, decision: 'promote_with_override' as const, waived: base.reasons }
    assert.match(render(waived), /PROMOTE \(under override\)/)
  })

  it('prints a plain promote with no reasons', () => {
    assert.match(render({ ...base, decision: 'promote', reasons: [] }), /^PROMOTE {2}v1\.4\.2/)
  })
})

describe('exit codes over a real socket', () => {
  let server: Server
  let base: string
  let respond: (req: { method: string }) => { status: number; body: unknown }

  before(async () => {
    server = createServer((req, res) => {
      const answer = respond({ method: req.method ?? 'GET' })
      const payload = `${JSON.stringify(answer.body)}\n`
      res.writeHead(answer.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => {
      server.closeIdleConnections()
      server.close(() => resolve())
    })
  })

  const run = (extra: string[] = []): Promise<0 | 1 | 2> =>
    main(['gate', '--release', 'v1', '--url', base, '--token', 't', '--json', ...extra])

  it('EXITS 0 ON PROMOTE', async () => {
    respond = () => ({ status: 200, body: { decision: 'promote', reasons: [], waived: [] } })
    assert.equal(await run(), 0)
  })

  it('exits 0 on a promotion under override', async () => {
    respond = () => ({
      status: 200,
      body: { decision: 'promote_with_override', reasons: [], waived: [] },
    })
    assert.equal(await run(), 0)
  })

  it('EXITS 1 ON REFUSE', async () => {
    respond = () => ({ status: 200, body: { decision: 'refuse', reasons: [], waived: [] } })
    assert.equal(await run(), 1)
  })

  it('EXITS 2 WHEN BEACON CANNOT BE REACHED', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // Failing to ask is failing. A pipeline that ships when the gate is unreachable is a
    // pipeline with no gate, and the day it matters is the day the estate is unhealthy enough
    // that Beacon is down too.
    // ════════════════════════════════════════════════════════════════════════════════════════
    const code = await main([
      'gate',
      '--release',
      'v1',
      '--url',
      'http://127.0.0.1:1',
      '--token',
      't',
    ])
    assert.equal(code, 2)
  })

  it('exits 2 when Beacon answers a non-2xx', async () => {
    respond = () => ({ status: 503, body: { error: 'draining' } })
    assert.equal(await run(), 2)
  })

  it('exits 2 when Beacon answers without a decision', async () => {
    respond = () => ({ status: 200, body: { hello: true } })
    assert.equal(await run(), 2)
  })

  it('exits 2 on an unknown command', async () => {
    assert.equal(await main(['status']), 2)
  })

  it('exits 2 on a missing release', async () => {
    assert.equal(await main(['gate']), 2)
  })

  it('exits 2 with a url and no token at all', async () => {
    const previous = process.env['BEACON_TOKEN']
    delete process.env['BEACON_TOKEN']
    try {
      assert.equal(await main(['gate', '--release', 'v1', '--url', base]), 2)
    } finally {
      if (previous !== undefined) process.env['BEACON_TOKEN'] = previous
    }
  })

  it('uses GET by default so asking does not record', async () => {
    let method = ''
    respond = (req) => {
      method = req.method
      return { status: 200, body: { decision: 'promote', reasons: [], waived: [] } }
    }
    await run()
    assert.equal(method, 'GET')
  })

  it('uses POST with --record', async () => {
    let method = ''
    respond = (req) => {
      method = req.method
      return { status: 200, body: { decision: 'promote', reasons: [], waived: [] } }
    }
    await run(['--record'])
    assert.equal(method, 'POST')
  })
})
