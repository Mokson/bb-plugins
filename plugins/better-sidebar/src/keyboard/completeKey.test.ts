import { describe, expect, it } from "vitest";
import {
  COMPLETE_BINDING,
  matchCompleteKey,
  type CompleteKeyEvent,
} from "./completeKey";

function event(overrides: Partial<CompleteKeyEvent> = {}): CompleteKeyEvent {
  return {
    key: "d",
    code: "KeyD",
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("mark-completed shortcut (B86.6)", () => {
  it("is modifier-qualified, which is what makes it collision-free", () => {
    expect(COMPLETE_BINDING.modifiers).toContain("Alt");
    expect(COMPLETE_BINDING.modifiers.length).toBeGreaterThan(0);
  });

  it("matches Alt+D", () => {
    expect(matchCompleteKey(event())).toBe(true);
  });

  it("matches when macOS rewrites the character to the Option layer's glyph", () => {
    // This is the case that matters on the platform bb runs on: `key` is `∂`.
    expect(matchCompleteKey(event({ key: "∂" }))).toBe(true);
  });

  it("matches on the letter when the layout names a different physical key", () => {
    expect(matchCompleteKey(event({ code: "KeyE" }))).toBe(true);
  });

  it("ignores D without Alt, so typing never files a thread", () => {
    expect(matchCompleteKey(event({ altKey: false }))).toBe(false);
  });

  it("ignores a chord carrying any other modifier", () => {
    expect(matchCompleteKey(event({ ctrlKey: true }))).toBe(false);
    expect(matchCompleteKey(event({ metaKey: true }))).toBe(false);
    expect(matchCompleteKey(event({ shiftKey: true }))).toBe(false);
  });

  it("ignores another key entirely", () => {
    expect(matchCompleteKey(event({ key: "a", code: "KeyA" }))).toBe(false);
  });
});
