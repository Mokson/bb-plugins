// The panel's keyboard map, as data plus one pure resolver.
//
// Two-key `g` sequences need a tiny state machine, and a state machine buried
// in a `keydown` closure is untestable and drifts from the `?` sheet that
// documents it. So the map is a table, the transition is a function of
// (key, pending), and the sheet renders the same table the resolver reads.

/** Where each second key of a `g` sequence goes, as a panel `subPath`. */
export const GOTO_ROUTES: Record<string, string> = {
  c: "cost",
  s: "stalls",
  x: "context",
  a: "audit",
  e: "eval",
  d: "distillery",
};

export type KeyAction =
  | { kind: "navigate"; route: string }
  | { kind: "focus-filter" }
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "activate" }
  | { kind: "dismiss" }
  | { kind: "toggle-help" };

/** What one keystroke did: the action to run, and the next pending state. */
export interface KeyResolution {
  action: KeyAction | null;
  /** True when the next keystroke is the second half of a `g` sequence. */
  pendingGoto: boolean;
}

/**
 * Resolve one keystroke.
 *
 * An unrecognised key while a `g` is pending cancels the sequence rather than
 * holding it: a reader who typed `g` and then something else has changed their
 * mind, and a sequence that survives across unrelated keys fires surprise
 * navigations minutes later.
 */
export function resolveKey(key: string, pendingGoto: boolean): KeyResolution {
  if (pendingGoto) {
    const route = GOTO_ROUTES[key.toLowerCase()];
    if (route === undefined) return { action: null, pendingGoto: false };
    return { action: { kind: "navigate", route }, pendingGoto: false };
  }

  switch (key) {
    case "g":
    case "G":
      return { action: null, pendingGoto: true };
    case "/":
      return { action: { kind: "focus-filter" }, pendingGoto: false };
    case "j":
      return { action: { kind: "move", delta: 1 }, pendingGoto: false };
    case "k":
      return { action: { kind: "move", delta: -1 }, pendingGoto: false };
    case "Enter":
      return { action: { kind: "activate" }, pendingGoto: false };
    case "Escape":
      return { action: { kind: "dismiss" }, pendingGoto: false };
    case "?":
      return { action: { kind: "toggle-help" }, pendingGoto: false };
    default:
      return { action: null, pendingGoto: false };
  }
}

/** The `?` sheet, and the only description of the map a reader sees. */
export const KEY_HELP: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: "g c", does: "cost" },
  { keys: "g s", does: "stalls" },
  { keys: "g x", does: "context" },
  { keys: "g a", does: "audit" },
  { keys: "g e", does: "eval" },
  { keys: "g d", does: "distillery" },
  { keys: "/", does: "focus the filter" },
  { keys: "j k", does: "move down and up the list" },
  { keys: "Enter", does: "open the selected row" },
  { keys: "Esc", does: "leave the filter, clear the selection" },
  { keys: "?", does: "this sheet" },
];

/**
 * Whether a keystroke on this element belongs to the element, not the panel.
 *
 * Without it `/` would be swallowed while the reader types a filter, and `j`
 * would jump the list from inside a text box.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
