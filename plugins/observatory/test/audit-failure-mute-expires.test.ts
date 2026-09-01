import { afterEach, beforeEach, expect, test } from "vitest";
import { failureRows, muteFailure } from "../src/audit/failures.js";
import { TempDatabase } from "./fakes.js";

let temp!: TempDatabase;
beforeEach(() => {
  temp = new TempDatabase();
});
afterEach(() => temp.dispose());

const NOW = new Date("2026-09-01T12:00:00.000Z");

function seed() {
  const store = temp.open();
  store.upsertThread({ thread_id: "t1" });
  store.upsertTurn({
    thread_id: "t1",
    turn_id: "u1",
    completed_at: "2026-09-01T11:00:00.000Z",
    error_category: "provider-error",
    model_reported: "claude-opus-5",
  });
  return { store, deps: { db: store.db, store, now: () => NOW } };
}

test("a muted signature is hidden until its expiry and loud again after it", () => {
  const { store, deps } = seed();
  const [row] = failureRows(deps, { range: "7d" });
  expect(row).toBeDefined();

  muteFailure(store, row!.signature, "2026-09-01T18:00:00.000Z");
  expect(failureRows(deps, { range: "7d" })).toHaveLength(0);

  // Still listed when asked for explicitly, so a mute is never invisible.
  const withMuted = failureRows(deps, { range: "7d", includeMuted: true });
  expect(withMuted[0]?.muted).toBe(true);
  expect(withMuted[0]?.mutedUntil).toBe("2026-09-01T18:00:00.000Z");

  muteFailure(store, row!.signature, "2026-08-31T18:00:00.000Z");
  const afterExpiry = failureRows(deps, { range: "7d" });
  expect(afterExpiry).toHaveLength(1);
  expect(afterExpiry[0]?.muted).toBe(false);
});
