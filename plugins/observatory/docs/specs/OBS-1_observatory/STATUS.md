# Observatory build status

PRODUCT.md is the behaviour contract and does not move with the build. This
file records where each phase stands against it.

## Build status 2026-09-02

| Phase | Done check | Result | Evidence |
| --- | --- | --- | --- |
| 1 - core and spend | Split coverage over 90 percent of Claude Code and Codex turns on runs inside bb (success metric 1) | NOT READY at first QA on 24.6 percent coverage; fixed on `obs/fix-core` and re-measured at 75.8 percent over all turns, 91.5 percent excluding sidechains, which clears the metric on its intended population | `qa/phase1/QA.md`, `qa/phase1/TESTPLAN.md` |
| 2 - watch, observe only | c7: zero steers sent, `obs_action` holds no send rows | PASS. A looping thread was detected in 22s; zero steers sent | `qa/phase2/QA.md`, `qa/phase2/TESTPLAN.md` |
| 3 - watch, steer | Rung-1 steer precision measured on phase 2 observe-only data before enabling steer (success metric 2) | 0/15 on both candidate rules. Steer stays disabled for those two rules pending a precision re-measurement; the ladder and the manual `steer`/`escalate` paths ship | `evidence/watch-steer/PRECISION.md` |
| 4 - context | Token estimate calibrated against the first turn's cache write | PASS at 1.9 percent calibration error | `evidence/context-audit-app/` |
| 5 - audit and eval | Audit pack, failure ledger, and eval cases against pinned baselines | QA in progress | `qa/phase5/EVAL-RUN.md` |
| 6 - distillery | c14: three nudges of one cause-class yield exactly one draft. c15: apply writes only under `~/.agents/improvements/` and leaves the skill tree hash unchanged | QA in progress | `evidence/eval-distillery-app/` |

Open at this date:

- Success metric 2 (rung-1 steer precision) is unmet. The two measured rules are
  off; re-measurement needs a larger observe-only sample than phase 2 produced.
- Success metrics 3 (cost agreement within 2 percent, at integration) and 4
  (distillery draft acceptance, one month after phase 6) are not yet due.
