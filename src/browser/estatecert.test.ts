/**
 * The pin policy, and the refusals that are the whole point of it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `estatecert.ts` HAD NO TEST. It is the module that decides whether a certificate error may be
 * excused in a suite whose only value is that it cannot be fooled, and nothing anywhere proved
 * that it refuses anything. A security control nobody exercises is a security control nobody has
 * — this repository says so about the estate's own bootstrap, and it is truer here.
 *
 * Every case below is a REFUSAL except one. That ratio is deliberate: an allowlist that says yes
 * is easy to write and easy to get right, and the value is entirely in the noes. The one `pin:
 * true` case exists so the refusals cannot pass by accident — a `pinPolicy` that returned `false`
 * unconditionally would satisfy every other assertion in this file.
 *
 * These are pure over `CertificateFacts`, so a bad certificate is expressible without minting one
 * and without a network. `inspectCertificate` is what turns a socket into these facts, and the
 * facts are where every decision is actually made.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRIVATE_ROOT_ERRORS, pinPolicy, trustEstateCa, type CertificateFacts } from './estatecert.ts'

const NOW = Date.parse('2026-08-04T00:00:00Z')

/** A private-root certificate that is otherwise perfect. Every case below spoils exactly one field. */
const GOOD: CertificateFacts = {
  host: 'hub.cloudsforge.localtest.me',
  spkiSha256: 'Zm9yZXNpZ2h0LXNwa2ktc2hhLTI1Ni1wbGFjZWhvbGRlcg==',
  subject: 'CN=cloudsforge.localtest.me',
  issuer: 'CN=CloudsForge Estate Local CA',
  trusted: false,
  verifyError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  hostMatched: '*.cloudsforge.localtest.me',
  notBefore: Date.parse('2026-08-01T00:00:00Z'),
  notAfter: Date.parse('2026-11-01T00:00:00Z'),
}

test('a private root, in window, for this host, is the ONE thing that earns a pin', () => {
  const decision = pinPolicy(GOOD, NOW)
  assert.equal(decision.pin, true)
  assert.equal(decision.pin && decision.spkiSha256, GOOD.spkiSha256)
  assert.match(decision.why, /a root no store has enrolled/)
})

test('an EXPIRED certificate is refused — pinning it would hide an outage', () => {
  const decision = pinPolicy({ ...GOOD, notAfter: Date.parse('2026-08-03T00:00:00Z') }, NOW)
  assert.equal(decision.pin, false)
  assert.match(decision.why, /expired/)
})

test('a certificate NOT YET VALID is refused', () => {
  const decision = pinPolicy({ ...GOOD, notBefore: Date.parse('2026-09-01T00:00:00Z') }, NOW)
  assert.equal(decision.pin, false)
  assert.match(decision.why, /not valid until/)
})

test('a certificate issued for ANOTHER HOSTNAME is refused — that is the shape of a substitution', () => {
  const decision = pinPolicy({ ...GOOD, hostMatched: null }, NOW)
  assert.equal(decision.pin, false)
  assert.match(decision.why, /does not cover this hostname/)
})

test('a BAD SIGNATURE is refused, and the code is named', () => {
  const decision = pinPolicy({ ...GOOD, verifyError: 'CERT_SIGNATURE_FAILURE' }, NOW)
  assert.equal(decision.pin, false)
  assert.match(decision.why, /CERT_SIGNATURE_FAILURE/)
  assert.match(decision.why, /not a private root/)
})

test('a REVOKED certificate is refused — the error set is an allowlist, never a denylist', () => {
  const decision = pinPolicy({ ...GOOD, verifyError: 'CERT_REVOKED' }, NOW)
  assert.equal(decision.pin, false)
  assert.equal(PRIVATE_ROOT_ERRORS.includes('CERT_REVOKED'), false)
})

test('an ALREADY TRUSTED certificate gets no pin, because nothing needs excusing', () => {
  const decision = pinPolicy({ ...GOOD, trusted: true, verifyError: '' }, NOW)
  assert.equal(decision.pin, false)
  assert.match(decision.why, /nothing needs excusing/)
})

test('a certificate with no readable validity window is refused', () => {
  const decision = pinPolicy({ ...GOOD, notAfter: Number.NaN }, NOW)
  assert.equal(decision.pin, false)
  assert.match(decision.why, /no readable validity window/)
})

/*
 * `trustEstateCa` — the other half, and it fails rather than degrading.
 *
 * The failure that matters is the third one: a file that LOOKS like a certificate and is not. A
 * check for a `-----BEGIN CERTIFICATE-----` line would pass a truncated PEM and then hand OpenSSL
 * a trust store it silently could not use, which is a verifier that has stopped verifying without
 * saying so — this estate's signature defect, in the module written to end it.
 */
test('naming no root changes nothing, and says so', () => {
  const result = trustEstateCa([])
  assert.equal(result.ok, true)
  assert.match(result.why, /system trust store stands unmodified/)
})

test('an unreadable path is an ERROR, not a silent carry-on', () => {
  const result = trustEstateCa(['/no/such/estate/ca.crt'])
  assert.equal(result.ok, false)
  assert.match(result.why, /cannot read the estate CA/)
})

test('a file that is not a certificate is an ERROR, and it is caught by PARSING not by grepping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-ca-'))
  const file = join(dir, 'truncated.crt')
  // A real PEM header and nothing usable after it: the exact shape a substring check would accept.
  writeFileSync(file, '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n')
  const result = trustEstateCa([file])
  assert.equal(result.ok, false)
  assert.match(result.why, /is not a certificate/)
})
