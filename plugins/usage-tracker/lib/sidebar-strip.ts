import {
  formatUsedPercent,
  providerStatusLabel,
  type ProviderUsage,
  type UsageSnapshot,
  type UsageWindow,
} from "./usage.ts";
import {
  normalizeCompactLimitOption,
  SIDEBAR_PROVIDER_IDS,
  type CompactLimitOption,
  type SidebarProviderId,
} from "./preferences.ts";
import { providerMark } from "./provider-marks.ts";
import {
  formatRelativeAge,
  formatResetsIn,
  formatResetsInShort,
  mergeLastKnownWindows,
  selectSidebarUsagePrimary,
  sidebarUsageDetailRows,
  sidebarUsagePrimarySelectionSummary,
  sidebarUsageShortLabel,
  type SidebarUsageDetailRow,
} from "./sidebar-usage.ts";

const ROOT_ATTRIBUTE = "data-usage-tracker-sidebar";
const CACHE_KEY = "bb:usage-tracker:sidebar:last-known";
const PREFERENCES_CACHE_KEY = "bb:usage-tracker:sidebar:enabled-providers";
const COMPACT_LIMIT_CACHE_KEY = "bb:usage-tracker:sidebar:compact-limit";
const AUTO_REFRESH_MS = 5 * 60_000;
const PREFERENCES_REFRESH_MS = 5_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DETAILS_ID_PREFIX = "usage-tracker-sidebar-details";

interface RpcEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string };
}

interface PreferencesResult {
  enabledProviderIds: SidebarProviderId[];
  compactLimit: CompactLimitOption;
}

type SidebarFocusTarget =
  | { kind: "panel" }
  | { kind: "close" }
  | { kind: "windows" }
  | { kind: "refresh" }
  | { kind: "back" }
  | { kind: "popover" }
  | null;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function providerGlyph(providerId: SidebarProviderId): SVGSVGElement {
  const mark = providerMark(providerId);
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", mark.viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (mark.fillRule !== undefined) svg.setAttribute("fill-rule", mark.fillRule);
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", mark.path);
  svg.append(path);
  return svg;
}

function refreshGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.7-2.5L20 11M4 13l2.2 4.5A7 7 0 0 0 18 15");
  svg.append(path);
  return svg;
}

function chevronGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M9 6l6 6-6 6");
  svg.append(path);
  return svg;
}

function backGlyph(): SVGSVGElement {
  const svg = chevronGlyph();
  svg.querySelector("path")?.setAttribute("d", "M15 6l-6 6 6 6");
  return svg;
}

function closeGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  const first = document.createElementNS(SVG_NAMESPACE, "path");
  first.setAttribute("d", "M7 7l10 10");
  const second = document.createElementNS(SVG_NAMESPACE, "path");
  second.setAttribute("d", "M17 7L7 17");
  svg.append(first, second);
  return svg;
}

function emptyProvider(providerId: SidebarProviderId): ProviderUsage {
  const name =
    providerId === "codex"
      ? "Codex"
      : providerId === "opencodeGo"
        ? "OpenCode Go"
        : "Claude Code";
  return {
    id: providerId,
    name,
    status: "error",
    accountEmail: null,
    planLabel: null,
    message: "Usage is loading.",
    windows: [],
  };
}

function readCachedSnapshot(): UsageSnapshot | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray((value as Partial<UsageSnapshot>).providers)
    ) {
      return null;
    }
    return value as UsageSnapshot;
  } catch {
    return null;
  }
}

function cacheSnapshot(snapshot: UsageSnapshot): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage is an optimization. The live strip still works without it.
  }
}

function isSidebarProviderId(value: unknown): value is SidebarProviderId {
  return SIDEBAR_PROVIDER_IDS.some((providerId) => providerId === value);
}

function activeSidebarFocusTarget(root: HTMLElement): SidebarFocusTarget {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  if (active.classList.contains("usage-tracker-sidebar__close")) {
    return { kind: "close" };
  }
  if (active.classList.contains("usage-tracker-sidebar__windows")) {
    return { kind: "windows" };
  }
  if (active.classList.contains("usage-tracker-sidebar__refresh")) {
    return { kind: "refresh" };
  }
  if (active.classList.contains("usage-tracker-sidebar__back")) {
    return { kind: "back" };
  }
  if (active.classList.contains("usage-tracker-sidebar__popover")) {
    return { kind: "popover" };
  }
  if (active.classList.contains("usage-tracker-sidebar__panel")) {
    return { kind: "panel" };
  }
  return null;
}

