// `--range 7d` used to audit a session named "7d": the target was found by
// scanning for the first argument without dashes, which is a flag's value as
// often as it is the target.
import { afterEach, beforeEach, expect, test } from "vitest";
import { runAuditCommand } from "../src/server.js";
import { TempDatabase } from "./fakes.js";

let temp!: TempDatabase;
beforeEach(() => {
  temp = new TempDatabase();
});
afterEach(() => temp.dispose());

function deps() {
  const store = temp.open();
  store.upsertThread({ thread_id: "thr_real", title: "a session" });
  store.upsertTurn({
    thread_id: "thr_real",
    turn_id: "u1",
    completed_at: new Date().toISOString(),
    cost_usd: 1,
    tool_calls: 2,
  });
  return () => ({ db: store.db, store });
}

test("a flag value is never mistaken for the audit target", () => {
  const listing = runAuditCommand(deps(), "audit", ["--range", "7d"]);

  expect(listing.exitCode).toBe(0);
  expect(listing.stdout).toContain("thr_real");
  expect(listing.stdout).not.toContain("# Audit: 7d");
});

test("a positional target is audited on its own", () => {
  const session = runAuditCommand(deps(), "audit", ["thr_real"]);

  expect(session.exitCode).toBe(0);
  expect(session.stdout).toContain("# Audit: thr_real");
});
