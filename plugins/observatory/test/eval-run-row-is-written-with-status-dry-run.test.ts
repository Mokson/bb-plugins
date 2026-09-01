// A dry run is a recorded event, not a preview that vanishes. `eval show`
// and, later, the gate both read `eval_run`, so the row has to land with a
// status that can never be mistaken for a real run's.
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCaseFile } from "../src/eval/cases.js";
import { runEvalCommand } from "../src/eval/cli.js";
import { dryRun } from "../src/eval/dryrun.js";
import { EvalStore } from "../src/eval/store.js";
import { runView, runsView } from "../src/eval/views.js";
import { TempDatabase } from "./fakes.js";
import { caseYaml, makeGitFixture, writeCases } from "./eval-fixtures.js";

const fixture = makeGitFixture();
const temp = new TempDatabase();
afterAll(() => {
  fixture.dispose();
  temp.dispose();
});

function loadOne(name: string) {
  const dir = writeCases(fixture.root, { [name]: caseYaml(name, fixture) });
  const loaded = loadCaseFile(join(dir, `${name}.yaml`));
  expect(loaded.error).toBeNull();
  return { loaded, dir };
}

describe("an eval_run row is written with status dry-run", () => {
  it("records the id, tag, stack sha and the selected case names", () => {
    const store = new EvalStore(temp.openDatabase());
    const { loaded } = loadOne("recorded");
    const report = dryRun({
      store,
      selected: [loaded],
      tag: "smoke",
      worktreeRoot: join(fixture.root, "recorded-root"),
      runId: "run-recorded",
      now: () => new Date("2026-09-01T10:00:00.000Z"),
    });

    const row = store.run("run-recorded");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("dry-run");
    expect(row!.tag).toBe("smoke");
    expect(row!.started_at).toBe("2026-09-01T10:00:00.000Z");
    expect(row!.gate).toBeNull();
    // The names are FROZEN here: editing the case file afterwards must not
    // change what this run claims it covered.
    expect(JSON.parse(row!.cases_json!)).toEqual(["recorded"]);
    expect(report.stackSha).toBe(row!.stack_sha);
  });

  it("serves that row back through the run views and `eval show`", () => {
    const database = temp.openDatabase();
    const store = new EvalStore(database);
    const { loaded, dir } = loadOne("served");
    dryRun({
      store,
      selected: [loaded],
      worktreeRoot: join(fixture.root, "served-root"),
      runId: "run-served",
    });

    const deps = { store, casesDir: dir };
    expect(runsView(deps, 10).runs.map((run) => run.id)).toContain("run-served");
    const view = runView(deps, "run-served");
    expect(view.run?.status).toBe("dry-run");
    // No trials ran, so no case results exist. An empty list, never a fake row.
    expect(view.results).toEqual([]);

    const shown = runEvalCommand(deps, ["show", "run-served"], undefined);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("status dry-run");
    expect(shown.stdout).toContain("no case results recorded");
  });

  it("answers an unknown run id with exit 1 rather than an empty run", () => {
    const store = new EvalStore(temp.openDatabase());
    const result = runEvalCommand(
      { store, casesDir: fixture.root },
      ["show", "run-nope"],
      undefined,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no such run");
  });
});
