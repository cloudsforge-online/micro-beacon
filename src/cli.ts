#!/usr/bin/env node
/**
 * `beacon gate` — the release gate as an exit code.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE EXIT CODE IS THE PRODUCT. EVERYTHING PRINTED IS COMMENTARY.**
 *
 *   0  promote, or promote_with_override
 *   1  refuse — Beacon answered, and the answer was no
 *   2  **could not ask** — Beacon was unreachable, the arguments were wrong, or the answer could
 *      not be parsed
 *
 * Two non-zero codes rather than one, and both block. A pipeline needs to distinguish "the estate
 * is not fit to ship" from "the gate is broken" because the two have different fixes and different
 * people — but neither of them is a release. `2` exists so that "the gate is broken" is *visible*,
 * not so that it can be ignored: a `|| true` on this command is the whole control being deleted,
 * and a distinct code means nobody has to reach for one.
 *
 * There is no `--force` and there will not be one. The break-glass is
 * `POST /v1/gate/overrides`: attributed, expiring, naming the exact reason code it waives, and
 * refused outright for anything indeterminate. A flag on this command would be an unattributed,
 * unexpiring, unrecorded override held in whoever's shell history.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two modes, and the HTTP one is the one CI uses:
 *
 *     beacon gate --release v1.4.2 --url http://beacon:4011 --token "$BEACON_TOKEN"
 *     beacon gate --release v1.4.2            # direct, reads BEACON_DATABASE_URL
 *
 * `src/env.ts` is imported **lazily**, and only by the direct mode. Importing it eagerly would
 * make this command require a database connection string in order to make an HTTP request, which
 * is exactly the shape of dependency that ends with CI holding production credentials.
 */

import process, { argv, exit, stderr, stdout } from 'node:process'
import type { Sql } from '@cloudsforge/db'
import type { GateDecision } from './gate.ts'

const USAGE = `beacon <command>

  gate      ask the release gate, as an exit code
  slo-seed  register the owner's journey objectives through the API
  browser   drive the declared tier-3 browser journeys against a running estate
  smoke     drive EVERY surface of a running estate in a real browser, stubbing nothing

beacon slo-seed --url <base> [--bearer <jwt> | --token <token>] [--dry-run]

  Registers one SLO per scheduled journey from the table in src/sloseed.ts, which is the
  owner's decision transcribed. Idempotent — PUT /v1/slos/:name is an upsert — so it is
  meant to run on every deploy. Refuses outright if any journey has no objective, rather
  than seeding the ones it recognises.

  --bearer    an identity access token for an admin. REQUIRED in practice: PUT /v1/slos/:name
              is adminOnly, and the static token is no longer accepted as an administrator,
              so seeding with --token alone now gets a 403.
  --token     the x-beacon-token credential. Defaults to BEACON_TOKEN. Not sufficient here.
  --dry-run   print the plan and dial nothing. Needs no estate and no credential.

exit codes: 0 every objective registered · 1 one or more refused · 2 bad arguments, or a
journey with no objective

beacon gate --release <tag> [--url <base>] [--token <token>] [--json] [--record]

  --release   the release candidate being considered. Required.
  --url       Beacon's base URL. Omit to evaluate directly against the database.
  --token     the x-beacon-token credential. Required with --url unless BEACON_TOKEN is set.
  --record    write the decision to gate_decisions. Off by default: asking must not change
              what the gate would answer next time.
  --json      print the decision as JSON rather than as prose.

exit codes: 0 promote · 1 refuse · 2 could not ask

beacon browser [--targets <name=url,...>] [--browser <path>] [--estate-ca <file>] [--timeout <ms>]

  --targets     the estate's addresses. Defaults to BEACON_TARGETS.
  --browser     a Chromium executable. Defaults to BEACON_BROWSER_EXECUTABLE, then to the one
                playwright-core would use.
  --estate-ca   a PEM root to trust, IN ADDITION to the system store, for beacon's own requests.
                Defaults to BEACON_ESTATE_CA. Needed for a dev estate whose gateway terminates on
                a private CA; every other host is still fully validated. Chromium's half needs no
                flag: the certificate each target serves is inspected first and its public key
                pinned, and only a private root earns a pin.
  --timeout     per-operation timeout in ms. Default 30000.

  BEACON_ESTATE_OPERATOR / _PASSWORD name an account that can mint a service token. The money
  journeys need one to seed a balance before they assert one; without it they skip, naming it.

  --insecure-tls is GONE. It set NODE_TLS_REJECT_UNAUTHORIZED=0 and ignoreHTTPSErrors together
  — every host, every error, for the whole run — in the command whose job is to notice.

exit codes: 0 every declared journey passed · 1 one failed, errored or SKIPPED · 2 nothing
was declared, or the arguments were wrong

beacon smoke [--apex <host>] [--env <label>] [--browser <path>] [--timeout <ms>] [--surface <key>]

  Signs in for real and loads all sixteen surfaces through the gateway. Nothing is stubbed,
  intercepted or fulfilled from a fixture; the gateway's own certificate is accepted by pinning
  its public key, and no other certificate error is excused anywhere.

  --apex      the estate's apex. Defaults to BEACON_SMOKE_APEX, then cloudsforge.localtest.me.
  --env       the environment, as a SUFFIX ON EACH SUBDOMAIN: --env testnet drives
              hub-testnet.<apex>, and the apex surface at testnet.<apex>. Defaults to
              BEACON_SMOKE_ENV, then empty. It is not an apex prefix: both environments are
              served on one zone, because a wildcard certificate matches only one label.
  --browser   a Chromium executable. Defaults to BEACON_BROWSER_EXECUTABLE.
  --timeout   per-operation timeout in ms. Default 20000.
  --surface   run one surface only, repeatable. Defaults to all sixteen.

  Credentials come from BEACON_SMOKE_IDENTIFIER / _PASSWORD / _HANDLE.

exit codes: 0 every surface is healthy · 1 something a person would see is broken · 2 the
estate could not be reached, there is no browser, or the arguments were wrong
`

