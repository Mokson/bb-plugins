# Manual steer from observe mode, and record-before-send

Closes QA/phase346 finding 3 (P3-3, blocked) and re-verifies c8 live.

Decision applied: a manual steer is an explicit human action and is allowed
while `watch_mode` is `observe`. Only the automatic ladder is mode-gated.
`off` still refuses. PRODUCT.md invariant 6 now says so.

## Setup

- Plugin build installed from `plugins/observatory` before the run
  (`bb plugin install <dir> --yes`); `bb observatory status` reports
  `observatory 0.0.1 / installed /Users/mokson/Projects/Personal/bb-plugins/plugins/observatory/`.
- `watch_mode` read from `bb observatory status` at steer time: `observe`.
  Nothing was flipped globally at any point in this run.
- Thread: `thr_4i58tv49a2`, project `proj_personal`, provider `claude-code`,
  model `claude-haiku-4-5-20251001`. Spawned by this session; nothing else
  was touched.
- Script: `steer-proof.sh` in this directory (`bash steer-proof.sh <threadId>`).

## Result

```
== waiting for the ledger to see it active
  obs_thread.status=active  (07:31:59)
== watch mode (must be observe)
  watch_mode                   observe
== manual steer from observe at 2026-09-02T07:32:00.000Z
steered thr_4i58tv49a2
exit=0
```

| Fact | Source | Value |
| --- | --- | --- |
| action row written | `sqlite3 -readonly ~/.bb/plugins/observatory/data.db`, `obs_action.at` id 528 | `2026-09-02T07:32:00.437Z` |
| steer message delivered | `bb thread log thr_4i58tv49a2 --all --json`, `createdAt` of the event carrying `"QA proof: manual steer from observe mode"` | `1788334320560` = `2026-09-02T07:32:00.560Z` |

The action row precedes the send by 123 ms. c8 holds on the manual path.

Row 528 in full:

```
528|2026-09-02T07:32:00.437Z|steer|steered|manual steer by cli -> thr_4i58tv49a2
```

## Refusals recorded on the way there, and what each proves

| id | at | result | what it shows |
| --- | --- | --- | --- |
| 516 | 07:23:54.241Z | `reserved-thread` | A `--visibility hidden` thread is refused by `isReserved` (`src/watch/ladder.ts:291`), independent of mode. The packet asked for a hidden thread; watch cannot steer one by design, so the thread was promoted with `bb thread update --visibility visible` and the ledger picked that up on the next reconcile. |
| 517, 520, 527 | 07:24-07:31 | `inactive-thread` | Not a mode refusal. `observe` no longer blocks the path; these are the thread being idle. Claude Code backgrounds a long `sleep`, ending the turn immediately, so the proving task had to be streamed output (`write out every number from 1 to 5000`) to keep the thread active across the one-minute reconcile. |

No `observe-only` refusal appears anywhere after the fix, which is the point.

## Command palette (finding 2)

Not a defect. `Cmd+Shift+P` on the thread view lists
**Observatory: steer stalled thread** under Plugins - screenshot at
`../../evidence/watch-steer/palette.png`. The registration
(`src/app/app.tsx:113`) hides the row when no thread is in view
(`isAvailable: context.threadId !== null`), which is what the QA repro hit.
No code change was needed.
