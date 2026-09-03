import {
  useEffect,
  useRef,
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
const FETCH_DELAY_MS = 850;
/**
 * B26 said "~250ms". Raised twice since: 250ms fired the card while the
 * pointer merely crossed a row, and 600ms still fired while scanning the list
 * rather than settling on a thread.
 */
const OPEN_DELAY_MS = 900;
/** B26: suppression outlasts the release, so a drag never ends in a popover. */
const RELEASE_DELAY_MS = 300;
/**
 * The pointer needs a moment to cross from the row onto the card. Closing on
 * the row's `pointerleave` alone unmounts the card before it can arrive, which
 * makes the error branch's Retry control unreachable.
 */
const CLOSE_GRACE_MS = 150;

/* -------------------------------------------------------------------------- */
/* Hover intent — ONE store for the whole list, not per-row component state.   */
/* -------------------------------------------------------------------------- */

/**
 * There is one pointer, so there is one hovered row and one card. Holding that
 * in the row's own `useState` looked equivalent and was not: `ThreadList`
 * renders rows keyed by thread id but nested inside `<section key=...>`, so a
 * thread that CHANGES SECTION is unmounted from the old section and mounted
 * fresh in the new one. Any activity that moves a row — the agent asking a
 * question hoists it into NEEDS YOU, finishing moves it into DONE, a status
 * group changes under it — therefore threw away the hover state of the very
 * row the user was reading, and the card vanished under the pointer.
 *
 * Module state survives that remount, so the card does not care where in the
 * list its row currently lives.
 */
type Phase = "idle" | "fetching" | "open";

interface HoverState {
  /** The row the pointer is on, or null. */
  readonly threadId: string | null;
  readonly phase: Phase;
}

const IDLE: HoverState = { threadId: null, phase: "idle" };
let hoverState: HoverState = IDLE;

/** B26: a drag suppresses the card; leaving the action buttons re-arms it. */
let suppressed = false;
/**
 * Round-2 L1: one hold count per suppression handle, not one module boolean.
 * The old flag was module-global: a row that unmounted while its menu was
 * open cleared suppression another row still owned. Holds are counted per
 * handle (pointer-enter and menu-open each hold one), the card is suppressed
 * while ANY handle holds any, and unmount releases everything its handle
 * still owns — clearing happens only at zero.
 */
const overActionHolds = new Map<object, number>();

function isOverActions(): boolean {
  return overActionHolds.size > 0;
}

let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setHoverState(next: HoverState): void {
  if (next.threadId === hoverState.threadId && next.phase === hoverState.phase) {
    return;
  }
  hoverState = next;
  emit();
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

function stopPhaseTimers(): void {
  fetchTimer = clearTimer(fetchTimer);
  openTimer = clearTimer(openTimer);
}

/**
 * Re-arms the open delay for whichever row is hovered. Called on entry and
 * whenever a suppression lifts, so leaving the action cluster for the row body
 * waits out a fresh delay rather than snapping the card open.
 */
function armPhase(): void {
  stopPhaseTimers();
  const threadId = hoverState.threadId;
  setHoverState({ threadId, phase: "idle" });
  if (threadId === null || suppressed || isOverActions()) return;
  fetchTimer = setTimeout(() => {
    fetchTimer = null;
    setHoverState({ threadId: hoverState.threadId, phase: "fetching" });
  }, FETCH_DELAY_MS);
  openTimer = setTimeout(() => {
    openTimer = null;
    setHoverState({ threadId: hoverState.threadId, phase: "open" });
  }, OPEN_DELAY_MS);
}

function beginHover(threadId: string): void {
  closeTimer = clearTimer(closeTimer);
  // Re-entering the row the card already belongs to must not restart its
  // delay — that is what makes the pointer's trip onto the card survivable.
  if (hoverState.threadId === threadId) return;
  stopPhaseTimers();
  // Assign through `setHoverState` so subscribers learn about the new row at
  // hover time. Writing the field directly first made the store equal to the
  // value `armPhase` was about to set, which suppressed the notification and
  // left React a whole fetch delay behind the pointer.
  setHoverState({ threadId, phase: "idle" });
  armPhase();
}

function endHover(threadId: string): void {
  if (hoverState.threadId !== threadId) return;
  closeTimer = clearTimer(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    closeHover();
  }, CLOSE_GRACE_MS);
}

function closeHover(): void {
  closeTimer = clearTimer(closeTimer);
  stopPhaseTimers();
  setHoverState(IDLE);
}

function setOverActionsFor(holder: object, next: boolean): void {
  const wasSuppressed = isOverActions();
  if (next) {
    overActionHolds.set(holder, (overActionHolds.get(holder) ?? 0) + 1);
  } else {
    const remaining = (overActionHolds.get(holder) ?? 0) - 1;
    if (remaining <= 0) overActionHolds.delete(holder);
    else overActionHolds.set(holder, remaining);
  }
  // Re-arm only on a transition: every hold/release between would restart the
  // open delay under a pointer that never moved.
  if (isOverActions() !== wasSuppressed) armPhase();
}

/* -------------------------------------------------------------------------- */
/* Document listeners: one set for the list, mounted only while rows are up.   */
/* -------------------------------------------------------------------------- */

function handlePointerDown(): void {
  releaseTimer = clearTimer(releaseTimer);
  if (suppressed) return;
  suppressed = true;
  armPhase();
}

function handlePointerUp(): void {
  releaseTimer = clearTimer(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    suppressed = false;
    armPhase();
  }, RELEASE_DELAY_MS);
}

