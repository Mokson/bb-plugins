import { afterEach, beforeEach, expect, test } from "vitest";
import { buildAuditPack } from "../src/audit/pack.js";
import { TOOL_RESULT_LIMIT, clampToolResult } from "../src/server.js";
import { TempDatabase } from "./fakes.js";

let temp!: TempDatabase;
beforeEach(() => {
  temp = new TempDatabase();
});
afterEach(() => temp.dispose());

test("the audit pack stays under the tool cap on a noisy run", () => {
  const store = temp.open();
  store.upsertThread({
    thread_id: "t1",
    run_folder: "/tmp/run",
    seat: "implementer",
  });
  for (let index = 0; index < 200; index += 1) {
    store.upsertTurn({
      thread_id: "t1",
      turn_id: `u${index}`,
      completed_at: `2026-09-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      cost_usd: 0.5,
      input_tokens: 5_000,
      output_tokens: 900,
      tool_calls: 12,
      error_category: `provider-error-${index}`,
      model_reported: `model-${index}`,
    });
    store.upsertItem({
      item_id: `i${index}`,
      thread_id: "t1",
      kind: "fileChange",
      seq: index,
      path: `/Users/someone/a/very/long/path/that/keeps/going/file-${index}.ts`,
    });
  }

  const pack = buildAuditPack({ db: store.db, store }, { threadId: "t1" });
  const serialized = clampToolResult(pack);

  expect(serialized.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
  // Bounded by construction, not by truncation: the result must still parse.
  expect(JSON.parse(serialized)).toMatchObject({ threadId: "t1" });
});
