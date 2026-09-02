// The agent tool's 4096-char contract had no call path outside a model turn,
// so nobody could check it. `--pack` and the rpc now print the same string the
// tool returns, byte for byte.
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  TOOL_RESULT_LIMIT,
  auditPackToolResult,
  runAuditCommand,
} from "../src/server.js";
import { TempDatabase } from "./fakes.js";

let temp!: TempDatabase;
beforeEach(() => {
  temp = new TempDatabase();
});
afterEach(() => temp.dispose());

function seeded() {
  const store = temp.open();
  store.upsertThread({ thread_id: "thr_real", title: "a session" });
  store.upsertTurn({
    thread_id: "thr_real",
    turn_id: "u1",
    completed_at: new Date().toISOString(),
    cost_usd: 1,
    tool_calls: 2,
  });
  return { db: store.db, store };
}

test("audit --pack prints exactly what the agent tool returns", () => {
  const resolved = seeded();

  const cli = runAuditCommand(() => resolved, "audit", ["thr_real", "--pack"]);

  expect(cli.exitCode).toBe(0);
  expect(cli.stdout).toBe(
    `${auditPackToolResult(resolved, { threadId: "thr_real" })}\n`,
  );
  const result = cli.stdout!.trimEnd();
  expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
  expect(JSON.parse(result)).toMatchObject({ threadId: "thr_real" });
});
