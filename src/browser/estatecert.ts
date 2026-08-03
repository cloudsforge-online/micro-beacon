/**
 * The certificate the estate actually serves, and the narrowest possible way to accept it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`ignoreHTTPSErrors: true` IS A CHECK THAT CANNOT FAIL, WEARING THE COSTUME OF A DEV SHORTCUT.**
 *
 * The dev estate terminates TLS on a certificate issued by `CN=CloudsForge Estate Local CA` — a
 * root that exists on the machine that generated it and in no trust store anywhere — because
 * `ui/packages/ui/src/surfaces.ts` emits `https://` unconditionally and there is no public CA for
 * `*.localtest.me`. Something has to accept it or every browser check in this suite dies at
 * `page.goto` with `ERR_CERT_AUTHORITY_INVALID`, which is a red that says nothing about the
 * product.
 *
 * The obvious lever is `ignoreHTTPSErrors`, and `driver.ts` already carries one for the journeys.
 * It is the wrong lever for a suite whose whole purpose is that it cannot be fooled, because it
 * turns off certificate validation **for every host, for every error, for ever**. Point the same
 * suite at staging and it will report green through an expired certificate, a certificate issued
 * for the wrong hostname, a certificate signed by a CA nobody enrolled, and an active
 * man-in-the-middle. That is the estate's signature defect — a check structurally incapable of
 * noticing the thing it was pointed at — reintroduced in the one suite written to end it.
 *
 * So this module does the narrow thing instead:
 *
 *   1. **Look at the certificate the gateway is really serving**, over a plain Node TLS socket,
 *      before any browser starts — and ask Node to verify it against the system trust store while
 *      doing so, which is the question that decides everything else.
 *   2. **Decide whether it may be pinned**, by the rules in `pinPolicy` below. Exactly one
 *      condition earns a pin: the chain does not reach a trusted root, which is what a private
 *      development CA looks like and is the case that is not a defect. Expiry, a certificate
 *      issued for a different hostname, and every other verification failure are refused a pin and
 *      therefore still fail in the browser — they are outages, and they are among the few a
 *      synthetic monitor sees before a customer does.
 *   3. **Pin the one public key**, by SHA-256 of its SubjectPublicKeyInfo, through Chromium's
 *      `--ignore-certificate-errors-spki-list`. That flag does not disable validation; it excuses
 *      errors *only* for the exact keys listed. Every other certificate on every other host is
 *      still fully validated, and a substituted certificate on this host is still rejected.
 *
 * Verified against the running estate rather than assumed. With the gateway's own leaf SPKI the
 * pages load; with one byte changed the same navigation fails `net::ERR_CERT_AUTHORITY_INVALID`;
 * and with the issuing CA's SPKI instead of the leaf's it ALSO fails, which is why the leaf is
 * what gets pinned. A pin that accepted anything would have passed all three.
 *
 * **Why expiry and hostname are re-checked here rather than left to Chromium.** The SPKI list
 * excuses *all* certificate errors for a listed key — expiry and name mismatch included — so
 * pinning without these two checks would restore the blind spot for the one host that matters
 * most. Both are therefore established in this process, from the certificate itself, and an
 * offending certificate is refused a pin. It then fails in the browser, loudly, which is correct.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { X509Certificate, createHash } from 'node:crypto'
import { connect } from 'node:tls'

/** What the gateway presented, reduced to the facts a pin decision turns on. */
export interface CertificateFacts {
  /** The host whose SNI produced it. */
  readonly host: string
  /** base64(SHA-256(DER SubjectPublicKeyInfo)) of the LEAF — the value Chromium's flag takes. */
  readonly spkiSha256: string
  readonly subject: string
  readonly issuer: string
  /** True when the chain verified against the system trust store. Then nothing needs excusing. */
  readonly trusted: boolean
  /** OpenSSL's verdict when it did not. `''` when it did. */
  readonly verifyError: string
  /**
   * The SAN entry that matched the host, or `null` when none did.
   *
   * Separate from `trusted` because a certificate can be perfectly well issued and simply be for
   * somebody else, and that is a defect the pin must never paper over.
   */
  readonly hostMatched: string | null
  readonly notBefore: number
  readonly notAfter: number
}

