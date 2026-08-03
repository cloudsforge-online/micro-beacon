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
  browser   drive the declared tier-3 browser journeys against a running estate

beacon gate --release <tag> [--url <base>] [--token <token>] [--json] [--record]

  --release   the release candidate being considered. Required.
  --url       Beacon's base URL. Omit to evaluate directly against the database.
  --token     the x-beacon-token credential. Required with --url unless BEACON_TOKEN is set.
  --record    write the decision to gate_decisions. Off by default: asking must not change
              what the gate would answer next time.
  --json      print the decision as JSON rather than as prose.

exit codes: 0 promote · 1 refuse · 2 could not ask

beacon browser [--targets <name=url,...>] [--browser <path>] [--insecure-tls] [--timeout <ms>]

  --targets       the estate's addresses. Defaults to BEACON_TARGETS.
  --browser       a Chromium executable. Defaults to BEACON_BROWSER_EXECUTABLE, then to the one
                  playwright-core would use.
  --insecure-tls  accept the certificate the gateway serves. Needed for a dev estate terminating
                  on Traefik's self-signed default; NEVER for a real one.
  --timeout       per-operation timeout in ms. Default 30000.

exit codes: 0 every declared journey passed · 1 one failed, errored or SKIPPED · 2 nothing
was declared, or the arguments were wrong
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
  readonly insecureTls: boolean
  readonly timeoutMs: number
}

export function parseBrowserArgs(
  args: readonly string[],
  source: Record<string, string | undefined>,
): BrowserArgs | null {
  let targets = source['BEACON_TARGETS'] ?? ''
  let executablePath = source['BEACON_BROWSER_EXECUTABLE'] ?? ''
  let insecureTls = false
  let timeoutMs = 30_000

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--insecure-tls') insecureTls = true
    else if (arg === '--targets') targets = args[++i] ?? ''
    else if (arg === '--browser') executablePath = args[++i] ?? ''
    else if (arg === '--timeout') timeoutMs = Number(args[++i] ?? '')
    else if (arg?.startsWith('--targets=')) targets = arg.slice('--targets='.length)
    else if (arg?.startsWith('--browser=')) executablePath = arg.slice('--browser='.length)
    else if (arg?.startsWith('--timeout=')) timeoutMs = Number(arg.slice('--timeout='.length))
    else return null
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) return null
  return { targets, executablePath, insecureTls, timeoutMs }
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

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // THE FLAG HAS TO REACH `fetch` TOO, AND THE FIRST VERSION OF THIS DID NOT.
  //
  // A browser journey makes TWO kinds of request: the browser's, and its own — BJ-XS-10 fetches
  // each address the switcher offers, and BJ-ACC-02 seeds an account over HTTP. Telling Chromium
  // to accept the gateway's self-signed certificate and leaving Node's fetch strict produced
  // exactly the shape of failure this repository keeps finding: three of four journeys red with
  // `TypeError: fetch failed`, which names neither TLS nor the certificate and reads as the estate
  // being down. BJ-XS-10 got as far as reporting that `create.<apex>` does not answer. It does.
  //
  // Process-wide, and only inside this command, which is a short-lived CLI that does nothing else.
  // The SERVICE never takes this path: `runBrowser` is not reachable from `index.ts`.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  if (args.insecureTls) process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

  const config = {
    enabled: true,
    executablePath: args.executablePath,
    timeoutMs: args.timeoutMs,
    ignoreHttpsErrors: args.insecureTls,
  }
  const registry = { config, targets: new Set(targets.keys()) }
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

export async function main(argsIn: readonly string[]): Promise<0 | 1 | 2> {
  const [command, ...rest] = argsIn

  if (command === 'browser') {
    const browserArgs = parseBrowserArgs(rest, process.env)
    if (!browserArgs) {
      stderr.write(USAGE)
      return 2
    }
    return runBrowser(browserArgs)
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
