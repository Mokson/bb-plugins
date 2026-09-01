// The `g` prefix is the only stateful part of the keyboard map, and the one
// that can misfire minutes later if the pending state is held too long.
import { describe, expect, it } from "vitest";
import { GOTO_ROUTES, KEY_HELP, resolveKey } from "../src/app/lib/keys.js";

describe("the keyboard map", () => {
  it("arms a g sequence without doing anything itself", () => {
    expect(resolveKey("g", false)).toEqual({ action: null, pendingGoto: true });
  });

  it("routes every second key the sheet advertises", () => {
    for (const [key, route] of Object.entries(GOTO_ROUTES)) {
      expect(resolveKey(key, true)).toEqual({
        action: { kind: "navigate", route },
        pendingGoto: false,
      });
    }
  });

  it("cancels the sequence on an unknown second key rather than holding it", () => {
    expect(resolveKey("q", true)).toEqual({ action: null, pendingGoto: false });
  });

  it("resolves the single-key actions", () => {
    expect(resolveKey("/", false).action).toEqual({ kind: "focus-filter" });
    expect(resolveKey("j", false).action).toEqual({ kind: "move", delta: 1 });
    expect(resolveKey("k", false).action).toEqual({ kind: "move", delta: -1 });
    expect(resolveKey("Enter", false).action).toEqual({ kind: "activate" });
    expect(resolveKey("Escape", false).action).toEqual({ kind: "dismiss" });
    expect(resolveKey("?", false).action).toEqual({ kind: "toggle-help" });
  });

  it("ignores a key it does not own", () => {
    expect(resolveKey("z", false)).toEqual({ action: null, pendingGoto: false });
  });

  // The sheet is the only description of the map a reader gets. A route that
  // works but is undocumented is a feature nobody finds.
  it("documents every g route in the help sheet", () => {
    const documented = KEY_HELP.map((entry) => entry.keys);
    for (const key of Object.keys(GOTO_ROUTES)) {
      expect(documented).toContain(`g ${key}`);
    }
  });
});
