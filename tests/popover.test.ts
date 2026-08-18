import assert from 'node:assert/strict'
import test from 'node:test'
import { placePopover } from '../src/client/popover.ts'

test('launch popover stays inside a short English-layout viewport', () => {
  const placement = placePopover(
    { top: 582, bottom: 610, left: 35 },
    { width: 376, height: 648 },
  )

  assert.deepEqual(placement, {
    left: 35,
    width: 320,
    maxHeight: 562,
    bottom: 74,
  })
  assert.equal(648 - placement.bottom! - placement.maxHeight, 12)
})

test('launch popover clamps its width and horizontal position on narrow screens', () => {
  const placement = placePopover(
    { top: 500, bottom: 528, left: 70 },
    { width: 320, height: 568 },
  )

  assert.equal(placement.left, 12)
  assert.equal(placement.width, 296)
})

test('launch popover opens below the trigger when that side has more room', () => {
  const placement = placePopover(
    { top: 12, bottom: 40, left: 24 },
    { width: 800, height: 648 },
  )

  assert.deepEqual(placement, {
    left: 24,
    width: 320,
    maxHeight: 588,
    top: 48,
  })
})