interface Args {
  readonly release: string
  readonly url: string | null
  readonly token: string | null
  readonly json: boolean
  readonly record: boolean
}

export function parseArgs(args: readonly string[]): Args | null {
  let release = ''
  let url: string | null = null
  let token: string | null = null
  let json = false
  let record = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') json = true
    else if (arg === '--record') record = true
    else if (arg === '--release') release = args[++i] ?? ''
    else if (arg === '--url') url = args[++i] ?? null
    else if (arg === '--token') token = args[++i] ?? null
    else if (arg?.startsWith('--release=')) release = arg.slice('--release='.length)
    else if (arg?.startsWith('--url=')) url = arg.slice('--url='.length)
    else if (arg?.startsWith('--token=')) token = arg.slice('--token='.length)
    else return null
  }

  if (!release) return null
  return { release, url, token, json, record }
}

/** Render a decision for a human. The exit code is what a machine reads. */
export function render(decision: GateDecision): string {
  const lines: string[] = []
  const verdict =
    decision.decision === 'refuse'
      ? decision.indeterminate
        ? 'REFUSE — indeterminate'
        : 'REFUSE'
      : decision.decision === 'promote_with_override'
        ? 'PROMOTE (under override)'
        : 'PROMOTE'
  lines.push(`${verdict}  ${decision.releaseTag}`)

  if (decision.indeterminate) {
    lines.push('')
    // Said in full, because this is the case people misread. "No data" reads as "nothing wrong"
    // to almost everyone, and the whole design turns on it not being read that way.
    lines.push('  The gate could not determine the estate\'s health. An unknown is not a pass,')
    lines.push('  and an indeterminate result cannot be overridden — find out what is true first.')
  }

  const waived = new Set(decision.waived.map((reason) => `${reason.code}\u0000${reason.subject}`))
  if (decision.reasons.length > 0) {
    lines.push('')
    for (const reason of decision.reasons) {
      const mark = waived.has(`${reason.code}\u0000${reason.subject}`)
        ? 'waived'
        : reason.determinacy === 'unknown'
          ? 'unknown'
          : 'blocks'
      lines.push(`  [${mark}] ${reason.code}  ${reason.subject}`)
      lines.push(`           ${reason.detail}`)
    }
  }
  return `${lines.join('\n')}\n`
}

async function viaHttp(args: Args): Promise<GateDecision> {
  const token = args.token ?? process.env['BEACON_TOKEN'] ?? ''
  if (!token) throw new Error('--token or BEACON_TOKEN is required with --url')
  const url = new URL('/v1/gate', args.url ?? '')
  url.searchParams.set('release', args.release)

  const response = await fetch(url, {
    method: args.record ? 'POST' : 'GET',
    headers: { 'x-beacon-token': token, accept: 'application/json' },
    // Absolute, and short. A gate call that hangs is a pipeline that hangs, and a pipeline that
    // hangs gets cancelled by a human who then ships anyway.
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`beacon answered ${response.status} — the gate could not be asked`)
  }
  const body = (await response.json()) as {
    release?: string
    decision?: string
    indeterminate?: boolean
    reasons?: GateDecision['reasons']
    waived?: GateDecision['waived']
  }
  if (typeof body.decision !== 'string') throw new Error('beacon returned no decision')
  return {
    releaseTag: body.release ?? args.release,
    decision: body.decision as GateDecision['decision'],
    reasons: body.reasons ?? [],
    waived: body.waived ?? [],
    indeterminate: body.indeterminate === true,
  }
}

