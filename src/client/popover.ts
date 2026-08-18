/** Minimal trigger geometry needed to place the loop-launch popover. */
export interface PopoverAnchor {
  top: number
  bottom: number
  left: number
}

/** Viewport dimensions used by the popover placement calculation. */
export interface PopoverViewport {
  width: number
  height: number
}

/** Fixed-position fields applied to the loop-launch popover. */
export interface PopoverPlacement {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
}

const EDGE_GAP = 12
const ANCHOR_GAP = 8
const PREFERRED_WIDTH = 320

/**
 * Place a popover within the viewport, using the roomier side of its trigger.
 *
 * @param anchor - Trigger bounds in viewport coordinates.
 * @param viewport - Current viewport dimensions.
 * @returns Fixed-position coordinates and the available scroll height.
 */
export function placePopover(anchor: PopoverAnchor, viewport: PopoverViewport): PopoverPlacement {
  const width = Math.max(0, Math.min(PREFERRED_WIDTH, viewport.width - EDGE_GAP * 2))
  const maxLeft = Math.max(EDGE_GAP, viewport.width - width - EDGE_GAP)
  const left = Math.min(Math.max(EDGE_GAP, anchor.left), maxLeft)
  const above = Math.max(0, anchor.top - ANCHOR_GAP - EDGE_GAP)
  const below = Math.max(0, viewport.height - anchor.bottom - ANCHOR_GAP - EDGE_GAP)

  if (above >= below) {
    return {
      left,
      width,
      maxHeight: above,
      bottom: viewport.height - anchor.top + ANCHOR_GAP,
    }
  }
  return {
    left,
    width,
    maxHeight: below,
    top: anchor.bottom + ANCHOR_GAP,
  }
}
