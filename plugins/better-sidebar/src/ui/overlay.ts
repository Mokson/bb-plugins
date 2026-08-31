/**
 * Keeps every edge of a floating surface off every edge of the viewport
 * (B79.1). Shared by the display menu and the child-threads popover, so
 * overlays clear the window edge alike.
 */
export const COLLISION_PADDING = 8;
