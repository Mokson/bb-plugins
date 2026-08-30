import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import { HoverPopover } from "../ui/HoverPopover";
import { parseSettings } from "../settings";
import type { RenderRow } from "../model/types";
import { Dossier } from "./Dossier";
import { useDossier } from "./useDossier";

/** B28: the backend fetch starts slightly before the popover opens. */
const FETCH_DELAY_MS = 200;
/** B26: "~250ms". */
const OPEN_DELAY_MS = 250;
/** B26: suppression outlasts the release, so a drag never ends in a popover. */
const RELEASE_DELAY_MS = 300;
/**
 * The pointer needs a moment to cross from the row onto the card. Closing on
 * the row's `pointerleave` alone unmounts the card before it can arrive, which
 * makes the error branch's Retry control unreachable.
 */
const CLOSE_GRACE_MS = 150;

/* -------------------------------------------------------------------------- */
/* B26 pointer suppression — one document-level pair of listeners for the list */
/* -------------------------------------------------------------------------- */

let suppressed = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
const suppressionListeners = new Set<() => void>();

function emitSuppression(): void {
  for (const listener of suppressionListeners) listener();
}

function handlePointerDown(): void {
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (suppressed) return;
  suppressed = true;
  emitSuppression();
}

function handlePointerUp(): void {
  if (releaseTimer !== null) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    suppressed = false;
    emitSuppression();
  }, RELEASE_DELAY_MS);
}

function subscribeToSuppression(listener: () => void): () => void {
  if (suppressionListeners.size === 0 && typeof document !== "undefined") {
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerUp, true);
  }
  suppressionListeners.add(listener);
  return () => {
    suppressionListeners.delete(listener);
    if (suppressionListeners.size > 0 || typeof document === "undefined") return;
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("pointerup", handlePointerUp, true);
    document.removeEventListener("pointercancel", handlePointerUp, true);
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
    suppressed = false;
  };
}

/** Test seam: the suppression state is module-level and outlives `cleanup()`. */
export function resetHoverSuppression(): void {
  if (releaseTimer !== null) clearTimeout(releaseTimer);
  releaseTimer = null;
  suppressed = false;
}

/* -------------------------------------------------------------------------- */

/**
 * B26-B32. The seam `ThreadRow` wraps its row content in.
 *
 * It takes the whole `RenderRow` rather than a bare id: the row already holds
 * the resolved title, the branch and the thread, so the dossier reads them
 * from here instead of re-subscribing to the entire thread list and scanning
 * it for one entry. `isCompactViewport` arrives the same way — it is a
 * thread-list slot prop the row already has, so B32 needs neither a context
 * nor a media query of its own.
 *
 * This component owns the row's box (`className` / `style`), because the
 * hover-intent handlers must sit on the element that also contains the row's
 * `absolute inset-0` anchor: the content above the anchor is
 * `pointer-events-none`, so a trigger wrapping the content alone would never
 * see the pointer.
 */
export function RowHover({
  row,
  isCompactViewport,
  className,
  style,
  children,
}: {
  row: RenderRow;
  isCompactViewport: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const threadId = row.thread.id;
  const { density } = parseSettings(useSettings().values);
  // B60: `compact` draws no hover card at any hover duration, which is also
  // what keeps it free of every backend RPC (B60.1). B62.2: the viewport gate
  // beside it is B32, a correctness rule, not a second preference.
  const enabled = !isCompactViewport && density !== "compact";

  const [hovering, setHovering] = useState(false);
  const isSuppressed = useSyncExternalStore(
    subscribeToSuppression,
    () => suppressed,
    () => false,
  );
  const [phase, setPhase] = useState<"idle" | "fetching" | "open">("idle");

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const enter = () => {
    cancelClose();
    setHovering(true);
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setHovering(false);
    }, CLOSE_GRACE_MS);
  };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!enabled || !hovering || isSuppressed) {
      setPhase("idle");
      return;
    }
    const fetchTimer = setTimeout(() => setPhase("fetching"), FETCH_DELAY_MS);
    const openTimer = setTimeout(() => setPhase("open"), OPEN_DELAY_MS);
    return () => {
      clearTimeout(fetchTimer);
      clearTimeout(openTimer);
    };
  }, [enabled, hovering, isSuppressed]);

  // The fetch gate stays here rather than inside the dossier — by the time a
  // payload is discarded the request is spent. `enabled` is part of it because
  // `compact` must reach no backend at all (B60.1).
  const state = useDossier(threadId, enabled && phase !== "idle");

  // B32: on a compact viewport the dossier does not render at any hover
  // duration, and no pointer handler — long-press or otherwise — is attached.
  if (!enabled) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  return (
    <HoverPopover
      open={phase === "open"}
      onOpenChange={(next) => {
        // Radix closes on pointer-down too. That is suppression, not a
        // departure — the pointer is still on the row, so hover intent must
        // survive it and re-arm once the release window elapses (B26).
        if (!next && !suppressed) setHovering(false);
      }}
      side="right"
      trigger={
        <div
          data-better-sidebar-hover-trigger={threadId}
          className={className}
          style={style}
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          {children}
        </div>
      }
    >
      {/* The card is part of the hover surface: without this the pointer can
          never reach the error branch's Retry button. */}
      <div onPointerEnter={enter} onPointerLeave={leave}>
        {/* B60: `default` and `detailed` both show the rich card. The
            `minimal` variant is the state the compression dropped; it stays
            available in `Dossier` for the settings level B60 offers to add
            back. */}
        <Dossier row={row} state={state} variant="rich" />
      </div>
    </HoverPopover>
  );
}