/**
 * The verification failures that mean "this root is private", and nothing worse.
 *
 * A development CA that no store has enrolled produces one of these and produces nothing else. An
 * expired certificate, a name mismatch, a revoked certificate and a bad signature all produce
 * different codes and are all refused a pin — which is the entire safety property of this module,
 * so the set is an allowlist and never a denylist.
 */
export const PRIVATE_ROOT_ERRORS: readonly string[] = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]

/**
 * Read the certificate a host is serving, without trusting it.
 *
 * `rejectUnauthorized: false` is correct **here and only here**: the point of the connection is to
 * examine a certificate that by construction does not verify. Nothing is sent over the socket and
 * it is closed as soon as the peer certificate is in hand.
 */
export async function inspectCertificate(
  host: string,
  options: { readonly port?: number; readonly connectTo?: string; readonly timeoutMs?: number } = {},
): Promise<CertificateFacts> {
  const port = options.port ?? 443
  const timeoutMs = options.timeoutMs ?? 5_000
  return await new Promise<CertificateFacts>((resolve, reject) => {
    const socket = connect(
      {
        host: options.connectTo ?? host,
        port,
        servername: host,
        rejectUnauthorized: false,
        // A pinned suite must not hang on a gateway that accepts the TCP connection and never
        // completes the handshake — that is an outage, and it has to be reported as one.
        timeout: timeoutMs,
      },
      () => {
        const peer = socket.getPeerCertificate()
        // `rejectUnauthorized: false` does not skip verification, it only declines to hang up on
        // a failure — so the verdict is still here, and it is the fact the whole policy turns on.
        const trusted = socket.authorized
        const verifyError = socket.authorizationError ? String(socket.authorizationError) : ''
        socket.end()
        if (!peer || !peer.raw) {
          reject(new Error(`${host}:${port} completed a handshake and presented no certificate`))
          return
        }
        const cert = new X509Certificate(peer.raw)
        const der = cert.publicKey.export({ type: 'spki', format: 'der' })
        resolve({
          host,
          spkiSha256: createHash('sha256').update(der).digest('base64'),
          subject: cert.subject.replace(/\n/g, ' '),
          issuer: cert.issuer.replace(/\n/g, ' '),
          trusted,
          verifyError,
          hostMatched: cert.checkHost(host) ?? null,
          notBefore: Date.parse(cert.validFrom),
          notAfter: Date.parse(cert.validTo),
        })
      },
    )
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error(`${host}:${port} did not complete a TLS handshake within ${timeoutMs}ms`))
    })
    socket.on('error', (err: Error) => reject(new Error(`${host}:${port}: ${err.message}`)))
  })
}

export type PinDecision =
  | { readonly pin: true; readonly spkiSha256: string; readonly why: string }
  | { readonly pin: false; readonly why: string }

/**
 * May this certificate be excused, and on what grounds?
 *
 * Pure, so every refusal can be proved without a network — and the refusals are the whole value of
 * the module, because each one is a real failure this suite must still be able to see:
 *
 *   * **Already trusted** — no pin, and none needed. Whatever chain the browser builds it builds
 *     honestly, and if it fails, a real certificate is broken and that is news.
 *   * **Outside its validity window** — no pin. An expired gateway certificate is an outage.
 *   * **Issued for a different hostname** — no pin. A certificate that is valid and simply is not
 *     for this host is the shape of a misrouted or substituted endpoint.
 *   * **Any verification failure other than an unreachable root** — no pin, naming the code. A bad
 *     signature is not a laptop inconvenience.
 *   * **A root nothing has enrolled** — pin exactly this leaf key, and only this one.
 *
 * `now` is a parameter rather than a `Date.now()` inside, so the expiry branch is testable at all.
 */
