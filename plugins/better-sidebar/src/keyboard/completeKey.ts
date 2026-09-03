/**
 * The mark-completed shortcut (B86.6).
 *
 * Same construction rule as `bucketJump`: bb's own sidebar bindings are
 * configurable server-side and unreadable from a plugin, so collision-freedom
 * is guaranteed by every binding here being modifier-qualified rather than by a
 * test against a table we cannot see. The table is exported as data so that
 * property is assertable.
 *
 * `Alt+D` and not a bare `D`: the list is a focusable region, and an
 * unmodified letter there would fight anything the host binds to typing.
 */
export interface CompleteBinding {
  /** `KeyboardEvent.key`, matched case-insensitively. */
  readonly key: string;
  /** At least one entry, or the binding is not collision-free by construction. */
  readonly modifiers: readonly "Alt"[];
  readonly label: string;
}

export const COMPLETE_BINDING: CompleteBinding = {
  key: "d",
  modifiers: ["Alt"],
  label: "Alt+D",
};

/** The event shape a binding is matched against — a `KeyboardEvent` subset. */
export interface CompleteKeyEvent {
  key: string;
  /** The physical key, which the Option layer does not rewrite. */
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * True when `event` asks to toggle the focused row's completed flag.
 *
 * BOTH `key` and `code` are accepted. On macOS the Option layer rewrites the
 * character — `Alt+D` arrives as `key: "∂"` — so matching the letter alone
 * would leave the shortcut dead on the platform bb runs on. `code` carries the
 * physical key through that, and `key` still covers the layouts where `code`
 * names a different letter than the one the user actually pressed.
 */
export function matchCompleteKey(event: CompleteKeyEvent): boolean {
  const pressedD =
    event.key.toLowerCase() === COMPLETE_BINDING.key || event.code === "KeyD";
  return (
    pressedD &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}
