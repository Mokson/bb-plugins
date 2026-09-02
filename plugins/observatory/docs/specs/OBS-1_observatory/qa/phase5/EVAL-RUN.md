# Phase 5 done check: eval run --tag smoke --gate exits 0

Date: 2026-09-02
Repo: /Users/mokson/Projects/Personal/bb-plugins (feat/observatory, HEAD c2dd176)
Plugin: observatory@0.0.1, source path:/Users/mokson/Projects/Personal/bb-plugins/plugins/observatory (confirmed via `bb plugin list`)

## 1. eval list / eval validate

```
$ bb observatory eval list
bug-route-smoke       ok       smoke,bug     never run
gc-dry                ok       smoke,gc      never run
normal-small-feature  ok       smoke,normal  never run
qa-plan               ok       smoke,qa      never run
review-only           ok       smoke,review  never run

$ bb observatory eval validate
ok   bug-route-smoke
ok   gc-dry
ok   normal-small-feature
ok   qa-plan
ok   review-only
5/5 valid
```

## 2. Case YAML check

/Users/mokson/.agents/eval/cases/bug-route-smoke.yaml:
- `limits.cost_ceiling_usd: 8` (<= 8, OK)
- `limits.timeout_ms: 1_800_000` (<= 2_400_000, OK)
- No edit required.

## 3. eval run --case bug-route-smoke --trials 1 (blocking)

Attempt 1:
```
$ bb observatory eval run --case bug-route-smoke --trials 1
run eval-2026-09-02T06-52-38-964  started 2026-09-02T06:52:38.964Z  finished 2026-09-02T06:52:39.032Z
stack 889b64cbab5faa19eff9389fa8082929777c904b
cases 1  trials 1

ERROR   bug-route-smoke trial 1  thread -
  metrics   0 turns  0 tool calls  0 tokens  0.00 usd  0s
  reason    spawn-failed
  detail    HTTP 400: hostId is required unless workspace.type is personal
```
Exit code 1. No thread was ever spawned (thread id `-`), so `bb thread log` evidence
is not applicable.

Diagnosis performed before retry:
- `bb machine list --json`: single connected machine `host_ifyr792afe` (maxbook).
- `bb project list --include-personal --json`: `proj_j2jgds565d` (deliver-fixture)
  exists, with default source `type: local_path`, `hostId: host_ifyr792afe`,
  `path: /Users/mokson/fixtures/deliver-fixture`. So the project/fixture referenced
  by the case is real and has a resolvable host; the eval runner is failing to pass
  that hostId through to its `threads.spawn` call before the workspace/environment
  is created (the runner is treating the workspace as `type: personal` and omitting
  hostId, but the target project is a standard, non-personal project).

Attempt 2 (retry, no changes made):
```
$ bb observatory eval run --case bug-route-smoke --trials 1
run eval-2026-09-02T06-53-03-165  started 2026-09-02T06:53:03.165Z  finished 2026-09-02T06:53:03.251Z
stack 889b64cbab5faa19eff9389fa8082929777c904b
cases 1  trials 1

ERROR   bug-route-smoke trial 1  thread -
  metrics   0 turns  0 tool calls  0 tokens  0.00 usd  0s
  reason    spawn-failed
  detail    HTTP 400: hostId is required unless workspace.type is personal
```
Same failure, same exit code. Two failed attempts reached; stopping per packet
instruction. Baseline promote and gated run (steps 4-5) were not attempted since
step 3 never produced a passing run.

## Verdict

**FAIL** - done check "eval run --tag smoke --gate exits 0 on the current stack" is
NOT MET. `bb observatory eval run --case bug-route-smoke --trials 1` fails at
spawn time with `HTTP 400: hostId is required unless workspace.type is personal`
before any agent turn runs (0 turns, 0 tool calls, $0.00, spawn-failed). This
appears to be a bug in the observatory eval runner's workspace/host resolution
for non-personal fixture projects, not a case-config or environment problem -
report-only scope means no source fix was attempted.

Run id: eval-2026-09-02T06-53-03-165 (latest attempt)
Thread id: none (spawn never succeeded)
Per-assertion outcomes: not evaluated (run never started)
Cost: $0.00 / Wall: 0s (spawn-failed immediately both attempts)

