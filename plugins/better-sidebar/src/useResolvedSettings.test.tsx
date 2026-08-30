// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useResolvedSettings } from "./useResolvedSettings";
import { SETTINGS_DEFAULTS } from "./settings";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function Probe({ values }: { values: Record<string, string | boolean> | undefined }) {
  const settings = useResolvedSettings(values);
  return <span data-testid="out">{`${settings.density}|${settings.showPrChip}`}</span>;
}

const out = () => screen.getByTestId("out").textContent;

describe("useResolvedSettings (B83)", () => {
  it("returns the defaults with nothing live and nothing cached", () => {
    render(<Probe values={undefined} />);

    expect(out()).toBe(`${SETTINGS_DEFAULTS.density}|${SETTINGS_DEFAULTS.showPrChip}`);
  });

  it("draws the cached answer while the host's settings are still loading", () => {
    render(<Probe values={{ density: "detailed", showPrChip: false }} />);
    cleanup();

    render(<Probe values={undefined} />);

    expect(out()).toBe("detailed|false");
  });

  it("prefers a live answer over the cache", () => {
    render(<Probe values={{ density: "detailed", showPrChip: false }} />);
    cleanup();

    render(<Probe values={{ density: "compact", showPrChip: true }} />);

    expect(out()).toBe("compact|true");
  });

  it("falls back to the defaults when the store holds a corrupt value", () => {
    window.localStorage.setItem("better-sidebar:settings", "{ not json");

    render(<Probe values={undefined} />);

    expect(out()).toBe(`${SETTINGS_DEFAULTS.density}|${SETTINGS_DEFAULTS.showPrChip}`);
  });
});
