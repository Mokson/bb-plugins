import { describe, expect, it } from "vitest";
import { parseSettings, SETTINGS_DEFAULTS } from "./settings";

describe("parseSettings", () => {
  it("returns every default when values is undefined (B59)", () => {
    expect(parseSettings(undefined)).toEqual({
      groupBy: "date",
      density: "default",
      showPrChip: true,
          showRelativeTime: true,
      showArchivedChildren: true,
      showHeaderChip: true,
      showSecondRow: true,
      showProjectName: true,
      showBranch: true,
      showModel: true,
    });
  });

  it("reads recognized values through", () => {
    expect(
      parseSettings({
        groupBy: "host",
        density: "compact",
        showPrChip: false,
              showRelativeTime: false,
        showArchivedChildren: false,
        showHeaderChip: false,
        showSecondRow: false,
        showProjectName: false,
        showBranch: false,
        showModel: false,
      }),
    ).toEqual({
      groupBy: "host",
      density: "compact",
      showPrChip: false,
          showRelativeTime: false,
      showArchivedChildren: false,
      showHeaderChip: false,
      showSecondRow: false,
      showProjectName: false,
      showBranch: false,
      showModel: false,
    });
  });

  it("reads the string form of a boolean through", () => {
    expect(parseSettings({ showPrChip: "false", showHeaderChip: "true" })).toEqual({
      ...SETTINGS_DEFAULTS,
      showPrChip: false,
    });
  });

  it.each([
    "groupBy",
    "density",
    "showPrChip",
    "showRelativeTime",
    "showArchivedChildren",
    "showHeaderChip",
    "showSecondRow",
    "showProjectName",
    "showBranch",
    "showModel",
  ] as const)("falls back to the default on an unknown %s value (B59.2)", (key) => {
    expect(parseSettings({ [key]: "bogus" })).toEqual(SETTINGS_DEFAULTS);
  });

  it("falls back per-field, leaving the recognized fields alone", () => {
    expect(parseSettings({ groupBy: "bogus", density: "detailed" })).toEqual({
      ...SETTINGS_DEFAULTS,
      density: "detailed",
    });
  });

  it("falls back on a wrong-typed value", () => {
    expect(
      parseSettings({
        groupBy: true as unknown as string,
        density: 3 as unknown as string,
        showPrChip: "yes",
      }),
    ).toEqual(SETTINGS_DEFAULTS);
  });

  it("ignores the removed secondRow and tooltip keys", () => {
    expect(parseSettings({ secondRow: "never", tooltip: "off" })).toEqual(
      SETTINGS_DEFAULTS,
    );
  });
});
