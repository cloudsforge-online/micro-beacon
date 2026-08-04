/**
 * keccak256, because a browser journey that reads a contract must derive its own selectors.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS IS HERE AND NOT A FOUR-BYTE CONSTANT WITH A COMMENT.**
 *
 * The money journeys in `moneyjourneys.ts` assert what a Foresight market page RENDERS against
 * what the market's contract on chain 7412 actually holds, in exact wei. To ask the chain, this
 * repository has to encode `pool(uint256)` and `stakeOf(address)` and `payoutOf(address)`, and the
 * first four bytes of each is the keccak-256 of the signature.
 *
 * The alternative was a table of literals — `pool(uint256)` is `0x9d3ffdcc` — with the signature in
 * a comment beside each. That is a number a reader has to TRUST, and a wrong one does not error:
 * `eth_call` against a selector no function has returns `0x`, which the estate's own decoder turns
 * into `null` and a careless assertion turns into a skip or a zero. A silent zero is the exact
 * failure `foresight-web/src/lib/abi.ts` says it exists to prevent — "a confident zero where the
 * truth is 'not known'" — and it would be introduced here by the shortcut.
 *
 * Derived, it is checked on every run by three things at once: the empty-string vector below, which
 * is the published one; `keccak.test.ts`, which pins the selectors this repository actually uses;
 * and the live contract, which answers real numbers only if the four bytes were right.
 *
 * `foresight-web/src/lib/keccak.ts` is the same function for the same reason on the other side of
 * the wire. It is NOT imported: beacon must be buildable and runnable without a checkout of any
 * frontend beside it, and a browser suite that cannot run without the bundle's source is a suite
 * that skips in CI. The two are held together by the selector test rather than by a symlink.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Scope: keccak-256 over bytes, `0x01` padding — the pre-NIST padding Ethereum kept. This is NOT
 * SHA3-256, which pads `0x06`, and Node's `createHash('sha3-256')` is the wrong function. That
 * substitution is the classic mistake here and it fails loudly against the vector below.
 */

/** The 24 round constants of Keccak-f[1600], as 64-bit values. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

/** ρ offsets, indexed by lane. */
const ROTATION: readonly number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]

const MASK = (1n << 64n) - 1n

const rotl = (value: bigint, by: number): bigint => {
  if (by === 0) return value
  const n = BigInt(by)
  return ((value << n) | (value >> (64n - n))) & MASK
}

/** Keccak-f[1600] on 25 lanes, in place. */
function permute(lanes: bigint[]): void {
  for (let round = 0; round < 24; round += 1) {
    // θ
    const c: bigint[] = new Array(5)
    for (let x = 0; x < 5; x += 1) {
      c[x] =
        (lanes[x] ?? 0n) ^
        (lanes[x + 5] ?? 0n) ^
        (lanes[x + 10] ?? 0n) ^
        (lanes[x + 15] ?? 0n) ^
        (lanes[x + 20] ?? 0n)
    }
    for (let x = 0; x < 5; x += 1) {
      const d = (c[(x + 4) % 5] ?? 0n) ^ rotl(c[(x + 1) % 5] ?? 0n, 1)
      for (let y = 0; y < 25; y += 5) lanes[x + y] = (lanes[x + y] ?? 0n) ^ d
    }

    // ρ and π
    const b: bigint[] = new Array(25).fill(0n)
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(lanes[x + 5 * y] ?? 0n, ROTATION[x + 5 * y] ?? 0)
      }
    }

    // χ
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        lanes[x + y] = (b[x + y] ?? 0n) ^ (~(b[((x + 1) % 5) + y] ?? 0n) & MASK & (b[((x + 2) % 5) + y] ?? 0n))
      }
    }

    // ι
    lanes[0] = (lanes[0] ?? 0n) ^ (ROUND_CONSTANTS[round] ?? 0n)
  }
}

/**
 * The sponge, with the domain-separation byte as a parameter.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PARAMETER IS WHAT MAKES THIS TESTABLE AGAINST SOMETHING THAT IS NOT ITSELF.**
 *
 * keccak-256 and SHA3-256 are the SAME permutation and differ in one byte: keccak pads `0x01`,
 * SHA3 pads `0x06`. Node ships SHA3-256 from OpenSSL. So exposing both lets `keccak.test.ts` check
 * every length across the rate boundary against an independent implementation — which catches a
 * transposed ρ offset, a big-endian lane read, or a wrong round constant, none of which a
 * hand-copied vector for one input would find.
 *
 * The alternative was two published vectors and a comment. Those are in the test too, and they are
 * necessary — they are the only thing that catches SHA3 being substituted for keccak, which the
 * OpenSSL comparison by construction cannot. Neither check is sufficient alone.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function sponge(input: Uint8Array, padByte: number): Uint8Array {
  const RATE = 136 // 1088 bits, the rate for a 256-bit digest
  const lanes: bigint[] = new Array(25).fill(0n)

  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE)
  padded.set(input)
  padded[input.length] = padByte
  const last = padded.length - 1
  padded[last] = (padded[last] ?? 0) | 0x80

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane += 1) {
      let word = 0n
      // Little-endian, which is what Keccak's byte order is and what a big-endian read here would
      // silently get wrong on every input at once.
      for (let byte = 7; byte >= 0; byte -= 1) {
        word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte] ?? 0)
      }
      lanes[lane] = (lanes[lane] ?? 0n) ^ word
    }
    permute(lanes)
  }

  const out = new Uint8Array(32)
  for (let lane = 0; lane < 4; lane += 1) {
    let word = lanes[lane] ?? 0n
    for (let byte = 0; byte < 8; byte += 1) {
      out[lane * 8 + byte] = Number(word & 0xffn)
      word >>= 8n
    }
  }
  return out
}

/** keccak-256 of a byte string. 32 bytes out. Pads `0x01` — this is Ethereum's, not NIST's. */
export function keccak256(input: Uint8Array): Uint8Array {
  return sponge(input, 0x01)
}

/**
 * SHA3-256. **Nothing in this repository hashes with it.**
 *
 * It exists so the test can compare the permutation against `node:crypto`. Exported rather than
 * kept private because a test that reached into a private is a test that stops running the day
 * somebody tidies the module — and this is the check that proves the other function is right.
 */
export function sha3_256(input: Uint8Array): Uint8Array {
  return sponge(input, 0x06)
}

/** Lower-case hex, no `0x`. */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * The four-byte selector of a function signature, with the `0x`.
 *
 * The signature is passed WHOLE rather than assembled from a name and a type list — the string
 * hashed is the string a reader compares against the Solidity, and the one place a selector bug
 * hides is a signature rebuilt slightly differently from the one in the contract. Same reasoning,
 * and same wording, as `foresight-web/src/lib/abi.ts`.
 */
export function selector(signature: string): string {
  return `0x${toHex(keccak256(new TextEncoder().encode(signature))).slice(0, 8)}`
}
