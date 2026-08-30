import { describe, expect, it } from "vitest";
import { parseSettings } from "./settings";

describe("parseSettings", () => {
  it("falls back to date/auto/rich when values is undefined", () => {
    expect(parseSettings(undefined)).toEqual({
      groupBy: "date",
      secondRow: "auto",
      tooltip: "rich",
    });
  });

  it("reads recognized values through", () => {
    expect(
      parseSettings({ groupBy: "project", secondRow: "never", tooltip: "off" }),
    ).toEqual({ groupBy: "project", secondRow: "never", tooltip: "off" });
  });

  it("falls back per-field on an unrecognized value", () => {
    expect(parseSettings({ groupBy: "bogus", secondRow: "always" })).toEqual({
      groupBy: "date",
      secondRow: "always",
      tooltip: "rich",
    });
  });

  it("falls back on a non-string value", () => {
    expect(parseSettings({ groupBy: true as unknown as string })).toEqual({
      groupBy: "date",
      secondRow: "auto",
      tooltip: "rich",
    });
  });
});
