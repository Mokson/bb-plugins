# Rung-1 precision, measured before the ladder was allowed to send

Phase 3 is gated on this measurement (TECH risk register, "rung-1 steers could
interrupt healthy work"). Source: the live observe-only database at
`~/.bb/plugins/observatory/data.db`, read-only, on 2026-09-02.

## Corpus

| rule | signals | still open |
| --- | --- | --- |
| repeated-identical-tool | 85 | 73 |
| tree-budget | 81 | 81 |
| burn-no-change | 81 | 80 |
| read-edit-read | 1 | 1 |
| total | 248 | 235 |

Two corpus facts frame every number below.

1. **The corpus is a backfill, not a live watch.** 231 of the 248 signals
   opened inside one minute, `2026-09-01T22:23`, when the plugin first swept a
   database already holding 242 finished threads. Only 17 signals opened
   against a thread the sweep had been watching.
2. **Every open signal sits on a thread that is not running.** Grouping the 235
   open rows by `obs_thread.status` gives 232 `idle` and 3 `error`, and zero
   `active`. That is defect C (a finished thread never closes its signals)
   accounting for the entire open count, not a fraction of it. The open count
   is therefore not a precision signal at all; it is one bug's shadow.

## repeated-identical-tool — 0 / 15 warranted (0 percent)

Sample: the 15 most recent signals, ids 1086 to 1100.

| id | thread | repeats / window | fingerprint | thread status | warranted |
| --- | --- | --- | --- | --- | --- |
| 1100 | thr_yqjeh22gnd | 13 / 20 | 44136fa355b3 | idle | no |
| 1099 | thr_kfkqz8uxn5 | 4 / 7 | 44136fa355b3 | idle | no |
| 1098 | thr_95feekvkdb | 9 / 20 | 44136fa355b3 | idle | no |
| 1097 | thr_4jcdq8u7ey | 12 / 20 | 44136fa355b3 | idle | no |
| 1096 | thr_p9wequbwbr | 10 / 20 | 44136fa355b3 | idle | no |
| 1095 | thr_mz2vxxh7q6 | 12 / 20 | 44136fa355b3 | idle | no |
| 1094 | thr_ydvhcn7u9m | 8 / 17 | 44136fa355b3 | idle | no |
| 1093 | thr_52srkikcww | 12 / 20 | 44136fa355b3 | idle | no |
| 1092 | thr_upe84pkcjb | 9 / 17 | 44136fa355b3 | idle | no |
| 1091 | thr_5mjef2w9mb | 11 / 20 | 44136fa355b3 | idle | no |
| 1090 | thr_rkg6cmiasa | 12 / 20 | 44136fa355b3 | idle | no |
| 1089 | thr_rt5bvyqpfw | 12 / 20 | 44136fa355b3 | idle | no |
| 1088 | thr_warirw9buw | 11 / 20 | 44136fa355b3 | idle | no |
| 1087 | thr_iqapmscxe9 | 10 / 20 | 44136fa355b3 | idle | no |
| 1086 | thr_v2t4y684kq | 11 / 20 | 44136fa355b3 | idle | no |

**Every sampled signal carries the same fingerprint, on 15 different threads.**
`44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a` is
`sha256("{}")`. It is what `fingerprintArgs` returns for a `toolCall` whose
`arguments` is an empty object, and `src/core/events.ts:161` only returns null
when `arguments` is *absent*, not when it is empty. The corpus bears this out:
that one fingerprint covers 1424 items across 5 distinct tool names and 71
threads, where the next most common fingerprint covers 26.

So the rule's own claim — "repeat `search` with identical input" — is false for
every row in the sample. 1016 `search` calls with 1016 different queries are
being read as one loop. There is no true stall in the sample and no reason to
believe one is hiding in the remaining 70 rows: the anchor that produced them
does not encode input at all.

Precision: **0 percent**. Under 60, so the rule is tightened rather than steered
on.

### Tightening applied

`src/watch/rules.ts`, `repeatedTool`:

1. Items whose fingerprint is the empty-argument sentinel are excluded from the
   grouping entirely. A call whose input was never captured is not evidence
   that the input repeated. The sentinel is named `UNFINGERPRINTED` and derived
   as `sha256("{}")` at module load, so it tracks `normalizeArgs` rather than
   restating a hex string.
2. A group must also agree on the item `name`. Two different tools that happen
   to hash the same arguments (`{}` aside, `{"path":"x"}` is plausible across a
   read and a write) are not one loop.
3. The rule now requires the thread to be `active`. A finished thread's history
   cannot be stalling.

## burn-no-change — 0 / 15 warranted (0 percent)

Sample: the 15 most recent signals, ids 1032 to 1176.

| id | thread | tokens | last file change | file changes on thread | status | warranted |
| --- | --- | --- | --- | --- | --- | --- |
| 1176 | thr_mm3nywz66z | 488k | seq 5183 | 6 | idle | no |
| 1172 | thr_8sbsfc2txy | 2343k | none | 0 | idle | no |
| 1169 | thr_ectbzsrjsi | 270k | none | 0 | idle | no |
| 1168 | thr_z3635smhxk | 7620k | none | 0 | idle | no |
| 1164 | thr_mb2r3cxnbu | 2962k | seq 1728 | 28 | idle | no |
| 1136 | thr_crd7bbf2ph | 5703k | none | 0 | idle | no |
| 1129 | thr_qi4539yvda | 1680k | none | 0 | idle | no |
| 1124 | thr_ikhg694btw | 8372k | none | 0 | idle | no |
| 1122 | thr_iy48ta455u | 1921k | none | 0 | idle | no |
| 1115 | thr_e8kq8y95af | 6695k | none | 0 | idle | no |
| 1103 | thr_u68fd2hhx3 | 6027k | none | 0 | idle | no |
| 1101 | thr_i4x7ssjqir | 3236k | none | 0 | idle | no |
| 1034 | thr_pgd6gir2x5 | 295k | none | 0 | idle | no |
| 1033 | thr_tfyksx4rsw | 619k | none | 0 | idle | no |
| 1032 | thr_ssjwy6wmcf | 395k | none | 0 | idle | no |

Two independent defects, either of which alone disqualifies a steer.

1. **13 of 15 have no anchor at all.** `lastFileChangeSeq` is null, so
   "tokens since the last file change" is really "tokens this thread has ever
   spent". A research, review or QA thread that legitimately edits nothing
   crosses 150k on its first substantial turn and can never clear the rule,
   because the condition it would have to satisfy is "change a file", which is
   not its job. This is the rule firing on thread *kind*, not on thread health.
2. **None of the 15 is running.** Like the repeated-tool rule, `burnNoChange`
   never checked `snapshot.thread.status`, so it reads finished threads'
   lifetime totals. The two rows that do have a real anchor (1176, 1164) are
   both idle, and their token counts are lifetime sums across 5 and 7 turns
   rather than a burn since the anchor.

Precision: **0 percent**. Under 60, so the rule is tightened rather than steered
on.

### Tightening applied

`src/watch/rules.ts`, `burnNoChange`:

1. A null `lastFileChangeSeq` no longer fires. The rule states a fact about
   spending *since* a change; with no change there is no since, and the honest
   answer is silence.
2. The rule requires the thread to be `active`.

## tree-budget and read-edit-read

Not sampled — the packet scopes the measurement to the two rules above — but
the corpus facts apply to both. All 81 tree-budget rows and the single
read-edit-read row opened in the same backfill minute against idle threads.
`treeBudget` is a spend statement rather than a stall claim, and its subtree
bill is true whether or not the thread is running, so it keeps firing on any
status; what changes is that it escalates to the parent rather than steering
the child (item E).

## What this gates

Both measured rules land under 60 percent, so neither becomes rung-1 steerable
in this phase even after the tightening: the tightened conditions have no
precision data of their own yet, and inheriting a zero-percent rule's licence
would repeat the mistake the gate exists to prevent.

`STEER_ELIGIBLE_RULES` in `src/watch/rules.ts` therefore excludes
`repeated-identical-tool` and `burn-no-change`. They still open signals, still
render in the inbox and on the stalls page, and still record `obs_action` rows
with `result: "rule-not-steerable"` — the trail a re-measurement will read.
Re-measure against a corpus of live sweeps (not a backfill) once the tightened
rules have run for a week, and move a rule into the set when its sample clears
60 percent.

Manual steers (`bb observatory watch steer <threadId>`, the Stalls page action)
are deliberately not gated by this set: a person who has read the evidence is
the judgement the gate is standing in for.
