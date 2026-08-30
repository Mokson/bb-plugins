import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import { HoverPopover } from "../ui/HoverPopover";
import { parseSettings } from "../settings";
import { Dossier } from "./Dossier";
import { useDossier } from "./useDossier";

/** B28: the backend fetch starts slightly before the popover opens. */
const FETCH_DELAY_MS = 200;
/** B26: "~250ms". */
const OPEN_DELAY_MS = 250;
/** B26: suppression outlasts the release, so a drag never ends in a popover. */
const RELEASE_DELAY_MS = 300;

/**
 * `isCompactViewport` is a thread-list slot prop and `RowHover`'s signature is
 * fixed at `{threadId, children}`, so the list passes it down through this
 * context. With no provider the hook falls back to the same media query the
 * host describes the prop with, which keeps B32 true either way.
 */
const CompactViewportContext = createContext<boolean | null>(null);

export function CompactViewportProvider({
  isCompactViewport,
  children,
}: {
  isCompactViewport: boolean;
  children: ReactNode;
}) {
  return (
    <CompactViewportContext.Provider value={isCompactViewport}>
      {children}
    </CompactViewportContext.Provider>
  );
}

/** The host's own words for `isCompactViewport`, as a media query. */
const COMPACT_QUERY = "(max-width: 768px), (pointer: coarse)";

function matchCompact(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(COMPACT_QUERY)
    : null;
}

function subscribeToCompact(listener: () => void): () => void {
  const list = matchCompact();
  if (list === null) return () => {};
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

function useIsCompactViewport(): boolean {
  const provided = useContext(CompactViewportContext);
  const matches = useSyncExternalStore(
    subscribeToCompact,
    () => matchCompact()?.matches ?? false,
    () => false,
  );
  return provided ?? matches;
}

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
 * B26-B32. The seam slice 3's `ThreadRow` wraps its row content in. Everything
 * about hover intent, pointer suppression, the popover and its placement lives
 * behind this one component, so no other slice's file learns about the dossier.
 */
export function RowHover({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  const isCompactViewport = useIsCompactViewport();
  const { tooltip } = parseSettings(useSettings().values);
  const enabled = !isCompactViewport && tooltip !== "off";

  const [hovering, setHovering] = useState(false);
  const isSuppressed = useSyncExternalStore(
    subscribeToSuppression,
    () => suppressed,
    () => false,
  );
  const [phase, setPhase] = useState<"idle" | "fetching" | "open">("idle");

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

  const state = useDossier(threadId, phase !== "idle");

  // B32: on a compact viewport the dossier does not render at any hover
  // duration, and no pointer handler — long-press or otherwise — is attached.
  if (!enabled) return <>{children}</>;

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
          onPointerEnter={() => setHovering(true)}
          onPointerLeave={() => setHovering(false)}
        >
          {children}
        </div>
      }
    >
      <Dossier
        threadId={threadId}
        state={state}
        variant={tooltip === "minimal" ? "minimal" : "rich"}
      />
    </HoverPopover>
  );
}