async function viaDatabase(args: Args): Promise<GateDecision> {
  // Lazy, so the HTTP path never needs a connection string. See the file header.
  const [{ default: postgres }, { env }, { evaluate }] = await Promise.all([
    import('postgres'),
    import('./env.ts'),
    import('./gate.ts'),
  ])
  const sql = postgres(env.databaseUrl, { max: 2, onnotice: () => {} })
  try {
    return await evaluate(sql as unknown as Sql, args.release, {
      record: args.record,
      evaluatedBy: 'cli',
      freshnessMs: env.gateFreshnessMs,
      consecutiveGreen: env.gateConsecutiveGreen,
    })
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}


/* ------------------------------------------------------------------ beacon browser */

interface BrowserArgs {
  readonly targets: string
  readonly executablePath: string
  /**
   * A PEM root to trust IN ADDITION to the system store, for beacon's own `fetch`.
   *
   * Replaces `insecureTls`, and the difference is the whole point: this names one certificate
   * authority, in a file a reviewer can read, and leaves every other host validated.
   */
  readonly estateCa: string
  readonly timeoutMs: number
}

/**
 * `--insecure-tls` is REFUSED BY NAME rather than falling through to "unknown argument".
 *
 * A bare parse error would print the usage and leave somebody guessing whether the flag was
 * mistyped or removed, and the likeliest next move is to reach for NODE_TLS_REJECT_UNAUTHORIZED
 * in the shell instead — which is the same defect, one level further from review.
 */
export const INSECURE_TLS_REMOVED =
  '--insecure-tls has been removed. It switched off certificate validation for every host and\n' +
  'every error at once, in the command whose purpose is to notice one. Chromium now pins the\n' +
  "public key of whatever each target actually serves — and only a PRIVATE root earns a pin, so\n" +
  'an expired certificate, one issued for another hostname, or a substituted one still fails.\n' +
  "For beacon's own requests, name the root: --estate-ca <file> (or BEACON_ESTATE_CA).\n"

export function parseBrowserArgs(
  args: readonly string[],
  source: Record<string, string | undefined>,
): BrowserArgs | null {
  let targets = source['BEACON_TARGETS'] ?? ''
  let executablePath = source['BEACON_BROWSER_EXECUTABLE'] ?? ''
  let estateCa = source['BEACON_ESTATE_CA'] ?? ''
  let timeoutMs = 30_000

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--targets') targets = args[++i] ?? ''
    else if (arg === '--browser') executablePath = args[++i] ?? ''
    else if (arg === '--estate-ca') estateCa = args[++i] ?? ''
    else if (arg === '--timeout') timeoutMs = Number(args[++i] ?? '')
    else if (arg?.startsWith('--targets=')) targets = arg.slice('--targets='.length)
    else if (arg?.startsWith('--browser=')) executablePath = arg.slice('--browser='.length)
    else if (arg?.startsWith('--estate-ca=')) estateCa = arg.slice('--estate-ca='.length)
    else if (arg?.startsWith('--timeout=')) timeoutMs = Number(arg.slice('--timeout='.length))
    else return null
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) return null
  return { targets, executablePath, estateCa, timeoutMs }
}

/**
 * `beacon browser` - the tier-3 browser journeys, against a running estate, without a database.
 *
 * ==============================================================================================
 * **A SKIP IS NOT A PASS HERE EITHER, AND THAT IS WHY THIS EXITS 1 ON ONE.**
 *
 * `journeys.ts` rule 2 - "not-run is not passed" - is the whole reason this command is worth
 * having: the failure mode of a browser suite is not a red test, it is a suite that quietly
 * skipped because there was no Chromium and reported nothing. So a skip is an exit 1, alongside a
 * fail, and the reason is printed. Somebody who genuinely does not want the browser tier does not
 * run this command; they do not get a green from it.
 *
 * **AND DECLARING NOTHING IS EXIT 2, NOT EXIT 0.** "Zero journeys, zero failures" is arithmetically
 * green and means the estate was never looked at. `undeclared()` is printed with it, because
 * "0 browser journeys" reads as an oversight while "BJ-XS-10: no address for site, hub, ..." reads
 * as the one configuration change that turns it on.
 * ==============================================================================================
 *
 * Nothing is written anywhere. This is the command a developer and a deploy script run; recording
 * runs into `journey_runs` is the SERVICE's job, on a lease, and a CLI that wrote there would put
 * a manual run into a series the gate reads - which `latestRuns` excludes for exactly that reason.
 */