export function pinPolicy(facts: CertificateFacts, now: number): PinDecision {
  if (facts.trusted) {
    return {
      pin: false,
      why:
        `${facts.host} serves a certificate that verifies against the system trust store ` +
        `(${facts.issuer}) — nothing needs excusing, and a failure here is a real one`,
    }
  }
  if (!Number.isFinite(facts.notBefore) || !Number.isFinite(facts.notAfter)) {
    return { pin: false, why: `${facts.host}'s certificate has no readable validity window` }
  }
  if (now < facts.notBefore) {
    return {
      pin: false,
      why:
        `${facts.host} serves a certificate that is not valid until ` +
        `${new Date(facts.notBefore).toISOString()} — that is a defect, not a local inconvenience`,
    }
  }
  if (now > facts.notAfter) {
    return {
      pin: false,
      why:
        `${facts.host} serves a certificate that expired at ` +
        `${new Date(facts.notAfter).toISOString()} — pinning it would hide an outage`,
    }
  }
  if (facts.hostMatched === null) {
    return {
      pin: false,
      why:
        `${facts.host} is served a certificate for ${facts.subject}, which does not cover this ` +
        'hostname — excusing that is excusing being sent to the wrong endpoint',
    }
  }
  if (!PRIVATE_ROOT_ERRORS.includes(facts.verifyError)) {
    return {
      pin: false,
      why:
        `${facts.host}'s certificate failed verification with ${facts.verifyError || 'no reason given'}, ` +
        'which is not a private root — nothing is excused',
    }
  }
  return {
    pin: true,
    spkiSha256: facts.spkiSha256,
    why:
      `${facts.host} serves ${facts.subject} issued by ${facts.issuer}, a root no store has ` +
      `enrolled (${facts.verifyError}); valid for this host until ` +
      `${new Date(facts.notAfter).toISOString()}. Its leaf key alone is excused, nothing else is`,
  }
}

export interface PinSet {
  /** Every distinct SPKI hash that may be excused. Empty means "validate everything normally". */
  readonly spki: readonly string[]
  /** One line per host, for the log. A pin nobody can see is a pin nobody reviews. */
  readonly reasons: readonly string[]
}

/**
 * Inspect every host the suite will visit and collect the keys that may be excused.
 *
 * Per host rather than once, deliberately. The estate serves one default certificate today, so the
 * set collapses to a single entry — but a host that quietly started serving a *different* one
 * would otherwise be excused by a pin taken from its neighbour, which is the same "one check
 * covering something it never looked at" mistake in miniature.
 *
 * A host that cannot be reached at all does NOT stop the set being built: that is an outage the
 * page-level assertions must report as an outage, with the surface's name on it, rather than a
 * setup error that hides the other fifteen.
 */
export async function collectPins(
  hosts: readonly string[],
  options: { readonly port?: number; readonly connectTo?: string; readonly now?: number } = {},
): Promise<PinSet> {
  const now = options.now ?? Date.now()
  const spki = new Set<string>()
  const reasons: string[] = []
  for (const host of hosts) {
    let facts: CertificateFacts
    try {
      const inspectOptions: Parameters<typeof inspectCertificate>[1] = {}
      if (options.port !== undefined) Object.assign(inspectOptions, { port: options.port })
      if (options.connectTo !== undefined) Object.assign(inspectOptions, { connectTo: options.connectTo })
      facts = await inspectCertificate(host, inspectOptions)
    } catch (err) {
      reasons.push(`${host}: no certificate to inspect (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    const decision = pinPolicy(facts, now)
    reasons.push(decision.why)
    if (decision.pin) spki.add(decision.spkiSha256)
  }
  return { spki: [...spki].sort(), reasons }
}
