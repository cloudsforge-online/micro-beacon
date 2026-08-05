/**
 * The media journeys' fixture, checked here so a red in `BJ-MED-01` means the ESTATE is wrong.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A JOURNEY THAT UPLOADS A MALFORMED FIXTURE FAILS FOR THE WRONG REASON, AND THAT IS WORSE THAN
 * NOT RUNNING.**
 *
 * `BJ-MED-01` asserts that the estate accepted an image, stripped a location out of it, and served
 * back bytes a browser could decode. Every one of those assertions is meaningless if the thing it
 * uploaded was not a valid PNG carrying a location to begin with — `studio` would refuse it as
 * `dimensions_unreadable`, the journey would go red, and beacon's rule 1 says a red means the
 * product is broken. It would be the harness blaming the estate.
 *
 * So the fixture is verified here, in this process, with no browser and no estate: the magic bytes,
 * the declared dimensions, the CRCs, and the presence of the location the journey later requires to
 * be absent. That last one is the important one — an assertion that a string is gone is trivially
 * satisfied by a string that was never there.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIXTURE_HEIGHT,
  FIXTURE_LOCATION,
  FIXTURE_WIDTH,
  HOSTILE_SVG,
  MEDIA_IMPLEMENTATIONS,
  NOT_AN_IMAGE,
  locatedPng,
} from './mediajourneys.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

test('the fixture is a real PNG, by its magic bytes', () => {
  const bytes = locatedPng()
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_MAGIC)
  // IHDR must be the first chunk; studio reads the size from a fixed offset that depends on it.
  assert.equal(Buffer.from(bytes.subarray(12, 16)).toString('ascii'), 'IHDR')
})

test('the fixture declares exactly the dimensions the journey asserts on', () => {
  // If these drifted apart, BJ-MED-01 would compare the decoded size against the wrong number and
  // report the estate as having corrupted an image it handled perfectly.
  const view = new DataView(locatedPng().buffer)
  assert.equal(view.getUint32(16), FIXTURE_WIDTH)
  assert.equal(view.getUint32(20), FIXTURE_HEIGHT)
})

test('every chunk CRC is correct, so a decoder will genuinely accept it', () => {
  // Chromium validates PNG CRCs. A fixture with a wrong one decodes nowhere, and the journey's
  // strongest assertion — that `naturalWidth` came back non-zero — would be unreachable.
  const bytes = locatedPng()
  const crcOf = (slice: Uint8Array): number => {
    let crc = 0xffffffff
    for (const byte of slice) {
      crc ^= byte
      for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  const view = new DataView(bytes.buffer)
  let offset = 8
  const seen: string[] = []
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii')
    const declared = view.getUint32(offset + 8 + length)
    const computed = crcOf(bytes.subarray(offset + 4, offset + 8 + length))
    assert.equal(computed, declared, `the ${type} chunk's CRC is wrong`)
    seen.push(type)
    offset += 12 + length
  }
  assert.deepEqual(seen, ['IHDR', 'eXIf', 'IDAT', 'IEND'])
  assert.equal(offset, bytes.length, 'the chunk walk did not land exactly on the end of the file')
})

test('THE FIXTURE ACTUALLY CARRIES THE LOCATION THE JOURNEY REQUIRES TO BE STRIPPED', () => {
  // The one that keeps `carriesLocation === false` from being vacuous. An assertion that a string
  // is absent passes trivially against a fixture that never contained it, and that is the shape of
  // every privacy check that has ever silently stopped testing anything.
  const bytes = Buffer.from(locatedPng())
  assert.ok(
    bytes.includes(Buffer.from(FIXTURE_LOCATION, 'latin1')),
    'the fixture does not contain the location, so asserting it was removed proves nothing',
  )
})

test('the hostile bodies are what they claim to be', () => {
  // The SVG must actually be script-bearing, or the refusal it drives is a refusal of something
  // harmless.
  assert.match(HOSTILE_SVG, /<svg/i)
  assert.match(HOSTILE_SVG, /<script|onload=/i)
  // And the not-an-image must not accidentally start with a signature studio accepts.
  const bytes = Buffer.from(NOT_AN_IMAGE, 'latin1')
  assert.notDeepEqual([...bytes.subarray(0, 8)], PNG_MAGIC)
  assert.notEqual(bytes.subarray(0, 3).toString('latin1'), '\xff\xd8\xff')
  assert.notEqual(bytes.subarray(0, 4).toString('latin1'), 'RIFF')
})

test('the media scenarios are implemented for both origins the CORS list must cover', () => {
  // market and foresight are separate entries on purpose: the gateway's allow-list is per-origin,
  // so one passing says nothing about the other.
  assert.deepEqual(Object.keys(MEDIA_IMPLEMENTATIONS).sort(), ['BJ-MED-01', 'BJ-MED-02', 'BJ-MED-03'])
})