export async function runBrowser(args: BrowserArgs): Promise<0 | 1 | 2> {
  // Imported HERE rather than at the top of the file, for the reason the module docstring gives
  // about `env.ts`: this command must not require a database credential to make an HTTP request.
  const { parseTargets, TargetsError } = await import('./targets.ts')
  const { browserJourneys, undeclared } = await import('./browser/journeys.ts')
  const { runJourney } = await import('./journeys.ts')
  const { collectPins, trustEstateCa } = await import('./browser/estatecert.ts')

  let targets: ReadonlyMap<string, string>
  try {
    targets = parseTargets(args.targets)
  } catch (err) {
    stderr.write(
      `${err instanceof TargetsError ? err.message : String(err)}\n` +
        'Set BEACON_TARGETS, or pass --targets name=url,name=url\n',
    )
    return 2
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // TWO KINDS OF REQUEST, ONE POLICY, AND NEITHER OF THEM STOPS CHECKING.
  //
  // A browser journey makes the browser's requests AND beacon's own — BJ-XS-10 fetches every
  // address the switcher offers, BJ-ACC-02 seeds an account over HTTP — and this command used to
  // reconcile the two by turning validation off on both sides at once:
  // `NODE_TLS_REJECT_UNAUTHORIZED = '0'` plus `ignoreHTTPSErrors: true`. Every host, every error,
  // for the whole run, in the command whose entire job is to notice one. `smoke` had already been
  // given the narrow answer and this, the OLDER runner, never got it.
  //
  //   * Chromium: `collectPins` inspects the certificate each target really serves and pins the
  //     public key — and ONLY where the failure is an unreachable root. An expired certificate, a
  //     certificate for another hostname, a bad signature: refused a pin, still fail, still red.
  //     `ignoreHttpsErrors` is not passed at all, so `driver.ts` defaults it to false.
  //   * beacon's own `fetch`: one named root, from a file, added to the system store. See
  //     `trustEstateCa` for why the certificate on the wire cannot supply it (the gateway sends a
  //     chain of depth one, so there is no issuer to trust).
  //
  // Every reason is PRINTED. A pin nobody can see is a pin nobody reviews.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // ── ORDER MATTERS, AND GETTING IT WRONG MADE EVERY PAGE FAIL ────────────────────────────────
  //
  // The inspection runs FIRST, before the root is trusted, and that is not tidiness. `pinPolicy`
  // asks OpenSSL's verdict — `socket.authorized` — and refuses a pin for anything already trusted,
  // correctly: "nothing needs excusing". Trusting the estate CA first therefore makes every
  // inspection report `trusted: true`, produces an EMPTY pin list, and hands Chromium nothing —
  // and Chromium has its own trust store that `tls.setDefaultCACertificates` never touched. Run
  // that way, every target failed `net::ERR_CERT_AUTHORITY_INVALID` while the log cheerfully said
  // the certificates verified. Measured here, on this estate, before this comment was written.
  //
  // Two mechanisms, two trust stores, one decision — so the decision has to be taken while both
  // are still in their original state.
  //
  // The HTTPS targets, grouped by port. `http:` targets are skipped rather than inspected: a TLS
  // handshake against a plaintext port does not fail fast, it waits out the timeout, and five
  // seconds per target of "no certificate to inspect" is noise in front of the reasons that
  // matter. Grouped by port because `collectPins` inspects one port per call, and a target on a
  // non-443 port is a different endpoint that must be looked at on its own terms.
  const byPort = new Map<number, Set<string>>()
  for (const url of targets.values()) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') continue
    const port = parsed.port === '' ? 443 : Number(parsed.port)
    const set = byPort.get(port) ?? new Set<string>()
    set.add(parsed.hostname)
    byPort.set(port, set)
  }
  // Per host rather than once, for `collectPins`'s own reason: a host quietly serving a DIFFERENT
  // certificate must not be excused by a pin taken from its neighbour.
  const spki = new Set<string>()
  for (const [port, hosts] of [...byPort].sort((a, b) => a[0] - b[0])) {
    const pins = await collectPins([...hosts].sort(), { port })
    for (const reason of pins.reasons) stdout.write(`tls  ${reason}\n`)
    for (const key of pins.spki) spki.add(key)
  }

  // Now, and only now, the root beacon's own `fetch` needs. See the ordering note above.
  const trust = trustEstateCa(args.estateCa ? [args.estateCa] : [])
  if (!trust.ok) {
    stderr.write(`${trust.why}\n`)
    return 2
  }
  stdout.write(`tls  ${trust.why}\n\n`)

  const config = {
    enabled: true,
    executablePath: args.executablePath,
    timeoutMs: args.timeoutMs,
    certificatePins: [...spki].sort(),
  }
  // ── THE OPERATOR CREDENTIAL, AND WHY ITS ABSENCE IS A SKIP RATHER THAN A DEFAULT ────────────
  //
  // The money journeys seed a balance before they assert one, and identity refuses
  // `POST /service-tokens` to an ordinary account (403). So they need the estate operator's
  // credential — which is configuration, is never defaulted, and whose absence makes them SKIP
  // with the variable named rather than fall back to asserting against an empty account. A skip is
  // an exit 1 here, so a pipeline cannot read the absence as a green.
  const operatorIdentifier = process.env['BEACON_ESTATE_OPERATOR'] ?? ''
  const operatorPassword = process.env['BEACON_ESTATE_OPERATOR_PASSWORD'] ?? ''
  const operator =
    operatorIdentifier !== '' && operatorPassword !== ''
      ? { identifier: operatorIdentifier, password: operatorPassword }
      : null
  if (operator === null) {
    stdout.write(
      'no BEACON_ESTATE_OPERATOR / _PASSWORD set — every journey that has to seed a balance will\n' +
        'skip, and a skip blocks.\n\n',
    )
  }

  const registry = { config, targets: new Set(targets.keys()), operator }
  const declared = browserJourneys(registry)

  if (declared.length === 0) {
    stderr.write('no browser journey declared itself against these addresses.\n')
    for (const line of undeclared(registry)) stderr.write(`  ${line}\n`)
    return 2
  }

  stdout.write(
    `${declared.length} browser journey(s) declared against ${targets.size} address(es)\n\n`,
  )
  let bad = 0
  for (const definition of declared) {
    const run = await runJourney(definition, { targets, trigger: 'manual' })
    // FAIL and ERROR are printed apart, because rule 1 of `journeys.ts` says they are different
    // outcomes and go to different people: a failed assertion is the PRODUCT broken, anything else
    // thrown is BEACON broken. Collapsing them is how somebody spends an evening debugging a
    // service that was fine - which is not hypothetical here, since a `page.goto` timing out on
    // this machine's loopback port-forward surfaces as `error`, correctly.
    const mark =
      run.status === 'pass'
        ? 'pass'
        : run.status === 'skip'
          ? 'SKIP'
          : run.status === 'fail'
            ? 'FAIL'
            : 'ERROR'
    stdout.write(
      `  ${mark}  ${definition.name}  ${Math.round(run.durationMs)}ms  ${definition.title}\n`,
    )
    for (const step of run.steps) {
      const glyph = step.status === 'pass' ? '·' : 'x'
      stdout.write(`        ${glyph} ${step.name}${step.error ? ` - ${step.error}` : ''}\n`)
    }
    if (run.status !== 'pass') {
      bad++
      stdout.write(`        ${run.status}: ${run.error ?? 'no reason given'}\n`)
    }
  }

  // The gap, after the result: the run's verdict is the last thing on the screen and the gap is
  // the thing you scroll up to.
  const gaps = undeclared(registry)
  if (gaps.length > 0) {
    stdout.write(`\n${gaps.length} unblocked scenario(s) still undeclared:\n`)
    for (const line of gaps) stdout.write(`  ${line}\n`)
  }
  stdout.write(`\n${declared.length - bad}/${declared.length} passed\n`)
  return bad === 0 ? 0 : 1
}

