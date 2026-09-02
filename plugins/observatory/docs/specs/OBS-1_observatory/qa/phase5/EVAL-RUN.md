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

---

## Follow-up 2026-09-02 (second pass): ingest gap closed, case still not driving the harness

Packet items 5, 6 and 7 from `qa/phase346/QA.md` follow-up. Commits `989661f`
(drain), `f02d283` (question text), `d30756b` (refine pass). Case files are
outside this repo: `~/.agents/eval/cases/*.yaml`.

### Item 5 - metrics read before ingest drained: FIXED

`obs_turn` for `thr_9rcwvqqmzn` holds `output_tokens 1738, cost_usd 0.2272413`
today, so the zeros were a read-ordering race, not a missing attribution. The
runner now awaits core's `drainThread` for its own thread before the harvest
read (`src/eval/runner.ts:445`), wired from core's ingest through
`EvalLiveDeps.drainThread`. A drain failure leaves the metrics stale rather
than failing the trial.

Regression test `test/eval-metrics-are-read-after-ingest-drains.test.ts`, proven
red against the defect (`await input.drainThread?.(...)` disabled: 1 failed,
1 passed) and green with it (2 passed).

Live confirmation across the three runs of this case:

| run | tool calls | tokens | usd |
| --- | --- | --- | --- |
| eval-2026-09-02T07-04-53-131 (before) | 8 | 0 | 0.00 |
| eval-2026-09-02T07-36-58-556 (after) | 6 | 453,034 | 0.11 |
| eval-2026-09-02T07-38-33-883 (after) | 12 | 908,839 | 0.21 |

The cost and token assertions no longer pass vacuously.

### Item 6 - text_regex could not match a provider question: FIXED

`interactionText` now includes `payload.questions[].prompt`
(`src/eval/runner.ts:118`). Test
`test/eval-answer-rules-match-the-question-text.test.ts`, red-first proven
(2 failed against the defect, 2 passed with the fix).

### Item 7 - case invocation shaping: DONE; the run still FAILS its ledger assertion

All five cases in `~/.agents/eval/cases/` were reshaped consistently. The
loader's YAML subset rejects block scalars (`yaml line N: block scalars are not
supported`), so each `invocation.text` is a single quoted line.

Shape now used, after two runs showed weaker forms do not work:

> First, read the file ~/.agents/skills/deliver/SKILL.md in full and follow it -
> it is the harness this task runs under, and skipping it fails the task. Do the
> same for ~/.agents/skills/delegate/SKILL.md before your first delegation. Then
> work autonomously per those two skills. Route: <route>. tracker:none.
> Task: <task>.

- `/deliver tracker:none ...` (original) resolves to no command; the agent read
  it as prose.
- Naming the skill the way the factory does (`prompts/deliver/deliver.md`:
  "Work autonomously per the `deliver` skill ... invoke both natively") also
  left it unloaded - run `eval-2026-09-02T07-36-58-556`, thread
  `thr_87q4wq9f5w`, 1 turn / 6 tool calls / 48s, ending in prose about a
  one-line revert. The fixture project mounts no skill root, so there is no
  `deliver` for a Skill tool to resolve; the path read has to be the first
  instruction.
- With the absolute-path read as step 1: run `eval-2026-09-02T07-38-33-883`,
  thread `thr_ky4fcxqhuw`, 1 turn / 12 tool calls / 82s / 0.21 usd.

```
FAIL    bug-route-smoke trial 1  thread thr_ky4fcxqhuw
  reason    assertions
  FAIL ledger.exists: no docs/specs/*/LEDGER.md was produced
  ok   exit_codes: npx vitest run exited 0
  ok   trace.* (turns, tool calls, tokens, cost, wall, no provider errors)
```

Exit code 1. `eval baseline promote` and `eval run --gate` were therefore NOT
run: both are gated on a passing run, and promoting this one would baseline a
failure.

### Residual: the case's target, not its invocation

The seeded defect is a one-line revert (`Math.floor` back to `roundCents`). The
agent fixes it in a single turn and reports in prose; the deliver skill's own
route selection sends work that small down its fastest path, which produces no
`docs/specs/*/LEDGER.md`. Three runs now agree on that. Closing this needs
either a fixture defect large enough to earn the full route, or a `ledger.exists`
assertion the fast path can satisfy - a change to the fixture or the assertion,
outside the invocation-text scope of this packet.