---

## Follow-up 2026-09-02: two runner defects fixed, smoke run reaches assertions

Both defects were fixed under commits `5e2fdac` and `5baa01e`, each with a
regression test proven red against the defect and green with the fix.

### Defect 1 - spawn omitted the host (`5e2fdac`)

`src/eval/runner.ts` spawned the trial with `environment: {type: "host",
workspace: {type: "unmanaged", path}}` and no `hostId`. bb refuses that shape
unless the workspace is `personal`, so every project-backed case died at
HTTP 400 before the agent ran. The runner now reads the host off the project's
default source (`bb.sdk.projects.list`) and names it in the spawn.

### Defect 2 - provider questions answered through the plugin door (`5baa01e`)

With the host fixed, run `eval-2026-09-02T06-59-00-337` (thread
`thr_w7pdaadq5h`) spawned and ran, then died at the first question:

```
  reason    unanswered-gate
  detail    could not answer "pint_fp8cqt54j2": HTTP 400: Plugin interaction expected
```

The runner sent every interaction to `interactions.respond`, which is the
plugin-form door. A provider question or approval must go to
`interactions.resolve` with a structured resolution (`{kind: "user_answer",
answers}` / `{decision: "allow_once"}`). Fixed and dispatched by payload kind;
a question's rule text now selects the option it names, or the first one.

### Smoke run after both fixes

```
run eval-2026-09-02T07-04-53-131  started 07:04:53.131Z  finished 07:05:37.535Z
stack 889b64cbab5faa19eff9389fa8082929777c904b

FAIL    bug-route-smoke trial 1  thread thr_9rcwvqqmzn
  metrics   1 turns  8 tool calls  0 tokens  0.00 usd  43s
  artifacts /Users/mokson/.bb/plugins/observatory/eval-artifacts/eval-2026-09-02T07-04-53-131/bug-route-smoke-1
  reason    assertions
  detail    no docs/specs/*/LEDGER.md in the worktree
  FAIL ledger.exists: no docs/specs/*/LEDGER.md was produced
  ok   exit_codes: npx vitest run exited 0
  ok   trace.max_turns: 1 <= 400
  ok   trace.max_tool_calls: 8 <= 800
  ok   trace.max_tokens: 0 <= 4000000
  ok   trace.max_cost_usd: 0 usd <= 8 usd
  ok   trace.max_wall_ms: 43436ms <= 1800000ms
  ok   trace.no_provider_errors: none
```

The harness itself now works end to end: it cut the worktree, spawned on
`host_ifyr792afe`, ran the agent, harvested, and graded. The remaining FAIL is
the case's own expectation, not the runner. The agent fixed the seeded bug
directly and reported it in prose:

> the failing rounding test is fixed [...] Reverting it restored the file to
> match HEAD exactly, so there's nothing to commit or PR; lint, typecheck, and
> all 9 tests (`npm test`) now pass.

It never entered the deliver harness, so no `docs/specs/*/LEDGER.md` exists to
assert on. That is a case-shaping question (the invocation does not force the
harness) rather than an eval-runner defect.

Baseline promote and the `--gate` run were NOT attempted: both are gated on a
passing run, and this run fails its ledger assertion.

### Open observations

- Metrics read `0 tokens` and `0.00 usd` for a thread that ran 8 tool calls.
  Every cost/token budget assertion therefore passes vacuously. Likely an
  ingest-watermark race between the trial finishing and `treeMetrics` reading,
  or a hidden-thread ingest gap; not investigated further.
- A rule's `text_regex` is tested against `payload.title` plus `payload.data`
  only. A provider `user_question` carries neither - its text lives in
  `payload.questions[].prompt` - so only a catch-all `match: {}` rule can ever
  match a real question.

Run ids: eval-2026-09-02T06-59-00-337 (interaction defect),
eval-2026-09-02T07-04-53-131 (post-fix). Thread ids: thr_w7pdaadq5h,
thr_9rcwvqqmzn. Cost: 0.00 usd reported (see observation above). Wall: 43s.
Gate exit code: not run.
