// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginProvidersState } from "@get-bb/plugin-sdk/app";
import { ROW1_ICON, ROW2_ICON } from "./row-metrics";

installTestPluginRuntime();

const { ProviderGlyph } = await import("./ProviderGlyph");
const { resetCachedMarks } = await import("./provider-cache");

type Provider = PluginProvidersState["providers"][number];

afterEach(() => {
  cleanup();
  // A ready render caches its directory (B81), and that cache outlives the
  // test that wrote it. Every case below states its own starting cache.
  window.localStorage.clear();
  resetCachedMarks();
});

/** The two fields B23-B25 turn on, over a minimal but valid `ProviderInfo`. */
function provider(overrides: Partial<Provider> & { id: string }): Provider {
  return {
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
    },
    composerActions: [],
    displayName: "Claude Code",
    logoUrl: null,
    maintenance: { health: true, installation: true, usage: true },
    pluginId: "acp-claude-code",
    ...overrides,
  } as Provider;
}

function render(
  providerId: string,
  providers: Provider[],
  props: Record<string, unknown> = {},
) {
  return renderSlot(
    { component: ProviderGlyph },
    { providerId, ...props },
    { providers: { status: "ready", providers } },
  );
}

describe("ProviderGlyph", () => {
  it("draws a neutral dot for a provider with no served logo (B24)", () => {
    const { container, getByRole } = render("acp-claude-code", [
      provider({ id: "acp-claude-code", logoUrl: null }),
    ]);

    expect(
      container.querySelector('[data-better-sidebar-provider="dot"]'),
    ).not.toBeNull();
    expect(getByRole("img").getAttribute("aria-label")).toBe("Claude Code");
  });

  it("masks a logo at bg-muted-foreground/70 when monochrome (B23, §7)", () => {
    const { container } = render("acp-codex", [
      provider({
        id: "acp-codex",
        displayName: "Codex",
        logoUrl: "/api/v1/system/providers/acp-codex/logo",
      }),
    ], { monochrome: true });

    const mask = container.querySelector('[data-better-sidebar-provider="mask"]');
    expect(mask).not.toBeNull();
    expect(mask?.getAttribute("class")).toContain("bg-muted-foreground/70");
    expect(mask?.getAttribute("style")).toContain(
      "/api/v1/system/providers/acp-codex/logo",
    );
  });

  it("masks a logo without iconTint at bg-muted-foreground/70 (B23, §7)", () => {
    const { container } = render("acp-codex", [
      provider({
        id: "acp-codex",
        displayName: "Codex",
        logoUrl: "/api/v1/system/providers/acp-codex/logo",
      }),
    ]);

    const mask = container.querySelector('[data-better-sidebar-provider="mask"]');
    expect(mask).not.toBeNull();
    expect(mask?.getAttribute("class")).toContain("bg-muted-foreground/70");
    expect(mask?.getAttribute("style")).toContain(
      "/api/v1/system/providers/acp-codex/logo",
    );
  });

  it("fills a logo with the vendor's own iconTint per theme (B23)", () => {
    const { container } = render("acp-tinted", [
      provider({
        id: "acp-tinted",
        displayName: "Tinted",
        logoUrl: "/logo.svg",
        strings: {
          expiredHint: "expired",
          installUrl: "https://example.test",
          signInHint: "sign in",
          iconTint: { light: "rgb(1, 2, 3)", dark: "rgb(4, 5, 6)" },
        },
      }),
    ]);

    expect(
      container
        .querySelector('[data-better-sidebar-provider="mask-light"]')
        ?.getAttribute("style"),
    ).toContain("rgb(1, 2, 3)");
    expect(
      container
        .querySelector('[data-better-sidebar-provider="mask-dark"]')
        ?.getAttribute("style"),
    ).toContain("rgb(4, 5, 6)");
  });

  /**
   * Provider ids are plugin-contributed, so a directory that has not caught up
   * with an installed provider is ordinary, not an error (B24-B25).
   */
  it("falls back to the raw providerId when absent from the directory (B25)", () => {
    const { container, getByRole } = render("acp-not-installed", [
      provider({ id: "acp-claude-code" }),
    ]);

    expect(getByRole("img").getAttribute("aria-label")).toBe("acp-not-installed");
    expect(
      container.querySelector('[data-better-sidebar-provider="dot"]'),
    ).not.toBeNull();
  });

  it("still renders while the directory is loading (B17)", () => {
    const { getByRole } = renderSlot(
      { component: ProviderGlyph },
      { providerId: "acp-claude-code" },
      { providers: { status: "loading", providers: [] } },
    );

    expect(getByRole("img").getAttribute("aria-label")).toBe("acp-claude-code");
  });

  /**
   * B80. The dot states "bb does not know this provider". A loading directory is
   * empty, so drawing it there says something false about every row for as long
   * as the request takes — measured at 5.97s on a real reload.
   */
  it("draws no mark at all while the directory is loading (B80)", () => {
    const { container, getByRole } = renderSlot(
      { component: ProviderGlyph },
      { providerId: "acp-claude-code" },
      { providers: { status: "loading", providers: [] } },
    );

    expect(container.querySelector("[data-better-sidebar-provider]")).toBeNull();
    // The box survives, so the row does not reflow when the logo arrives.
    // Its size is the line's shared icon size, not a number of its own.
    expect(getByRole("img").className).toContain(ROW1_ICON);
  });

  /**
   * B81. The directory is near-static and slow, so the previous answer is what
   * a reload should draw. These two cases are one story split across a cleared
   * store: write on ready, read on the next load's `loading`.
   */
  it("draws the cached logo while the directory is loading (B81)", () => {
    render("acp-codex", [
      provider({
        id: "acp-codex",
        displayName: "Codex",
        logoUrl: "/api/v1/system/providers/acp-codex/logo",
      }),
    ]);
    cleanup();
    resetCachedMarks();

    const { container, getByRole } = renderSlot(
      { component: ProviderGlyph },
      { providerId: "acp-codex" },
      { providers: { status: "loading", providers: [] } },
    );

    expect(
      container
        .querySelector('[data-better-sidebar-provider="mask"]')
        ?.getAttribute("style"),
    ).toContain("/api/v1/system/providers/acp-codex/logo");
    expect(getByRole("img").getAttribute("aria-label")).toBe("Codex");
  });

  /** A live answer overrides the cache, so an uninstalled provider stops drawing. */
  it("prefers the live directory over a cached mark (B81)", () => {
    render("acp-codex", [
      provider({ id: "acp-codex", displayName: "Codex", logoUrl: "/logo.svg" }),
    ]);
    cleanup();
    resetCachedMarks();

    const { container, getByRole } = render("acp-codex", [
      provider({ id: "acp-claude-code" }),
    ]);

    expect(container.querySelector('[data-better-sidebar-provider="mask"]')).toBeNull();
    expect(getByRole("img").getAttribute("aria-label")).toBe("acp-codex");
  });

  /** An empty ready directory must not erase marks that are already drawing. */
  it("keeps the cache when the directory answers with nothing (B81)", () => {
    render("acp-codex", [
      provider({ id: "acp-codex", displayName: "Codex", logoUrl: "/logo.svg" }),
    ]);
    cleanup();
    resetCachedMarks();

    render("acp-codex", []);
    cleanup();
    resetCachedMarks();

    const { getByRole } = renderSlot(
      { component: ProviderGlyph },
      { providerId: "acp-codex" },
      { providers: { status: "loading", providers: [] } },
    );

    expect(getByRole("img").getAttribute("aria-label")).toBe("Codex");
  });

  /**
   * B80's other half: an errored directory will never answer, so "unknown
   * provider" is then true and the dot is the right mark.
   */
  it("draws the dot when the directory errored (B80)", () => {
    const { container } = renderSlot(
      { component: ProviderGlyph },
      { providerId: "acp-claude-code" },
      { providers: { status: "error", providers: [] } },
    );

    expect(
      container.querySelector('[data-better-sidebar-provider="dot"]'),
    ).not.toBeNull();
  });
});

