// The one `keydown` listener the watch pages share.
//
// The map itself is pure data in `keys.ts`; this file is only the wiring:
// attach once, ignore keystrokes that belong to a text box, and always detach.
// Sharing it means the inbox and the stall monitor cannot end up with two
// slightly different notions of what `j` does.
import { useEffect, useRef } from "react";
import { isTypingTarget, resolveKey, type KeyAction } from "./keys.js";

/**
 * Route panel keystrokes to `onAction` for as long as the component is
 * mounted.
 *
 * `onAction` is read through a ref so a caller may pass an inline closure
 * without re-attaching the listener on every render - re-attaching would drop
 * a half-typed `g` sequence whenever any state changed.
 */
export function usePanelKeys(onAction: (action: KeyAction) => void): void {
  const handler = useRef(onAction);
  handler.current = onAction;

  useEffect(() => {
    const pending = { goto: false };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Escape still reaches the panel from inside the filter box: that is how
      // the reader gets back out of it.
      if (isTypingTarget(event.target) && event.key !== "Escape") return;

      const resolved = resolveKey(event.key, pending.goto);
      pending.goto = resolved.pendingGoto;
      if (resolved.action === null) {
        // A `g` must not also type a `g` into whatever is focused next.
        if (resolved.pendingGoto) event.preventDefault();
        return;
      }
      event.preventDefault();
      handler.current(resolved.action);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
