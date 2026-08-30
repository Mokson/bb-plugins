import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@bb\/plugin-sdk$/,
        replacement: fileURLToPath(
          new URL("./test/plugin-sdk.ts", import.meta.url),
        ),
      },
      {
        find: /^@bb\/plugin-sdk\/app$/,
        replacement: fileURLToPath(
          new URL("./test/plugin-sdk-app.ts", import.meta.url),
        ),
      },
      {
        find: /^@\//,
        replacement: `${fileURLToPath(new URL(".", import.meta.url))}/`,
      },
    ],
  },
});