function focusSidebarTarget(
  root: HTMLElement,
  target: Exclude<SidebarFocusTarget, null>,
): boolean {
  let element: HTMLElement | null;
  switch (target.kind) {
    case "close":
      element = root.querySelector<HTMLElement>(
        ".usage-tracker-sidebar__close",
      );
      break;
    case "windows":
      element = root.querySelector<HTMLElement>(
        ".usage-tracker-sidebar__windows",
      );
      break;
    case "refresh":
      element = root.querySelector<HTMLElement>(
        ".usage-tracker-sidebar__refresh",
      );
      break;
    case "back":
      element = root.querySelector<HTMLElement>(
        ".usage-tracker-sidebar__back",
      );
      break;
    case "panel":
      element = root.querySelector<HTMLElement>(
        ".usage-tracker-sidebar__panel",
      );
      break;
    case "popover":
      element = root.querySelector<HTMLElement>(
        ".usage-tracker-sidebar__popover",
      );
      break;
  }
  element?.focus({ preventScroll: true });
  return element !== null && document.activeElement === element;
}

function readCachedProviderIds(): SidebarProviderId[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PREFERENCES_CACHE_KEY) ?? "null",
    );
    if (
      !Array.isArray(value) ||
      value.some((providerId) => !isSidebarProviderId(providerId)) ||
      new Set(value).size !== value.length
    ) {
      return [...SIDEBAR_PROVIDER_IDS];
    }
    return SIDEBAR_PROVIDER_IDS.filter((providerId) =>
      value.includes(providerId),
    );
  } catch {
    return [...SIDEBAR_PROVIDER_IDS];
  }
}

function cacheProviderIds(providerIds: readonly SidebarProviderId[]): void {
  try {
    localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify(providerIds));
  } catch {
    // Storage is an optimization. Preferences are still refreshed live.
  }
}

function readCachedCompactLimit(): CompactLimitOption {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(COMPACT_LIMIT_CACHE_KEY) ?? "null",
    );
    return normalizeCompactLimitOption(value);
  } catch {
    return "Weekly";
  }
}

function cacheCompactLimit(compactLimit: CompactLimitOption): void {
  try {
    localStorage.setItem(COMPACT_LIMIT_CACHE_KEY, JSON.stringify(compactLimit));
  } catch {
    // Storage is an optimization. Preferences are still refreshed live.
  }
}

function mergeSnapshot(
  current: UsageSnapshot,
  previous: UsageSnapshot | null,
): UsageSnapshot {
  return {
    ...current,
    providers: current.providers.map((provider) =>
      mergeLastKnownWindows(
        provider,
        previous?.providers.find((candidate) => candidate.id === provider.id),
      ),
    ),
  };
}

function progressRail(window: UsageWindow | null): HTMLSpanElement {
  const rail = element("span", "usage-tracker-sidebar__rail");
  const fill = element("span", "usage-tracker-sidebar__fill");
  fill.style.width = `${window?.barPercent ?? 0}%`;
  if (window === null) rail.dataset.empty = "true";
  rail.append(fill);
  return rail;
}

function detailWindowRow(
  label: string,
  window: UsageWindow | null,
  now: Date,
): HTMLDivElement {
  const row = element("div", "usage-tracker-sidebar__window");
  const heading = element("div", "usage-tracker-sidebar__window-heading");
  heading.append(
    element("span", undefined, label),
    element(
      "strong",
      undefined,
      window === null ? "—" : `${formatUsedPercent(window.usedPercent)}%`,
    ),
  );
  row.append(heading, progressRail(window));
  row.append(
    element(
      "span",
      "usage-tracker-sidebar__reset",
      window === null
        ? "No limit reported"
        : formatResetsIn(window.resetsAt, now),
    ),
  );
  return row;
}

