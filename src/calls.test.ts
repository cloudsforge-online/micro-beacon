/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY ADDRESS BEACON REGISTERS MUST SIT UNDER A DOMAIN THAT CANNOT RECEIVE MAIL.**
 *
 * This file exists because the rule it enforces was, until now, only a habit. Three separate
 * modules mint synthetic addresses and all three happened to choose a reserved domain; nothing
 * required them to, nothing would have failed if a fourth had not, and the cost of that fourth is
 * the whole estate's outbound mail.
 *
 * The arithmetic, measured on the estate on 2026-08-07 (micro-org#243): the scheduler drove ~95
 * registrations an hour, every one of them makes identity emit
 * `identity.email.verification_requested`, `notify` turns each into a verification mail, and the
 * mail plan allows **250 a day**. 1,839 sends failed that day against 89 that succeeded. The
 * provider's refusal is `535`, the reply code for bad credentials, so the estate diagnosed broken
 * SMTP credentials — twice — on a relay that was authenticated and working the whole time.
 *
 * What makes a reserved domain free rather than merely rude is on the other side:
 * `notify/src/reserved.ts` declines to open the email channel for the TLDs RFC 6761 §6 reserves,
 * so the delivery row is never written and no connection is ever made. That is a contract between
 * two repositories with no compiler between them, which is exactly the kind that rots quietly.
 * This test is beacon's half of it.
 *
 * ## What it does NOT claim
 *
 * It does not claim beacon proves mail leaves the estate. It never has: no probe reads a mailbox
 * and no verification token has ever been consumed by one. See `throwaway()` in `calls.ts` for the
 * coverage statement in full. This test guards the address, and `notify`'s
 * `notify_deliveries_awaiting_allowance` gauge is what watches the mail.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { throwaway } from './calls.ts'
import { syntheticCredential } from './browser/fixtures.ts'
import type { JourneyContext } from './journeys.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * The TLDs that are guaranteed to have no mail exchanger, ever.
 *
 * RFC 6761 §6 reserves `.test`, `.example`, `.invalid` and `.localhost` and requires resolvers to
 * treat them as special; RFC 2606 §3 reserves `example.com`, `.net` and `.org` as second-level
 * names. Only the first group is listed, deliberately: a second-level name is a suffix match away
 * from `notexample.com`, and this list is compared against the LAST label only so that a typo
 * cannot widen it.
 *
 * Kept in step with `notify/src/reserved.ts` by hand, because there is no shared package between
 * these two repositories. If that list grows, this one may; if it shrinks, this one MUST.
 */
const RESERVED_TLDS: readonly string[] = ['test', 'example', 'invalid', 'localhost']

/**
 * Every address-shaped literal in a source file that is not under a reserved TLD.
 *
 * Comment-only lines are stripped before matching, so the prose above `throwaway()` is free to
 * name a real-looking address when it is explaining what went wrong. A match needs a character
 * immediately before the `@`, which keeps npm scopes (`from '@cloudsforge/telemetry'`) and JSDoc
 * tags (`@param`) out, and the domain must carry a dot and end in letters, which keeps
 * `postgres://user:pass@127.0.0.1:5432/db` and `corpus@9f2c1` out. A templated domain is an
 * offence on sight: the point is that the domain is decidable by reading the source.
 */
export function scanForRoutableAddresses(source: string, file: string): readonly string[] {
  const offences: string[] = []
  const pattern = /[A-Za-z0-9_}$.+-]@([A-Za-z0-9${}._-]+)/g
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/^\s*(\*|\/\/).*$/, '')
    let match: RegExpExecArray | null
    pattern.lastIndex = 0
    while ((match = pattern.exec(code)) !== null) {
      const domain = match[1] ?? ''
      const where = `${file}: ${line.trim()}`
      if (domain.includes('${')) {
        offences.push(`${where}  — the domain is interpolated; it must be a literal reserved TLD`)
        continue
      }
      const labels = domain.split('.')
      const tld = labels[labels.length - 1] ?? ''
      // Not an address at all — a URL authority, a digest, a version. Nothing to say about it.
      if (labels.length < 2 || !/^[A-Za-z]{2,}$/.test(tld)) continue
      if (!RESERVED_TLDS.includes(tld.toLowerCase())) {
        offences.push(`${where}  — '.${tld}' can resolve, so this address would cost a real email`)
      }
    }
  })
  return offences
}

