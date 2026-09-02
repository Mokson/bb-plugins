// bb has two doors for a pending interaction. `respond` carries a raw value
// into a PLUGIN's own form; a provider's question or permission approval is
// `resolve`d with a structured resolution, and sending the plugin shape at one
// is refused with "HTTP 400: Plugin interaction expected". The runner used
// `respond` for everything, so the first real question a case asked killed the
// trial as an unanswered gate.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCasesDir } from "../src/eval/cases.js";
import { liveRun } from "../src/eval/live.js";
import { EvalStore } from "../src/eval/store.js";
import { caseYaml, git, makeGitFixture, stubRunnerThreads, writeCases } from "./eval-fixtures.js";
import type { GitFixture } from "./eval-fixtures.js";
import { makeHarness } from "./fakes.js";

describe("a runner answers each interaction through the door its kind takes", () => {
  let fixture: GitFixture;
  beforeEach(() => {
    fixture = makeGitFixture();
  });
  afterEach(() => fixture.dispose());

  it("resolves a provider question with the option its rule names", async () => {
    const host = makeHarness();
    const db = host.bb.storage.database();
    const resolved: Array<{ threadId: string; interactionId: string; resolution: unknown }> = [];
    const responded: string[] = [];

    stubRunnerThreads(host.harness, {
      statuses: ["active", "idle"],
      interactions: [
        [
          {
            id: "pint-1",
            status: "pending",
            payload: {
              kind: "user_question",
              title: "Which route?",
              questions: [
                {
                  id: "route",
                  allowFreeText: true,
                  options: [
                    { label: "Bug route", value: "bug" },
                    { label: "Normal route", value: "normal" },
                  ],
                },
              ],
            } as never,
          },
        ],
        [],
      ],
      output: "done",
    });
    host.harness.sdk.stub("threads.interactions.resolve", (args: never) => {
      const shaped = args as unknown as {
        threadId: string;
        interactionId: string;
        resolution: unknown;
      };
      resolved.push(shaped);
      return {};
    });
    host.harness.sdk.stub("threads.interactions.respond", (args: never) => {
      responded.push((args as unknown as { interactionId: string }).interactionId);
      return {};
    });

    const report = await liveRun({
      bb: host.bb,
      db,
      store: new EvalStore(db),
      selected: loadCasesDir(
        writeCases(fixture.root, {
          "asked": caseYaml("asked", fixture, {
            dirty: [],
            answers: [
              "  - match: {}",
              '    respond: "take the normal route"',
              "    default: { max_uses: 6 }",
            ],
          }),
        }),
      ),
      worktreeRoot: join(fixture.root, "trees"),
      artifactsRoot: join(fixture.root, "artifacts"),
      tag: "smoke",
      runId: "run-asked",
      git,
      checkLedgerScript: "/bin/sh",
      run: () => ({ code: 0, stdout: '{"rows":0,"fails":0,"warns":0,"findings":[]}' }),
    });

    // The plugin door stays shut for a provider question.
    expect(responded).toEqual([]);
    expect(resolved).toEqual([
      {
        threadId: "thr-eval",
        interactionId: "pint-1",
        resolution: { kind: "user_answer", answers: { route: { selected: ["normal"] } } },
      },
    ]);
    // And the trial is not killed for an unanswered gate.
    expect(report.outcomes[0]?.result.failReason).not.toBe("unanswered-gate");
  });
});