/* ------------------------------------------------------------------ beacon smoke */

interface SmokeArgs {
  readonly apex: string
  /**
   * The environment label, empty for the unadorned one. A SUFFIX on each subdomain rather than a
   * prefix on the apex — see `browser/smoke.ts`'s `surfaceHost` for why, which is that the shape
   * it replaced could not complete a TLS handshake and so could never have been smoked at all.
   */
  readonly env: string
  readonly executablePath: string
  readonly timeoutMs: number
  readonly surfaces: readonly string[]
}

export function parseSmokeArgs(
  args: readonly string[],
  source: Record<string, string | undefined>,
): SmokeArgs | null {
  let apex = source['BEACON_SMOKE_APEX'] ?? 'cloudsforge.localtest.me'
  let env = source['BEACON_SMOKE_ENV'] ?? ''
  let executablePath = source['BEACON_BROWSER_EXECUTABLE'] ?? ''
  let timeoutMs = 20_000
  const surfaces: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--apex') apex = args[++i] ?? ''
    else if (arg === '--env') env = args[++i] ?? ''
    else if (arg === '--browser') executablePath = args[++i] ?? ''
    else if (arg === '--timeout') timeoutMs = Number(args[++i] ?? '')
    else if (arg === '--surface') surfaces.push(args[++i] ?? '')
    else if (arg?.startsWith('--apex=')) apex = arg.slice('--apex='.length)
    else if (arg?.startsWith('--env=')) env = arg.slice('--env='.length)
    else if (arg?.startsWith('--browser=')) executablePath = arg.slice('--browser='.length)
    else if (arg?.startsWith('--timeout=')) timeoutMs = Number(arg.slice('--timeout='.length))
    else if (arg?.startsWith('--surface=')) surfaces.push(arg.slice('--surface='.length))
    else return null
  }
  if (!/^[a-z0-9.-]+$/.test(apex)) return null
  // A single DNS label, or nothing. NO DOT: a value containing one would be somebody reaching for
  // the old apex-prefix shape — `--env testnet.cloudsforge.online` — and composing
  // `hub-testnet.cloudsforge.online.<apex>`, which resolves to nothing and reads like a typo
  // rather than like a misunderstanding. Refusing it says which of the two it is.
  if (env !== '' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(env)) return null
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) return null
  if (surfaces.some((s) => s === '')) return null
  return { apex, env, executablePath, timeoutMs, surfaces }
}

