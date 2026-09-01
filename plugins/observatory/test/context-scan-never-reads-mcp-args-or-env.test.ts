import { afterEach, beforeEach, expect, test } from "vitest";
import { mcpBlocksFromConfig, scanSurfaces } from "../src/context/scan.js";
import { TempTree } from "./context-fixtures.js";

let tree!: TempTree;
beforeEach(() => {
  tree = new TempTree();
});
afterEach(() => tree.dispose());

const SECRET = "sk-live-do-not-read-this";

test("the mcp scan never reads a server's args or env", () => {
  const config = JSON.stringify({
    mcpServers: {
      linear: {
        command: "/usr/local/bin/linear-mcp",
        args: ["--token", SECRET],
        env: { LINEAR_TOKEN: SECRET },
        tools: ["create_issue", "list_issues"],
      },
    },
  });
  const blocks = mcpBlocksFromConfig(config, "/tmp/.mcp.json");

  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.name).toBe("linear");
  // The billed thing is the tool surface, so the count survives; nothing that
  // launches the server does.
  expect(blocks[0]?.text).toContain("2 tools");
  expect(JSON.stringify(blocks)).not.toContain(SECRET);
  expect(JSON.stringify(blocks)).not.toContain("linear-mcp");
});

test("a project scan carries no credential out of .mcp.json", () => {
  tree.write(
    "project/.mcp.json",
    JSON.stringify({
      mcpServers: { context7: { command: "npx", env: { KEY: SECRET } } },
    }),
  );
  const blocks = scanSurfaces({ cwd: tree.cwd, home: tree.home });

  expect(blocks.some((block) => block.name === "context7")).toBe(true);
  expect(JSON.stringify(blocks)).not.toContain(SECRET);
});