/**
 * `pointerleave` fires only when the pointer crosses the trigger's boundary,
 * so it is missed whenever the ROW leaves the POINTER: the list reorders, a
 * section collapses, the sidebar scrolls. Without this the card would stay
 * open with nothing left to close it.
 *
 * Containment is checked against the live DOM rather than a React ref, so it
 * keeps working across the remount this store exists to survive.
 */
function isInsideHoverSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Read the id off the ancestor rather than building a selector from it: a
  // thread id is not guaranteed to be a valid CSS identifier.
  const trigger = target.closest("[data-better-sidebar-hover-trigger]");
  if (
    trigger !== null &&
    trigger.getAttribute("data-better-sidebar-hover-trigger") ===
      hoverState.threadId
  ) {
    return true;
  }
  return target.closest("[data-better-sidebar-dossier]") !== null;
}

function handlePointerMove(event: PointerEvent): void {
  const threadId = hoverState.threadId;
  if (threadId === null) return;
  if (isInsideHoverSurface(event.target)) return;
  // Schedule, never re-schedule: a pending timer is already the departure that
  // `pointerleave` reported, and restarting it on every move outside would
  // hold the card open for as long as the pointer keeps moving.
  if (closeTimer !== null) return;
  endHover(threadId);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof document !== "undefined") {
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerUp, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    // Neither moves a pointer, so `handlePointerMove` cannot catch them.
    window.addEventListener("scroll", closeHover, true);
    window.addEventListener("blur", closeHover);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || typeof document === "undefined") return;
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("pointerup", handlePointerUp, true);
    document.removeEventListener("pointercancel", handlePointerUp, true);
    document.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("scroll", closeHover, true);
    window.removeEventListener("blur", closeHover);
    resetHoverSuppression();
  };
}

/** Test seam: every field above is module state and outlives `cleanup()`. */
export function resetHoverSuppression(): void {
  fetchTimer = clearTimer(fetchTimer);
  openTimer = clearTimer(openTimer);
  closeTimer = clearTimer(closeTimer);
  releaseTimer = clearTimer(releaseTimer);
  suppressed = false;
  overActionHolds.clear();
  hoverState = IDLE;
}

/**
 * Set by whatever inside the row must not be covered by the dossier — today
 * the hover action cluster, which occupies the same right edge the card would
 * open over. It gates the phase rather than clearing the hovered row, so
 * leaving the buttons re-arms the open delay instead of needing a fresh
 * boundary crossing.
 */
export function useRowHoverSuppression(): (next: boolean) => void {
  const holderRef = useRef<object | null>(null);
  if (holderRef.current === null) holderRef.current = {};
  const holder = holderRef.current;
  const setterRef = useRef<((next: boolean) => void) | null>(null);
  if (setterRef.current === null) {
    setterRef.current = (next: boolean) => setOverActionsFor(holder, next);
  }
  // L1: unmount releases everything this handle still holds (a section move
  // under an open menu), so a dying row never strands — or clears — another
  // row's suppression. The caller's own close/unmount decrement stays valid:
  // it runs before this and simply decrements first.
  useEffect(
    () => () => {
      if (!overActionHolds.has(holder)) return;
      overActionHolds.delete(holder);
      if (!isOverActions()) armPhase();
    },
    [holder],
  );
  return setterRef.current;
}

function useHoverState(): HoverState {
  return useSyncExternalStore(
    subscribe,
    () => hoverState,
    () => IDLE,
  );
}

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

  const hover = useHoverState();
  const phase = hover.threadId === threadId ? hover.phase : "idle";

  const enter = () => beginHover(threadId);
  const leave = () => endHover(threadId);

  // The fetch gate stays here rather than inside the dossier — by the time a
  // payload is discarded the request is spent. `enabled` is part of it because
  // `compact` must reach no backend at all (B60.1).
  const dossier = useDossier(threadId, enabled && phase !== "idle");

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
        if (next) return;
        // Radix closes on pointer-down too. That is suppression, not a
        // departure — the pointer is still on the row, so hover intent must
        // survive it and re-arm once the release window elapses (B26).
        if (suppressed) return;
        // Radix also reports a close when the pointer has already moved to
        // the NEXT row: that row has taken the store over, and honouring this
        // close would wipe its freshly started hover. A row may only close
        // the card it still owns.
        if (hoverState.threadId !== threadId) return;
        closeHover();
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
        <Dossier row={row} state={dossier} variant="rich" />
      </div>
    </HoverPopover>
  );
}