/**
 * `beacon smoke` — the estate, in a real browser, with nothing stubbed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ABSENT ESTATE AND AN ABSENT BROWSER ARE EXIT 2, NEVER EXIT 0.**
 *
 * The command exists because `node --test` can only SKIP the browser half where no estate answers,
 * and a pipeline reading a skipped suite reads a green. This is the entry point a deploy script
 * uses instead, and its whole contract is that it cannot report success without having looked:
 * "nothing was listening" and "there is no Chromium" both block, exactly as `beacon browser`
 * treats a skip as an exit 1 for the same reason.
 *
 * Nothing is written anywhere. Recording runs is the SERVICE's job, on a lease.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function runSmokeCommand(args: SmokeArgs): Promise<0 | 1 | 2> {
  // Lazy, for the reason the module docstring gives about `env.ts`: this command drives a browser
  // against a public hostname and must never require a database credential to do it.
  const smoke = await import('./browser/smoke.ts')
  const { collectPins } = await import('./browser/estatecert.ts')
  const { browserAvailable } = await import('./browser/driver.ts')

  // FIRST, and before anything is dialled or launched. The credential is the cheapest of the three
  // preconditions to check and the most annoying to discover late: a run that resolves an apex,
  // collects sixteen certificate pins and starts Chromium before finding out it has no password
  // has spent a minute to say something it knew at the first line. Exit 2 for the same reason the
  // two below are — this command's contract is that it cannot report success without having
  // looked, and "I had no credential" is not having looked.
  const credentials = smoke.smokeCredentials(process.env)
  if (!credentials.ok) {
    stderr.write(`${credentials.reason}\n`)
    return 2
  }

  const reachable = await smoke.estateReachable(args.apex, undefined, args.env)
  if (!reachable.ok) {
    stderr.write(`${reachable.reason}\n`)
    return 2
  }

  const config = { enabled: true, executablePath: args.executablePath, timeoutMs: args.timeoutMs }
  const availability = await browserAvailable(config)
  if (!availability.ok) {
    stderr.write(`${availability.reason}\n  the estate is up and nothing is looking at it.\n`)
    return 2
  }

  const selected =
    args.surfaces.length === 0
      ? smoke.SMOKE_SURFACES
      : smoke.SMOKE_SURFACES.filter((s) => args.surfaces.includes(s.key))
  if (selected.length !== args.surfaces.length && args.surfaces.length > 0) {
    const known = smoke.SMOKE_SURFACES.map((s) => s.key).join(', ')
    stderr.write(`--surface named something that is not a surface. Known: ${known}\n`)
    return 2
  }

  // Through `surfaceHost`, not composed here: this used to spell the `<sub>.<apex>` rule a second
  // time, and a second copy of that rule would have kept pinning MAINNET certificates for a run
  // driving testnet pages — every host pinned, none of them the ones visited.
  const hosts = selected.map((s) => smoke.surfaceHost(args.apex, s.subdomain, args.env))
  const pins = await collectPins(hosts)
  for (const reason of pins.reasons) stdout.write(`tls  ${reason}\n`)
  stdout.write('\n')

  const result = await smoke.runSmoke({
    apex: args.apex,
    env: args.env,
    credentials: credentials.credentials,
    browser: { ...config, certificatePins: pins.spki },
    surfaces: selected,
  })

  const bySurface = new Map<string, number>()
  for (const finding of result.findings) {
    bySurface.set(finding.surfaceKey, (bySurface.get(finding.surfaceKey) ?? 0) + 1)
  }

  const signInBad = bySurface.get('sign-in') ?? 0
  stdout.write(`  ${signInBad === 0 ? 'pass' : 'FAIL'}  sign-in  ${result.signIn.landedAt}\n`)
  for (const observation of result.observations) {
    const bad = bySurface.get(observation.surfaceKey) ?? 0
    stdout.write(
      `  ${bad === 0 ? 'pass' : 'FAIL'}  ${observation.surfaceKey.padEnd(16)} ` +
        `HTTP ${String(observation.status ?? 'ERR').padEnd(4)} ` +
        `${String(observation.bodyText.trim().length).padStart(5)} chars  ${observation.url}\n`,
    )
  }

  if (result.findings.length > 0) {
    stdout.write(`\n${result.findings.length} finding(s):\n`)
    for (const finding of result.findings) {
      stdout.write(`  [${finding.surfaceKey}] ${finding.check}\n      ${finding.detail}\n`)
    }
  }

  // Named and never counted, exactly as `driver.ts` partitions it: the reporter being broken is
  // worth knowing about and is not the product being broken.
  const aside = smoke.observabilityAside(result.observations)
  if (aside.length > 0) {
    stdout.write(`\nnot counted — ${aside.length} browser-telemetry post(s) failed:\n`)
    for (const line of [...new Set(aside)]) stdout.write(`  ${line}\n`)
  }

  const healthy = result.observations.length + 1 - bySurface.size
  stdout.write(`\n${healthy}/${result.observations.length + 1} healthy\n`)
  return result.findings.length === 0 ? 0 : 1
}

/* ------------------------------------------------------------------ beacon slo-seed */

