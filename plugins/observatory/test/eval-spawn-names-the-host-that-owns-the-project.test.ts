// A trial runs in a git worktree the runner cut on one machine. bb refuses a
// `host` environment carrying an unmanaged path unless the request names that
// machine — "hostId is required unless workspace.type is personal" — so a
// spawn that leaves it out never reaches the agent at all, whatever the rest
// of the run does. The host is the project's, and the runner must read it off
// the project rather than hope the server picks the right one.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCasesDir } from "../src/eval/cases.js";
import { liveRun } from "../src/eval/live.js";
import { EvalStore } from "../src/eval/store.js";
import {
  FIXTURE_HOST_ID,
  FIXTURE_PROJECT_ID,
  caseYaml,
  git,
  makeGitFixture,
  stubRunnerThreads,
  writeCases,
} from "./eval-fixtures.js";
import type { GitFixture } from "./eval-fixtures.js";
import { makeHarness } from "./fakes.js";

interface SpawnRequest {
  projectId: string;
  environment: {
    type: string;
    hostId?: string;
    workspace: { type: string; path?: string };
  };
}

describe("an eval spawn names the host that owns the project", () => {
  let fixture: GitFixture;
  beforeEach(() => {
    fixture = makeGitFixture();
  });
  afterEach(() => fixture.dispose());

  it("sends the project's default source host with the unmanaged worktree", async () => {
    const host = makeHarness();
    const db = host.bb.storage.database();
    const casesDir = writeCases(fixture.root, {
      "hosted": caseYaml("hosted", fixture, { dirty: [] }),
    });
    // Two sources, and the default one is not first: a runner that grabbed
    // whichever host came back first would spawn on the wrong machine, where
    // the worktree it cut does not exist.
    const state = stubRunnerThreads(host.harness, {
      statuses: ["idle"],
      output: "done",
      projects: [
        {
          id: FIXTURE_PROJECT_ID,
          sources: [
            { hostId: "host_other", isDefault: false },
            { hostId: FIXTURE_HOST_ID, isDefault: true },
          ],
        },
      ],
    });

    await liveRun({
      bb: host.bb,
      db,
      store: new EvalStore(db),
      selected: loadCasesDir(casesDir),
      worktreeRoot: join(fixture.root, "trees"),
      artifactsRoot: join(fixture.root, "artifacts"),
      tag: "smoke",
      runId: "run-host",
      git,
      checkLedgerScript: "/bin/sh",
      run: () => ({ code: 0, stdout: '{"rows":0,"fails":0,"warns":0,"findings":[]}' }),
    });

    expect(state.spawnArgs).toHaveLength(1);
    const request = state.spawnArgs[0] as SpawnRequest;
    expect(request.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(request.environment.workspace.type).toBe("unmanaged");
    expect(request.environment.hostId).toBe(FIXTURE_HOST_ID);
  });
});
