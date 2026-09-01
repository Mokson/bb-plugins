# Observatory

Cost, cache, stall, context, audit, eval and distillery for bb agent runs. One
ingestion core feeds seven modules:

- **core** — normalises bb thread, turn and item events into one ledger and
  joins them to the provider session logs on disk.
- **spend** — cost and cache accounting, cache-miss classification, and the
  `COST.md` the deliver stack consumes.
- **watch** — stall rules, an agent-tree budget, and a steer ladder that
  records every action before it sends one. It never stops a thread.
- **context** — instruction, skill and MCP composition audit with a token
  estimate calibrated against the first turn's cache write.
- **audit** — session metrics, verification detection, a failure ledger, and
  the audit pack the `harness-audit` skill reads.
- **eval** — regression cases for the deliver skill stack, run as hidden
  threads on a fixture repo against pinned baselines.
- **distillery** — mines corrections out of run ledgers into reviewable
  improvement drafts. It writes drafts, never skills.

## Status

Phase 0 scaffold: the module registry, the ledger schema, the status and
doctor commands, and the panel shell. No module does work yet.

## Install

```sh
bb plugin install git:https://github.com/Mokson/bb-plugins \
  --subdirectory plugins/observatory
```

Then `bb observatory status` and `bb observatory doctor`.