export interface SloSeedArgs {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly dryRun: boolean
}

/**
 * `--token` is the static `x-beacon-token`; `--bearer` is an identity access token.
 *
 * Both are accepted and the bearer is preferred when both are given, because `PUT /v1/slos/:name`
 * is declared `adminOnly` and only a bearer can satisfy that: `authorise` checks a bearer against
 * `isAdmin`, and the static token does not count as an administrator on any route (`server.ts`,
 * `authorise`). Seeding therefore needs a real admin identity — which is the point of going
 * through the front door rather than issuing an INSERT.
 *
 * `--token` is still accepted rather than removed, because it is what a caller reaches for and a
 * 403 naming `role:admin` says what to do next; silently rejecting the flag at parse time would
 * turn a clear server answer into "bad arguments".
 */
export function parseSloSeedArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SloSeedArgs | null {
  let url = ''
  let token = ''
  let bearer = ''
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--url') url = args[++i] ?? ''
    else if (arg === '--token') token = args[++i] ?? ''
    else if (arg === '--bearer') bearer = args[++i] ?? ''
    else if (arg?.startsWith('--url=')) url = arg.slice('--url='.length)
    else if (arg?.startsWith('--token=')) token = arg.slice('--token='.length)
    else if (arg?.startsWith('--bearer=')) bearer = arg.slice('--bearer='.length)
    else return null
  }

  if (!token) token = env['BEACON_TOKEN'] ?? ''
  if (dryRun) return { url: url || 'http://unused.invalid', headers: {}, dryRun: true }
  if (!url) return null
  if (!bearer && !token) return null

  return {
    url,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : { 'x-beacon-token': token },
    dryRun: false,
  }
}

/**
 * Register the owner's journey objectives.
 *
 * Exists so that the eleven rows are a command in a repository rather than eleven `curl`s in
 * somebody's shell history — which is how `slos` came to be empty in the first place. It is
 * idempotent (`upsertSlo` is an upsert), so the intended use is to run it on every deploy.
 *
 * `--dry-run` prints the plan and dials nothing, so the numbers can be reviewed against the
 * owner's decision without a running estate or a credential.
 */
async function runSloSeed(rest: readonly string[], env: NodeJS.ProcessEnv): Promise<0 | 1 | 2> {
  const args = parseSloSeedArgs(rest, env)
  if (!args) {
    stderr.write(USAGE)
    return 2
  }

  const {
    AVAILABILITY_OBJECTIVES,
    catalogue,
    OBJECTIVES,
    plan,
    planAvailability,
    probeTargets,
    registeredNames,
    seed,
    SloSeedError,
  } = await import('./sloseed.ts')

  let planned
  try {
    // The registry over the wire, the owning services from code. `plan`'s header says why the
    // first of those is not an import: `ecosystemJourneys()` reads `process.env` at import time,
    // so importing the registry here would seed a different table from inside the container than
    // from a shell — and `--dry-run` would show numbers that are not the ones that get written.
    const [registered, targets] = args.dryRun
      ? [Object.keys(OBJECTIVES), Object.keys(AVAILABILITY_OBJECTIVES)]
      : await Promise.all([
          registeredNames(args.url, args.headers),
          probeTargets(args.url, args.headers),
        ])
    const journeys = plan(await catalogue(), registered)
    const availability = planAvailability(targets)
    planned = {
      // Journeys first, then availability, so the output reads in the order the two halves were
      // added to the estate and an operator comparing two runs sees a stable list.
      slos: [...journeys.slos, ...availability.slos],
      refusals: [...journeys.refusals, ...availability.refusals],
    }
  } catch (err) {
    stderr.write(`${err instanceof SloSeedError ? err.message : String(err)}\n`)
    return 2
  }

  for (const slo of planned.slos) {
    const pct = (Number(slo.objectivePpm) / 10_000).toFixed(2)
    stdout.write(
      `  ${slo.name.padEnd(32)} ${slo.service.padEnd(10)} tier ${slo.tier}  ` +
        `${pct}%  ${slo.windowDays}d\n`,
    )
  }

  if (args.dryRun) {
    stdout.write(`\n${planned.slos.length} objectives planned — nothing was written\n`)
    // The refusals are printed under `--dry-run` too, and the exit code carries them. `--dry-run`
    // is how the plan is reviewed before a deploy, so a review that showed only the rows that WILL
    // be written would hide exactly the thing that needs a decision.
    return reportRefusals(planned.refusals)
  }

  const results = await seed(planned.slos, { baseUrl: args.url, headers: args.headers })
  const failed = results.filter((result) => !result.ok)
  stdout.write(`\n${results.length - failed.length}/${results.length} registered\n`)
  for (const result of failed) {
    stderr.write(`  FAILED ${result.name} — HTTP ${result.status} ${result.error ?? ''}\n`)
  }
  if (failed.length > 0) return 1
  return reportRefusals(planned.refusals)
}