function miniWindowStat(
  row: SidebarUsageDetailRow,
): HTMLSpanElement {
  const stat = element("span", "usage-tracker-sidebar__mini");
  const statRow = element("span", "usage-tracker-sidebar__mini-row");
  statRow.append(
    element("span", "usage-tracker-sidebar__mini-label", sidebarUsageShortLabel(row.label)),
  );
  statRow.append(progressRail(row.window));
  statRow.append(
    element(
      "span",
      "usage-tracker-sidebar__mini-value",
      row.window === null
        ? "—"
        : `${formatUsedPercent(row.window.usedPercent)}%`,
    ),
  );
  stat.append(statRow);
  return stat;
}

function usagePopover(args: {
  provider: ProviderUsage | null;
  providers: ProviderUsage[];
  columnCount: number;
  fetchedAt: string | null;
  now: Date;
  detailOpen: boolean;
  onOpenDetail: (providerId: SidebarProviderId) => void;
  onBack: () => void;
  onClose: () => void;
  refresh: HTMLButtonElement;
}): HTMLDivElement {
  const card = element("div", "usage-tracker-sidebar__popover");
  card.id = `${DETAILS_ID_PREFIX}-all`;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Agent usage limits");
  card.tabIndex = -1;

  const header = element("div", "usage-tracker-sidebar__popover-header");
  const identity = element("div", "usage-tracker-sidebar__popover-identity");
  if (args.detailOpen && args.provider !== null) {
    const back = element("button", "usage-tracker-sidebar__back");
    back.type = "button";
    back.setAttribute("aria-label", "Back to all providers");
    back.append(backGlyph());
    back.addEventListener("click", args.onBack);
    identity.append(back);
  }
  identity.append(
    element(
      "strong",
      undefined,
      args.detailOpen && args.provider !== null ? args.provider.name : "Usage",
    ),
  );
  const close = element("button", "usage-tracker-sidebar__close");
  close.type = "button";
  close.setAttribute("aria-label", "Close usage details");
  close.append(closeGlyph());
  close.addEventListener("click", args.onClose);
  const actions = element("div", "usage-tracker-sidebar__popover-actions");
  if (!args.detailOpen) {
  }
  actions.append(
    element(
      "span",
      "usage-tracker-sidebar__popover-updated",
      `Updated ${formatRelativeAge(args.fetchedAt, args.now)}`,
    ),
    args.refresh,
    close,
  );
  header.append(identity, actions);
  card.append(header);

  const body = element("div", "usage-tracker-sidebar__popover-body");

  if (args.detailOpen && args.provider !== null) {
    const provider = args.provider;
    body.classList.add("usage-tracker-sidebar__popover-detail");
    for (const row of sidebarUsageDetailRows(provider)) {
      body.append(detailWindowRow(row.label, row.window, args.now));
    }
    if (provider.status !== "ok" && provider.message !== null) {
      const message = element(
        "p",
        "usage-tracker-sidebar__message",
        provider.message,
      );
      if (provider.windows.length > 0) message.prepend("Last known values · ");
      body.append(message);
    }
  } else {
    body.classList.add("usage-tracker-sidebar__popover-list");
    for (const provider of args.providers) {
      const row = element("button", "usage-tracker-sidebar__row");
      row.type = "button";
      row.dataset.provider = provider.id;
      row.setAttribute(
        "aria-label",
        `Open ${provider.name} usage details.`,
      );
      const heading = element("div", "usage-tracker-sidebar__row-heading");
      const mark = element("span", "usage-tracker-sidebar__details-mark");
      mark.dataset.provider = provider.id;
      mark.append(providerGlyph(provider.id as SidebarProviderId));
      heading.append(
        mark,
        element("strong", undefined, provider.name),
      );
      if (provider.status === "ok") {
        // Both headline countdowns ride next to the name: the 5-hour reset
        // first, then the weekly one.
        let firstChip = true;
        for (const [kindLabel, matcher] of [
          ["ses", /five|5[- ]hour|current session/i],
          ["wk", /week/i],
        ] as const) {
          const window = provider.windows.find((candidate) =>
            matcher.test(candidate.label),
          );
          if (window === undefined || window.resetsAt === null) continue;
          const resets = formatResetsInShort(window.resetsAt, args.now);
          if (resets === "") continue;
          if (!firstChip) {
            heading.append(
              element("span", "usage-tracker-sidebar__row-resets-divider", "·"),
            );
          }
          firstChip = false;
          heading.append(
            element(
              "span",
              "usage-tracker-sidebar__row-resets",
              `${kindLabel} ${resets}`,
            ),
          );
        }
      } else {
        heading.append(
          element(
            "span",
            "usage-tracker-sidebar__row-resets",
            providerStatusLabel(provider.status),
          ),
        );
      }
      const stats = element("div", "usage-tracker-sidebar__row-stats");
      if (provider.status === "ok") {
        // Every row carries the same column grid - as many columns as the
        // provider with the most windows - so rails line up vertically.
        const detailRows = sidebarUsageDetailRows(provider);
        for (let column = 0; column < args.columnCount; column++) {
          const detailRow = detailRows[column];
          stats.append(
            detailRow === undefined
              ? element("span", "usage-tracker-sidebar__mini")
              : miniWindowStat(detailRow),
          );
        }
      } else if (provider.message !== null) {
        stats.append(
          element("span", "usage-tracker-sidebar__row-message", provider.message),
        );
      }
      const chevron = element("span", "usage-tracker-sidebar__row-chevron");
      chevron.append(chevronGlyph());
      row.append(heading, stats, chevron);
      row.addEventListener("click", () => args.onOpenDetail(provider.id as SidebarProviderId));
      body.append(row);
    }
  }

  card.append(body);
  return card;
}

