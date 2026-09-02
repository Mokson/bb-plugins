import { expect, test } from "vitest";
import { detectVerification } from "../src/audit/pack.js";

function item(
  seq: number,
  kind: string,
  name: string | null = null,
  path: string | null = null,
  threadId = "t1",
) {
  return {
    thread_id: threadId,
    item_id: `${threadId}-i${seq}`,
    kind,
    name,
    path,
    seq,
    at: `2026-09-01T00:0${seq}:00.000Z`,
  };
}

test("an edit is verified by a command that comes after it, not before it", () => {
  const result = detectVerification([
    item(1, "commandExecution", "npm test"),
    item(2, "fileChange", null, "src/a.ts"),
    item(3, "fileChange", null, "src/b.ts"),
    item(4, "commandExecution", "npm run typecheck"),
    item(5, "fileChange", null, "src/c.ts"),
  ]);

  expect(result.verification.textAvailable).toBe(true);
  expect(result.verification.verificationCommands).toBe(2);
  // Edits 2 and 3 are covered by the command at 4; edit 5 has nothing after it.
  expect(result.unverifiedEdits.map((edit) => edit.path)).toEqual(["src/c.ts"]);
});

test("with no command text stored, any command is the verification boundary", () => {
  const result = detectVerification([
    item(1, "fileChange", null, "src/a.ts"),
    item(2, "commandExecution"),
    item(3, "fileChange", null, "src/b.ts"),
  ]);

  expect(result.verification.textAvailable).toBe(false);
  expect(result.verification.commands).toBe(1);
  expect(result.unverifiedEdits.map((edit) => edit.path)).toEqual(["src/b.ts"]);
});

test("a session that ran nothing leaves every edit unverified", () => {
  const result = detectVerification([
    item(1, "fileChange", null, "src/a.ts"),
    item(2, "fileChange", null, "src/b.ts"),
  ]);

  expect(result.verification.commands).toBe(0);
  expect(result.unverifiedEdits).toHaveLength(2);
});
