import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FrozenOrder,
  GroupBy,
  ListModel,
  SecondRowMode,
  SectionKey,
} from "./model/types";

/** §4: how long the order stays pinned after the pointer leaves the list. */
const COOLDOWN_MS = 2000;

type FreezeState = "LIVE" | "FROZEN" | "COOLDOWN";

/** The inputs whose change means the user asked for a different order (§4). */
export interface FreezeInvalidators {
  readonly searchQuery: string;
  readonly groupBy: GroupBy;
  readonly secondRow: SecondRowMode;
}

export interface FreezeHandle {
  /** Passed straight into `buildListModel`; null means "render live". */
  readonly frozen: FrozenOrder | null;
  /**
   * Called with the model of the current render. While LIVE it records the
   * sequence a later freeze will pin; while frozen it is a no-op, because the
   * model it would record is already the pinned one.
   */
  observe: (model: ListModel) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Drops the snapshot now — an invalidator, or a thread about to be opened. */
  release: () => void;
}

/**
 * B6's freeze, as an explicit three-state machine over one plain-data snapshot.
 *
 * The snapshot pins the **whole rendered sequence**, never one section at a
 * time: a newcomer that extends the top section would otherwise push every row
 * of every lower section down while the pointer is still aimed at one, which is
 * the exact movement B6 exists to forbid. `FrozenOrder` stays plain data so the
 * model remains a pure function and the hard part is unit-testable without a DOM.
 *
 * `COOLDOWN → FROZEN` deliberately keeps the *old* snapshot. Re-capturing on
 * re-entry would let every reorder that happened during the 2s gap land at the
 * instant the pointer comes back — the same jump, merely deferred.
 */
export function useFreeze(invalidators: FreezeInvalidators): FreezeHandle {
  const [frozen, setFrozen] = useState<FrozenOrder | null>(null);
  // FROZEN and COOLDOWN both hold a snapshot, so `frozen` alone cannot tell
  // them apart; the phase is a ref because nothing renders differently for it.
  const stateRef = useRef<FreezeState>("LIVE");
  const liveOrderRef = useRef<FrozenOrder | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const release = useCallback(() => {
    clearTimer();
    stateRef.current = "LIVE";
    setFrozen(null);
  }, [clearTimer]);

  const observe = useCallback((model: ListModel) => {
    if (stateRef.current !== "LIVE") return;
    liveOrderRef.current = snapshot(model);
  }, []);

  const onPointerEnter = useCallback(() => {
    clearTimer();
    const wasCooling = stateRef.current === "COOLDOWN";
    stateRef.current = "FROZEN";
    // Re-entry from COOLDOWN keeps the snapshot it already holds.
    if (!wasCooling) setFrozen(liveOrderRef.current);
  }, [clearTimer]);

  const onPointerLeave = useCallback(() => {
    if (stateRef.current !== "FROZEN") return;
    stateRef.current = "COOLDOWN";
    clearTimer();
    timerRef.current = window.setTimeout(release, COOLDOWN_MS);
  }, [clearTimer, release]);

  // Any of these means the order the user was aiming at is no longer the order
  // they asked for, so the snapshot is dropped immediately rather than aged out.
  useEffect(() => {
    release();
  }, [invalidators.searchQuery, invalidators.groupBy, invalidators.secondRow, release]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [release]);

  useEffect(() => clearTimer, [clearTimer]);

  return { frozen, observe, onPointerEnter, onPointerLeave, release };
}

/** Flattens the rendered model into the sequence a freeze pins (§4). */
function snapshot(model: ListModel): FrozenOrder {
  const ids: string[] = [];
  const sectionOf: Record<string, SectionKey> = {};
  for (const section of model.sections) {
    for (const row of section.rows) {
      ids.push(row.thread.id);
      sectionOf[row.thread.id] = section.key;
    }
  }
  return { ids, sectionOf, sectionOrder: model.sections.map((section) => section.key) };
}