function visibleSidebarFooterMenu(): HTMLElement | null {
  const footers = Array.from(
    document.querySelectorAll<HTMLElement>('[data-sidebar="footer"]'),
  );
  const footer =
    footers.find((footer) => footer.getClientRects().length > 0) ??
    footers[0] ??
    null;
  return footer?.querySelector<HTMLElement>('[data-sidebar="menu"]') ?? null;
}

export function mountSidebarUsageStrip(signal: AbortSignal): () => void {
  let root: HTMLLIElement | null = null;
  let lastKnownSnapshot = readCachedSnapshot();
  let currentSnapshot: UsageSnapshot | null = null;
  let enabledProviderIds = readCachedProviderIds();
  let compactLimit = readCachedCompactLimit();
  let selectedProviderId: SidebarProviderId | null = null;
  let popoverOpen = false;
  let isLoading = false;
  let isLoadingPreferences = false;
  let lastError: string | null = null;
  let lastLoadedAt = 0;
  let requestController: AbortController | null = null;
  let preferencesRequestController: AbortController | null = null;
  let ensureFrame: number | null = null;
  let requestedFocus: SidebarFocusTarget = null;
  let disposed = false;

  const providerFor = (providerId: SidebarProviderId): ProviderUsage =>
    lastKnownSnapshot?.providers.find(
      (provider) => provider.id === providerId,
    ) ??
    emptyProvider(providerId);

  const refreshButton = (): HTMLButtonElement => {
    const refresh = element("button", "usage-tracker-sidebar__refresh");
    refresh.type = "button";
    refresh.setAttribute("aria-disabled", String(isLoading));
    refresh.dataset.loading = String(isLoading);
    if (lastError !== null) refresh.dataset.error = "true";
    refresh.setAttribute(
      "aria-label",
      isLoading ? "Refreshing agent usage" : "Refresh agent usage",
    );
    refresh.title = lastError ?? "Refresh agent usage";
    refresh.append(refreshGlyph());
    refresh.addEventListener("click", () => void load());
    return refresh;
  };

  const render = (): void => {
    if (root === null) return;
    const focusTarget = requestedFocus ?? activeSidebarFocusTarget(root);
    requestedFocus = null;
    const previousPopover = root.querySelector<HTMLElement>(
      ".usage-tracker-sidebar__popover",
    );
    const previousBody = root.querySelector<HTMLElement>(
      ".usage-tracker-sidebar__popover-body",
    );
    const previousScrollTop = previousPopover !== null ? (previousBody?.scrollTop ?? 0) : 0;
    root.dataset.providerCount = String(enabledProviderIds.length);
    root.hidden = enabledProviderIds.length === 0;
    if (enabledProviderIds.length === 0) {
      root.replaceChildren();
      return;
    }
    const content: Node[] = [];

    if (popoverOpen) {
      const snapshot = lastKnownSnapshot;
      const detailProvider =
        selectedProviderId === null
          ? null
          : (providerFor(selectedProviderId) ?? null);
      content.push(
        usagePopover({
          provider: detailProvider,
          providers: enabledProviderIds.map(providerFor),
          columnCount: Math.max(
            0,
            ...enabledProviderIds.map((providerId) =>
              sidebarUsageDetailRows(providerFor(providerId)).length,
            ),
          ),
          fetchedAt: snapshot?.fetchedAt ?? null,
          now: new Date(),
          detailOpen: selectedProviderId !== null,
          onOpenDetail: (providerId) => {
            selectedProviderId = providerId;
            requestedFocus = { kind: "popover" };
            render();
          },
          onBack: () => {
            selectedProviderId = null;
            requestedFocus = { kind: "popover" };
            render();
          },
          onClose: () => {
            popoverOpen = false;
            selectedProviderId = null;
            requestedFocus = { kind: "panel" };
            render();
          },
          refresh: refreshButton(),
        }),
      );
    }

    const strip = element("div", "usage-tracker-sidebar__strip");
    strip.dataset.providerCount = String(enabledProviderIds.length);
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "Agent usage limits");

    // One clickable area for the whole strip: every provider's compact
    // reading lives inside a single button that opens the generic panel.
    const panel = element("button", "usage-tracker-sidebar__panel");
    panel.type = "button";
    panel.setAttribute("aria-haspopup", "dialog");
    panel.setAttribute("aria-controls", `${DETAILS_ID_PREFIX}-all`);
    panel.setAttribute("aria-expanded", String(popoverOpen));
    panel.setAttribute("aria-label", "Agent usage limits. Open the usage panel.");
    panel.title = "Agent usage limits";
    for (const providerId of enabledProviderIds) {
      const provider = providerFor(providerId);
      const currentProvider = currentSnapshot?.providers.find(
        (candidate) => candidate.id === providerId,
      );
      const primary = selectSidebarUsagePrimary(
        currentProvider,
        provider,
        compactLimit,
      );
      const reading = element("span", "usage-tracker-sidebar__reading-group");
      const mark = element("span", "usage-tracker-sidebar__mark");
      mark.dataset.provider = providerId;
      mark.append(providerGlyph(providerId));
      const value = element(
        "span",
        "usage-tracker-sidebar__reading",
        isLoading && lastKnownSnapshot === null
          ? "…"
          : sidebarUsagePrimarySelectionSummary(primary),
      );
      reading.append(mark, progressRail(primary.window), value);
      panel.append(reading);
    }
    panel.addEventListener("click", () => {
      popoverOpen = !popoverOpen;
      requestedFocus = popoverOpen ? { kind: "popover" } : { kind: "panel" };
      render();
    });
    strip.append(panel);

    strip.append(refreshButton());
    content.push(strip);
    root.replaceChildren(...content);
    const body = root.querySelector<HTMLElement>(
      ".usage-tracker-sidebar__popover-body",
    );
    if (body !== null) body.scrollTop = previousScrollTop;
    if (focusTarget !== null) focusSidebarTarget(root, focusTarget);
  };

  const ensureMounted = (): void => {
    if (disposed) return;
    const footerMenu = visibleSidebarFooterMenu();
    if (footerMenu === null) {
      root?.remove();
      root = null;
      return;
    }
    if (root !== null && root.parentElement === footerMenu) return;
    root?.remove();
    root = element("li", "usage-tracker-sidebar");
    root.setAttribute(ROOT_ATTRIBUTE, "");
    root.setAttribute("data-sidebar", "menu-item");
    footerMenu.append(root);
    render();
  };

  const scheduleEnsureMounted = (): void => {
    if (ensureFrame !== null || disposed) return;
    ensureFrame = requestAnimationFrame(() => {
      ensureFrame = null;
      ensureMounted();
    });
  };

  const load = async (): Promise<void> => {
    if (isLoading || disposed) return;
    isLoading = true;
    lastError = null;
    render();
    requestController = new AbortController();
    const abortRequest = () => requestController?.abort();
    signal.addEventListener("abort", abortRequest, { once: true });

    try {
      const response = await fetch(
        "/api/v1/plugins/usage-tracker/rpc/getUsage",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: null }),
          credentials: "same-origin",
          signal: requestController.signal,
        },
      );
      const payload = (await response.json()) as RpcEnvelope<UsageSnapshot>;
      if (!response.ok || !payload.ok || payload.result === undefined) {
        throw new Error(payload.error?.message ?? "Usage is unavailable.");
      }
      currentSnapshot = payload.result;
      lastKnownSnapshot = mergeSnapshot(currentSnapshot, lastKnownSnapshot);
      cacheSnapshot(lastKnownSnapshot);
      lastLoadedAt = Date.now();
    } catch (error) {
      if (!requestController.signal.aborted) {
        lastError = error instanceof Error ? error.message : "Usage is unavailable.";
      }
    } finally {
      signal.removeEventListener("abort", abortRequest);
      requestController = null;
      isLoading = false;
      render();
    }
  };

  const syncPreferences = async (): Promise<void> => {
    if (isLoadingPreferences || disposed) return;
    isLoadingPreferences = true;
    preferencesRequestController = new AbortController();
    const abortRequest = () => preferencesRequestController?.abort();
    signal.addEventListener("abort", abortRequest, { once: true });

    try {
      const response = await fetch(
        "/api/v1/plugins/usage-tracker/rpc/getPreferences",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
          credentials: "same-origin",
          signal: preferencesRequestController.signal,
        },
      );
      const payload = (await response.json()) as RpcEnvelope<PreferencesResult>;
      if (!response.ok || !payload.ok || payload.result === undefined) return;

      const nextProviderIds = SIDEBAR_PROVIDER_IDS.filter((providerId) =>
        payload.result?.enabledProviderIds.includes(providerId),
      );
      const nextCompactLimit = normalizeCompactLimitOption(
        payload.result.compactLimit,
      );
      const newlyEnabled = nextProviderIds.some(
        (providerId) => !enabledProviderIds.includes(providerId),
      );
      const changed =
        nextCompactLimit !== compactLimit ||
        nextProviderIds.length !== enabledProviderIds.length ||
        nextProviderIds.some(
          (providerId, index) => providerId !== enabledProviderIds[index],
        );
      if (!changed) return;

      enabledProviderIds = nextProviderIds;
      compactLimit = nextCompactLimit;
      if (
        selectedProviderId !== null &&
        !enabledProviderIds.includes(selectedProviderId)
      ) {
        selectedProviderId = null;
        requestedFocus = { kind: "refresh" };
      }
      cacheProviderIds(enabledProviderIds);
      cacheCompactLimit(compactLimit);
      render();
      if (newlyEnabled) void load();
    } catch {
      // Keep the last-known preference while the local server reconnects.
    } finally {
      signal.removeEventListener("abort", abortRequest);
      preferencesRequestController = null;
      isLoadingPreferences = false;
    }
  };

  const observer = new MutationObserver(scheduleEnsureMounted);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureMounted();
  void load();
  void syncPreferences();

  const refreshInterval = window.setInterval(() => void load(), AUTO_REFRESH_MS);
  const preferencesRefreshInterval = window.setInterval(
    () => void syncPreferences(),
    PREFERENCES_REFRESH_MS,
  );
  const refreshIfStale = (): void => {
    void syncPreferences();
    if (Date.now() - lastLoadedAt > 60_000) void load();
  };
  window.addEventListener("focus", refreshIfStale, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) refreshIfStale();
    },
    { signal },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        popoverOpen &&
        root !== null &&
        event.target instanceof Node &&
        !root.contains(event.target)
      ) {
        popoverOpen = false;
        selectedProviderId = null;
        render();
      }
    },
    { signal },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      const active = document.activeElement;
      const belongsToUsageTracker =
        root !== null &&
        ((event.target instanceof Node && root.contains(event.target)) ||
          (active instanceof Node && root.contains(active)));
      if (
        event.key === "Escape" &&
        popoverOpen &&
        belongsToUsageTracker
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (selectedProviderId !== null) {
          selectedProviderId = null;
          requestedFocus = { kind: "popover" };
        } else {
          popoverOpen = false;
          requestedFocus = { kind: "panel" };
        }
        render();
      }
    },
    { capture: true, signal },
  );

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (ensureFrame !== null) cancelAnimationFrame(ensureFrame);
    window.clearInterval(refreshInterval);
    window.clearInterval(preferencesRefreshInterval);
    requestController?.abort();
    preferencesRequestController?.abort();
    root?.remove();
    root = null;
  };
}