/**
 * Print what nobody has ruled on, and make the command fail for it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS EXIT CODE IS WHAT IS LEFT OF `MISSING_IS_AN_ERROR`, AND IT IS THE HALF WORTH KEEPING.**
 *
 * `plan()` used to throw, so three unruled journeys withheld the twelve objectives the owner had
 * set and the estate recorded no error budget at all — measured on mainnet 2026-08-11, `slos` and
 * `slo_observations` both empty since the estate was built. Now the rows are written and the gap is
 * reported, and this is the line that stops "reported" meaning "mentioned in some output nobody
 * reads": the command exits **1**, so a deploy step that runs it goes red for exactly as long as
 * something has no objective.
 *
 * 1 and not 2. Two is "you invoked this wrongly" — bad arguments, no credential — and is what the
 * parse failures above return. A refusal is a correct invocation whose result is incomplete, and
 * the two are worth telling apart from a pipeline log.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function reportRefusals(refusals: readonly string[]): 0 | 1 {
  if (refusals.length === 0) return 0
  for (const refusal of refusals) stderr.write(`\nREFUSED: ${refusal}\n`)
  return 1
}

export async function main(argsIn: readonly string[]): Promise<0 | 1 | 2> {
  const [command, ...rest] = argsIn

  if (command === 'smoke') {
    const smokeArgs = parseSmokeArgs(rest, process.env)
    if (!smokeArgs) {
      stderr.write(USAGE)
      return 2
    }
    return runSmokeCommand(smokeArgs)
  }

  if (command === 'browser') {
    // Named before the generic parse failure, so a caller who still passes it is told what
    // replaced it rather than being shown the usage and left to guess. See INSECURE_TLS_REMOVED.
    if (rest.includes('--insecure-tls')) {
      stderr.write(INSECURE_TLS_REMOVED)
      return 2
    }
    const browserArgs = parseBrowserArgs(rest, process.env)
    if (!browserArgs) {
      stderr.write(USAGE)
      return 2
    }
    return runBrowser(browserArgs)
  }

  if (command === 'slo-seed') {
    return runSloSeed(rest, process.env)
  }

  if (command !== 'gate') {
    stderr.write(USAGE)
    return 2
  }
  const args = parseArgs(rest)
  if (!args) {
    stderr.write(USAGE)
    return 2
  }

  let decision: GateDecision
  try {
    decision = args.url ? await viaHttp(args) : await viaDatabase(args)
  } catch (err) {
    // ────────────────────────────────────────────────────────────────────────────────────────
    // FAILING TO ASK IS FAILING. This catch does not print a warning and return 0; a pipeline
    // that ships when the gate is unreachable is a pipeline with no gate, and the day it matters
    // is the day the estate is unhealthy enough that Beacon is down too.
    // ────────────────────────────────────────────────────────────────────────────────────────
    stderr.write(`could not ask the gate: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  stdout.write(args.json ? `${JSON.stringify(decision, null, 2)}\n` : render(decision))
  return decision.decision === 'refuse' ? 1 : 0
}

// `import.meta.main` does not exist on Node 22, so the entrypoint is identified by name. Matching
// on the full final segment rather than a bare `endsWith('cli.ts')` is what keeps `cli.test.ts`
// from being mistaken for it — a test that imported `main` and then had the module exit the
// process underneath it would be a test suite that passes by terminating.
const entry = (argv[1] ?? '').replace(/\\/g, '/')
if (entry.endsWith('/cli.ts') || entry.endsWith('/beacon')) {
  exit(await main(argv.slice(2)))
}
