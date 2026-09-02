# Observatory phase 1 - QA test plan

Head: `feat/observatory` @ 5701c88. Surface: bb at http://127.0.0.1:38886/.
Oracles: PRODUCT.md invariants 1-20/27/33/34, acceptance c2-c5/c16, and
read-only sqlite against `~/.bb/plugins/observatory/data.db`.

## Assumptions

- A1: c4 ("fresh deliver run") is graded on turns started in the last 24 h and
  on the two threads spawned by this run, not on the whole historical ledger.
- A2: `--` and `n/a` are the same rendering commitment (invariant 2) in the
  panel and the CLI respectively.
- A3: The plugin is continuously re-installed by sibling seats. Every row was
  executed only after re-installing from this repo path and confirming
  `bb plugin list` names it.

## Matrix

| ID | Journey | Origin | Oracle | Expected | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | Cost overview shows four hero numbers | requirement (34) | machine | exactly 4 hero figures at 24px | Pass |
| R2 | Lineage tree expands and collapses | requirement (33) | machine | row count and aria-expanded both toggle | Pass |
| R3 | Model group tab | requirement (20) | machine | rows regroup by model | Pass |
| R4 | Day group tab | requirement (20) | machine | rows regroup by day | Pass |
| R5 | Range switch changes rows | requirement | machine | 1d totals differ from 7d | Pass |
| R6 | Export MD produces content | requirement (34) | machine | download with header + table | Pass |
| R7 | Export JSON produces content | requirement (34) | machine | download blob, named file | Pass |
| R8 | `--` for unknown cache split | requirement (2) | machine | never `0`, never a guess | Pass |
| R9 | Superscript `e` for estimated | requirement (27) | machine | marker present and discriminating | Pass |
| R10 | No emojis | requirement (34) | machine | zero pictographic chars | Pass |
| R11 | Numerics right-aligned, tabular | requirement (34) | machine | all numeric cells right-aligned | Pass |
| R12 | One font | requirement (34) | machine | one family across the panel | Pass |
| R13 | Row height 24px, radii <= 4px | requirement (34) | machine | 24px rows, max radius 4 | Pass |
| R14 | Font sizes limited to 11/13/16/24 | requirement (34) | machine | no other size | Fail (Low) |
| R15 | Cache drilldown from the misses list | requirement (18) | machine | cause, correlates, drop, retained, est usd | Pass |
| R16 | acp-cursor no-transcript line | requirement | eyes | explicit no-transcript line | Not run |
| R17 | Thread Cost tab + sparkline + spike click | requirement (33/34) | eyes | sparkline renders, spike opens drilldown | Not run |
| R18 | Footer strip: limits + today's spend | requirement c5 | machine | limits plus a non-zero spend chip | Pass |
| R19 | `bb observatory status` | requirement (14) | machine | modules, counts, settings | Pass |
| R20 | `bb observatory doctor` | requirement (15) | machine | missing root warns, exit 0 | Pass |
| R21 | `bb observatory coverage` | requirement c4 | machine | split coverage, ACP reported separately | Fail |
| R22 | `cost --range 7d --json` | requirement c2 | machine | totals + rows | Pass |
| R23 | `cost --tree <root>` | requirement c2 | machine | priced rows with a cache split | Pass |
| R24 | `cache-misses --range 7d` | requirement (18) | machine | miss rows with cause | Pass |
| R25 | `cost-md <runFolder> --stdout` | requirement c3/(8) | machine | exact retro schema shape | Fail |
| R26 | Panel totals == CLI json, same range | requirement c16 | machine | agree exactly | Pass |
| R27 | c4 split coverage > 90% (CC + Codex) | requirement c4 | machine | > 90% log-exact | Fail |
| R28 | Live ingestion: priced row + split in 60 s | requirement c4 | machine | priced, split log-exact/log-window | Fail |
| R29 | `observatory_cost` agent tool exists, < 4096 chars | requirement (33) | machine | compact JSON under the cap | Pass |
| R30 | Invariant 12: missing price never `$0.00` | requirement (12) | machine | `unpriceable`/`unknown`, not 0 | Fail |
| R31 | Invariant 2: no fabricated split in the DB | code | machine | 0 rows with unavailable + non-null split | Pass |
| R32 | Invariant 3: split_source domain | code | machine | only the four allowed values | Pass |
| R33 | URL owns filters, URL wins over KV | requirement (33) | machine | URL tracks the filter and wins | Fail |
| R34 | Unknown subcommand exits non-zero | adversarial | machine | non-zero exit | Pass |
| R35 | Status banner names the shipped phase | adversarial | machine | not "phase 0 scaffold" | Fail (Low) |
| R36 | Panel vs sqlite obs_turn cross-check | requirement c16 | machine | panel matches ledger rows | Pass |
| R37 | Raw `bb thread log` vs obs_turn tokens | requirement c16 | machine | token sums agree | Not run |

Totals: 37 rows - 24 Pass, 8 Fail, 5 Not run.
