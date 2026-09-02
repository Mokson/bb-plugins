# TESTPLAN — Observatory Phase 3/4/6 QA

Spec: plugins/observatory/docs/specs/OBS-1_observatory/{PRODUCT,TECH}.md (packet's stated
`docs/specs/OBS-1_observatory/` path does not exist at repo root; corrected to the actual
location under `plugins/observatory/`).
Repo: bb-plugins, branch feat/observatory, HEAD c2dd176.

All rows origin=`requirement` (from packet objective), oracle=machine unless noted `eyes`.

## Phase 3 — watch/steer

| ID | Check | Expected | Status |
|---|---|---|---|
| P3-1 | watch_mode default | `observe` in `bb observatory status` and Settings radio | Pass |
| P3-2 | obs_action pre-test | zero steer/escalate rows | Pass |
| P3-3 | manual steer via `bb observatory watch steer <id>` on hidden thread, no global switch | obs_action row precedes send in thread log | Blocked — contradiction |
| P3-4 | Stalls page steer/escalate confirmation | one-line confirmation renders | Not run — no live stalled thread |
| P3-5 | caps/quiet hours documented in settings | visible on Settings page | Pass |
| P3-6 | command palette "Steer stalled thread" | command exists | **Fail** |
| P3-7 | F1: signal closes when thread goes idle | closed_at set on idle | Not run — no open signal+idle pairing live |
| P3-8 | F3: trajectory page no "No rule fired" above fired rows | never renders above fired rows | Pass (code + regression test) |

## Phase 4 — context/audit

| ID | Check | Expected | Status |
|---|---|---|---|
| P4-1 | `context --cwd` total not constant across cwds; calibration footnote names provider/factor/error | varies, footnote present | Pass |
| P4-2 | Context page composition bar/tables/compaction line | renders | Not run — route not exercised (budget) |
| P4-3 | AGENTS.md vs CLAUDE.md duplicate reported | duplicateOf cross-reference | Pass |
| P4-4 | audit sessions list/detail vs 7d median | metrics with median/delta | Pass |
| P4-5 | failures table with mute control | renders | Not run |
| P4-6 | insights facets with rule link into watch settings | renders | Not run |
| P4-7 | `audit <threadId> --export` writes only audit.json/audit.md/COST.md in run folder | exactly 3 files | Pass |
| P4-8 | `observatory_audit_pack` RPC <4096 chars | responds | **Fail — method not found** |

## Phase 6 — distillery

| ID | Check | Expected | Status |
|---|---|---|---|
| P6-1 | `distill list`/`show` | list works; show untestable (empty queue) | Partial |
| P6-2 | queue page keyboard j/k/a/e/r/s/? via ?fixture=1 | all bound, `?` sheet lists them | Pass |
| P6-3 | no draft thread spawned (did not run `distill draft`) | confirmed non-goal held | Pass |
| P6-4 | redaction: no email/home-path/tracker-id in corrections.preview_redacted | 0 matches, 517 rows, max 593 chars (<1200 cap) | Pass |
| P6-5 | apply CLI-only; skills tree hash unchanged after `distill scan` | no apply action in panel; hash stable on isolated re-run | Pass |

## Density (spot-checked: Cost, Stalls, Settings, Distillery pages)

Single font family, tabular right-aligned numerics, hairlines (no boxes), no emojis, no
color-coded hierarchy observed on all captured screenshots. Not exhaustively checked across
all 12 routes (budget).
