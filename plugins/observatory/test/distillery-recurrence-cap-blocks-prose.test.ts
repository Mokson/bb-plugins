// gc.md 3a: a row on its SECOND recurrence may not be re-adopted as prose.
//
// The rule exists because a repeated failure has already proven that a
// sentence did not prevent it. Blocking at apply — rather than at drafting —
// is deliberate: the draft is still worth reading, and the person acting on it
// is the one who can reclassify it to a mechanical carrier.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECURRENCE_CAP, applyBlockReason, applyDraft } from "../src/distillery/apply.js";
import { PROSE_RUNG } from "../src/distillery/contract.js";
import type { DraftView } from "../src/distillery/contract.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function draft(rung: number | null, recurrence: number): DraftView {
  return {
    id: "d1",
    clusterId: "c1",
    state: "accepted",
    homeFile: "~/.agents/skills/deliver/craft.md",
    rung: rung as DraftView["rung"],
    patchUnifiedDiff: null,
    ruleText: "Remember to check the thing.",
    successSignal: "fewer breaches",
    rationale: "seen repeatedly",
    evidenceIds: [],
    recurrence,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    appliedPath: null,
    threadId: null,
  };
}

describe("the recurrence cap blocks a prose adoption at recurrence 2", () => {
  it("allows prose on a first occurrence", () => {
    expect(applyBlockReason(draft(PROSE_RUNG, 1))).toBeNull();
  });

  it("blocks prose at recurrence 2 and names the mechanical rungs", () => {
    const blocked = applyBlockReason(draft(PROSE_RUNG, RECURRENCE_CAP));
    expect(blocked).toBeTruthy();
    expect(blocked).toMatch(/recurrence cap/);
    // The message has to be actionable: it names the carriers to move to.
    expect(blocked).toMatch(/rung 3/);
    expect(blocked).toMatch(/rung 5/);
    expect(blocked).toMatch(/rung 6/);
  });

  it("blocks prose beyond the cap too", () => {
    expect(applyBlockReason(draft(PROSE_RUNG, 7))).toMatch(/recurrence cap/);
  });

  it("allows a mechanical rung at the same recurrence", () => {
    // The cap is about the CARRIER, not the recurrence: the same evidence at
    // rung 3 is exactly the reclassification the rule is asking for.
    for (const rung of [2, 3, 4, 5, 6]) {
      expect(applyBlockReason(draft(rung, RECURRENCE_CAP))).toBeNull();
    }
  });

  it("writes nothing to disk when it blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "distillery-cap-"));
    dirs.push(root);
    const improvements = join(root, "improvements");
    mkdirSync(improvements, { recursive: true });

    const result = applyDraft(
      {
        improvementsDir: improvements,
        appendFindings: false,
        now: () => new Date("2026-09-01T12:00:00Z"),
      },
      draft(PROSE_RUNG, RECURRENCE_CAP),
      null,
      [],
    );

    expect(result.blocked).toMatch(/recurrence cap/);
    expect(result.writtenPath).toBeNull();
    // A blocked apply is not a partial apply.
    expect(readdirSync(improvements)).toHaveLength(0);
  });
});