describe("ProviderGlyph sizes", () => {
  /**
   * Each line's marks agree with each other and with that line's text: 12px
   * beside the 13px title, 10px beside row 2's `text-2xs`. The logo fills its
   * box, so the mark measures exactly the line's icon size.
   */
  it("fills its box at both sizes, so the mark measures the icon size", () => {
    for (const [size, expected] of [
      ["default", ROW1_ICON],
      ["small", ROW2_ICON],
    ] as const) {
      const { getByRole, container } = renderSlot(
        { component: ProviderGlyph },
        { providerId: "acp-claude-code", size },
        {
          providers: {
            status: "ready",
            providers: [
              provider({ id: "acp-claude-code", logoUrl: "/logo.svg" }),
            ],
          },
        },
      );

      expect(getByRole("img").className).toContain(expected);
      // The coloured logo (`logo`) when drawing brand colours, the `mask`
      // when monochrome — either way it fills the line's icon size.
      const marks = container.querySelectorAll(
        '[data-better-sidebar-provider="logo"], [data-better-sidebar-provider="mask"]',
      );
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) expect(mark.className).toContain(expected);
      cleanup();
    }
  });
});

describe("ProviderGlyph monochrome", () => {
  /**
   * Row 2 is a run of muted labels; a full-colour brand mark inside it is the
   * loudest thing on the row and pulls the eye off the words it sits among.
   */
  it("tints the logo by default and masks one untinted mark when monochrome", () => {
    const tinted = provider({
      id: "acp-claude-code",
      logoUrl: "/logo.svg",
      strings: {
        expiredHint: "expired",
        installUrl: "https://example.test",
        signInHint: "sign in",
        iconTint: { light: "rgb(1, 2, 3)", dark: "rgb(4, 5, 6)" },
      },
    });

    const colour = renderSlot(
      { component: ProviderGlyph },
      { providerId: "acp-claude-code" },
      { providers: { status: "ready", providers: [tinted] } },
    );
    // The vendor's tint: one mask per theme.
    expect(
      colour.container.querySelectorAll('[data-better-sidebar-provider^="mask-"]'),
    ).toHaveLength(2);
    cleanup();

    const mono = renderSlot(
      { component: ProviderGlyph },
      { providerId: "acp-claude-code", monochrome: true },
      { providers: { status: "ready", providers: [tinted] } },
    );
    // One mask, in the line's own colour, rather than a light/dark pair.
    expect(
      mono.container.querySelectorAll('[data-better-sidebar-provider^="mask-"]'),
    ).toHaveLength(0);
    const mask = mono.container.querySelector(
      '[data-better-sidebar-provider="mask"]',
    )!;
    expect(mask.className).toContain("bg-muted-foreground");
  });
});
