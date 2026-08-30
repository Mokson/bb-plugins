/**
 * Global setup: `vitest.config.ts` runs this for EVERY test file, including the
 * pure-model ones that deliberately run with no DOM. Nothing here may touch
 * `document` at import time — this file used to `import "@testing-library/react"`,
 * which is exactly what made it unsafe to wire globally. Files needing RTL
 * import it themselves.
 */

/**
 * jsdom ships no `IntersectionObserver`, and `useRowSignals` (slice 4) fails
 * loudly without one. Nothing here intersects, which is the correct default:
 * §7's B37-B40 ruling says a row never scrolled into view draws no signal.
 * Registering it once here keeps every DOM test from restating the same stub.
 */
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  readonly scrollMargin = "";
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver =
    NoopIntersectionObserver as unknown as typeof IntersectionObserver;
}
