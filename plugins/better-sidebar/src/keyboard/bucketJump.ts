/**
 * Bucket-jump shortcuts (B42).
 *
 * The effective key bindings of bb's own sidebar commands are configurable
 * server-side and are not readable from a plugin, so collision-freedom cannot
 * be tested against them. It is instead guaranteed **by construction**: every
 * binding below is modifier-qualified and none is a bare alphanumeric key —
 * the same `Alt+Arrow` idiom `bb-tinted-threads` uses for row reorder. The
 * table is exported as data so that property is assertable.
 */

export type JumpDirection = "next" | "previous";

export interface BucketJumpBinding {
  /** Which way the selection moves through the section headers. */
  readonly direction: JumpDirection;
  /** `KeyboardEvent.key`, never a bare alphanumeric. */
  readonly key: string;
  /** At least one entry, or the binding is not collision-free by construction. */
  readonly modifiers: readonly "Alt"[];
  /** Human-readable form for menus and docs. */
  readonly label: string;
}

export const BUCKET_JUMP_BINDINGS: readonly BucketJumpBinding[] = [
  {
    direction: "previous",
    key: "ArrowUp",
    modifiers: ["Alt"],
    label: "Alt+ArrowUp",
  },
  {
    direction: "next",
    key: "ArrowDown",
    modifiers: ["Alt"],
    label: "Alt+ArrowDown",
  },
];

/** The event shape a binding is matched against — a `KeyboardEvent` subset. */
export interface BucketJumpEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * The direction `event` requests, or null when it matches no binding. A
 * binding matches only when its modifiers are held and no other modifier is.
 */
export function matchBucketJump(event: BucketJumpEvent): JumpDirection | null {
  const binding = BUCKET_JUMP_BINDINGS.find(
    (candidate) =>
      candidate.key === event.key &&
      // Every modifier in the table is `Alt` at the type level, and no other
      // modifier may be held, or the chord belongs to some other command.
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey,
  );
  return binding?.direction ?? null;
}

/**
 * The section index a jump lands on, clamped at both ends so the first and
 * last sections are terminals rather than wrapping. Returns -1 when there is
 * no section to land on.
 */
export function nextSectionIndex(
  current: number,
  direction: JumpDirection,
  sectionCount: number,
): number {
  if (sectionCount <= 0) return -1;
  const step = direction === "next" ? 1 : -1;
  const from = current < 0 ? (direction === "next" ? -1 : sectionCount) : current;
  return Math.min(Math.max(from + step, 0), sectionCount - 1);
}
