import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-skill-usage",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    // Rollup rows render "last used" timestamps in the reader's own zone and
    // locale, so both are pinned here to keep those assertions machine
    // independent. The panel itself follows the reader's settings.
    env: { TZ: "UTC", LANG: "en-US", LC_ALL: "en-US" },
  },
});