test('the scanner CAN fail — proved against the change that would re-open the defect', () => {
  // The one-character edit that costs the estate its mail: a domain that resolves.
  const planted = [
    'export function throwaway(): Throwaway {',
    '  return { email: `beacon+${id}@cloudsforge.online`, handle: `bx_${id}`, password: pw() }',
    '}',
  ].join('\n')
  const offences = scanForRoutableAddresses(planted, 'planted.ts')
  assert.equal(offences.length, 1, `expected the address, got ${JSON.stringify(offences)}`)
  assert.match(offences[0] ?? '', /'\.online' can resolve/)

  // And the subtler one: a domain read from configuration, which reads as flexible and means
  // nobody can tell from the source whether the estate is about to send 95 emails an hour.
  const templated = scanForRoutableAddresses('const to = `beacon@${env.MAIL_DOMAIN}`', 'p.ts')
  assert.equal(templated.length, 1)
  assert.match(templated[0] ?? '', /interpolated/)

  // The exclusions are real exclusions, not an empty scanner.
  assert.deepEqual(scanForRoutableAddresses("import { x } from '@cloudsforge/telemetry'", 'p.ts'), [])
  assert.deepEqual(scanForRoutableAddresses("const u = 'postgres://b:b@127.0.0.1:5432/b'", 'p.ts'), [])
  assert.deepEqual(scanForRoutableAddresses(' * beacon+1234@real-domain.com is what broke it', 'p.ts'), [])
  assert.deepEqual(scanForRoutableAddresses('const e = `bj-${id}@example.test`', 'p.ts'), [])
})

test('NO SOURCE FILE IN THIS SERVICE NAMES AN ADDRESS THAT COULD RECEIVE MAIL', async () => {
  const files = await sources(HERE)
  // A guard that reads the wrong directory passes forever. `src/` had well over fifty files when
  // this was written; the floor is only here to notice a move, not to be precise.
  assert.ok(files.length >= 30, `only ${files.length} files scanned; this is reading the wrong place`)

  const offences: string[] = []
  for (const file of files) {
    // This file is the exclusion, and it is the only one: it has to spell a routable address out
    // in order to prove the scanner finds one. Everything it asserts about the others is asserted
    // about it by the test above, which plants a real offence and requires a red.
    if (file.endsWith('calls.test.ts')) continue
    offences.push(...scanForRoutableAddresses(await readFile(join(HERE, file), 'utf8'), file))
  }

  assert.deepEqual(
    offences,
    [],
    'A synthetic address moved to a domain that can receive mail. Every registration beacon makes ' +
      'sends a verification email, the estate\'s plan allows 250 a day, and beacon makes ~95 an ' +
      'hour — so this exhausts the allowance before any real user can be verified (micro-org#243). ' +
      'Use a TLD from RFC 6761 §6; notify drops those before SMTP:\n' + offences.join('\n'),
  )
})

test('throwaway() mints an unroutable address, and a fresh secret, every time', () => {
  const seen = new Set<string>()
  const secrets = new Set<string>()
  for (let i = 0; i < 200; i += 1) {
    const account = throwaway()
    assert.deepEqual(scanForRoutableAddresses(`x = '${account.email}'`, 'minted'), [])
    assert.ok(account.email.endsWith('.test'), account.email)
    // Namespaced, because identity has no deletion route a monitor may call and the rows have to
    // be findable: `delete from users where email like 'beacon+%'`.
    assert.ok(account.email.startsWith('beacon+'), account.email)
    seen.add(account.email)
    secrets.add(account.password)
  }
  assert.equal(seen.size, 200, 'two journeys sharing an account move each other\'s session')
  // micro-org#276: a constant is what got us here. Per-call, not per-process, not per-release.
  assert.equal(secrets.size, 200, 'the password must be minted per account, never threaded through')
})

test('the browser tier mints an unroutable address too, from a different generator', () => {
  // Two generators for one rule is two things to get right, which is why the scan above covers the
  // source of both. This is the behavioural half for the one that takes a run id.
  const ctx = { runId: '7f3a1c22-0000-4000-8000-abcdefabcdef' } as unknown as JourneyContext
  const credential = syntheticCredential(ctx, 'w')
  assert.deepEqual(scanForRoutableAddresses(`x = '${credential.email}'`, 'minted'), [])
  assert.ok(credential.email.endsWith('.test'), credential.email)
  assert.notEqual(credential.password, syntheticCredential(ctx, 'w').password)
})

/** Every `.ts` under `src/`, as paths relative to it. */
async function sources(root: string, prefix = ''): Promise<readonly string[]> {
  const found: string[] = []
  for (const entry of await readdir(join(root, prefix))) {
    const relative = join(prefix, entry)
    if ((await stat(join(root, relative))).isDirectory()) {
      found.push(...(await sources(root, relative)))
    } else if (entry.endsWith('.ts')) {
      found.push(relative)
    }
  }
  return found
}
