import { describe, expect, it } from "vitest";
import {
  BUCKET_JUMP_BINDINGS,
  matchBucketJump,
  nextSectionIndex,
} from "./bucketJump";

function event(overrides: { key: string; altKey?: boolean; ctrlKey?: boolean }) {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("BUCKET_JUMP_BINDINGS", () => {
  // B42's §7 ruling: effective host bindings are user-configurable
  // server-side and unreadable from a plugin, so collision-freedom is
  // guaranteed by construction and this is the property that proves it.
  it("qualifies every binding with a modifier", () => {
    expect(BUCKET_JUMP_BINDINGS.length).toBeGreaterThan(0);
    for (const binding of BUCKET_JUMP_BINDINGS) {
      expect(binding.modifiers.length).toBeGreaterThan(0);
    }
  });

  it("contains no bare alphanumeric key", () => {
    for (const binding of BUCKET_JUMP_BINDINGS) {
      expect(binding.key).not.toMatch(/^[a-zA-Z0-9]$/);
    }
  });

  it("binds both directions exactly once", () => {
    expect(BUCKET_JUMP_BINDINGS.map((b) => b.direction).sort()).toEqual([
      "next",
      "previous",
    ]);
  });
});

describe("matchBucketJump", () => {
  it("matches Alt+Arrow in both directions", () => {
    expect(matchBucketJump(event({ key: "ArrowUp", altKey: true }))).toBe(
      "previous",
    );
    expect(matchBucketJump(event({ key: "ArrowDown", altKey: true }))).toBe(
      "next",
    );
  });

  it("ignores the unmodified arrows and extra modifiers", () => {
    expect(matchBucketJump(event({ key: "ArrowUp" }))).toBeNull();
    expect(
      matchBucketJump(event({ key: "ArrowUp", altKey: true, ctrlKey: true })),
    ).toBeNull();
    expect(matchBucketJump(event({ key: "j", altKey: true }))).toBeNull();
  });
});

describe("nextSectionIndex", () => {
  it("steps one section at a time", () => {
    expect(nextSectionIndex(1, "next", 4)).toBe(2);
    expect(nextSectionIndex(1, "previous", 4)).toBe(0);
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(nextSectionIndex(3, "next", 4)).toBe(3);
    expect(nextSectionIndex(0, "previous", 4)).toBe(0);
  });

  it("enters from nothing selected at the matching end", () => {
    expect(nextSectionIndex(-1, "next", 4)).toBe(0);
    expect(nextSectionIndex(-1, "previous", 4)).toBe(3);
  });

  it("returns -1 when there is no section to land on", () => {
    expect(nextSectionIndex(0, "next", 0)).toBe(-1);
  });
});
