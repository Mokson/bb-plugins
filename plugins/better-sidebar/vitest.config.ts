import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-better-sidebar",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    // Registers the IntersectionObserver stub once, so no DOM test has to
    // restate it. Deliberately no `environment` here: the model tests run in
    // node, and component tests opt into jsdom with a per-file docblock.
    setupFiles: ["./src/test-setup.ts"],
    // The dossier renders timestamps in the reader's own zone and locale, so
    // leaving either unpinned would make those assertions pass or fail by
    // machine. The app itself deliberately follows the reader's settings.
    env: { TZ: "UTC", LANG: "en-US", LC_ALL: "en-US" },
  },
});
