import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The `@/*` alias the vendored shadcn components import through. tsconfig
// paths are a typechecker concern; vitest needs it here too.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/app", import.meta.url)) },
  },
  test: {
    name: "bb-plugin-observatory",
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    env: { TZ: "UTC" },
  },
});
