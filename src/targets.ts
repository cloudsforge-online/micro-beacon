/**
 * `BEACON_TARGETS`, parsed — in a module with no side effects.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS IS NOT IN `env.ts`, WHICH IS WHERE IT LIVED.**
 *
 * `env.ts` ends with `export const env: Env = (() => { … })()`, so importing it for ANY reason
 * loads the whole environment and, on a missing `BEACON_DATABASE_URL`, calls `process.exit(1)`.
 * That is exactly right for the service and exactly wrong for `beacon browser`, which drives a
 * browser against a running estate and has no business holding a database credential — the same
 * argument `cli.ts` already makes about why `beacon gate --url` imports `env.ts` lazily.
 *
 * So the parser moved here and `env.ts` imports it. One copy, not two: a second parser for the one
 * variable that names every address would drift, and the drift would be a monitor pointed
 * somewhere nobody meant.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Thrown for a malformed entry. `env.ts` re-raises it as an `EnvError`, so its callers see one type. */
export class TargetsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetsError'
  }
}

/**
 * `name=url,name=url` — the estate's addresses, as one variable.
 *
 * Parsed strictly rather than leniently. A typo that silently produced a target named
 * `"pay=http://pay:4003"` would probe nothing and report green, and a monitor that reports green
 * because it was misconfigured is worse than no monitor: it is a monitor that has been believed.
 *
 * The value may carry a PATH as well as a host — `account=https://hub.example/account` is the real
 * shape today, because the sign-in surface rides under Hub. The trailing slash is stripped and
 * nothing else is touched.
 */
export function parseTargets(raw: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new TargetsError(`BEACON_TARGETS entry "${pair}" is not name=url`)
    const name = pair.slice(0, eq).trim()
    const url = pair.slice(eq + 1).trim()
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new TargetsError(`BEACON_TARGETS name "${name}" must be lowercase kebab-case`)
    }
    if (!/^https?:\/\/[^\s]+$/.test(url)) {
      throw new TargetsError(`BEACON_TARGETS url for "${name}" must be an http(s) URL (got "${url}")`)
    }
    if (out.has(name)) throw new TargetsError(`BEACON_TARGETS names "${name}" twice`)
    out.set(name, url.replace(/\/+$/, ''))
  }
  return out
}
