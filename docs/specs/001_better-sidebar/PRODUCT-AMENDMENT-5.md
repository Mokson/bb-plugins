# PRODUCT amendment 5 — entrance-order stability replaces the freeze

**Supersedes B5 and B6 entirely.** The freeze machine (`useFreeze.ts`), its tests, and
`applyFreeze` in `list-model.ts` are **deleted**, not adapted.

Prompted by `gtd-sidebar` (`smsunarto/bb-plugins`, `plugins/gtd-sidebar`), which solves
the same problem — rows must not move under you — with a different and stronger
mechanism. Reference: `lib/inbox.ts:32-100`, `reconcileActiveSectionOrder`.

## Why replace something that works

B6 froze the rendered order **while the pointer was over the list**. That is a
narrow guarantee: it only holds during a hover, it needs a state machine with
FROZEN / COOLDOWN / LIVE and a 2s timer, it required a snapshot overlay inside the
pure model, and the interaction between those two halves shipped a blocker — expanding
a subtree while frozen appended its children to the end of the list.

Entrance order gives a **stronger guarantee with less machinery**: a row holds its
position from the moment it enters a section until it leaves, pointer or no pointer.
Nothing has to detect hovering, nothing has to snapshot, and there is no second
ordering authority for the model to reconcile against.

The orchestrator recommended keeping the freeze on the grounds that it was built,
tested and just repaired. The user chose the replacement. Recorded as a deliberate
decision with the cost known.

## B68 — order within a section is entrance order

- **B68.1** (auto) Every thread carries an **entrance sequence** for the section it is
  currently in. A thread that is already in a section keeps its sequence across
  renders; a thread that arrives, or moves between sections, is assigned a new one.
- **B68.2** (auto) Sections render **newest entrant first**. A thread that just entered
  `TODAY`, `NEEDS YOU` or `DONE` appears at the top of it, and everything below holds
  its position. (gtd orders its two bands in opposite directions; we do not — one
  direction everywhere is the simpler rule, and newest-first matches what a
  recency-organised sidebar already implies.)
- **B68.3** (auto) On **first mount** the sequence is seeded from `latestAttentionAt`
  descending, with `createdAt` and then `id` as tie-breakers, so the first render is
  the same order B5 produced and is fully deterministic. After that, sequence changes
  **only** on a section entry.
- **B68.4** (auto) Order is **session state**, held in component state like the project
  filter (B64.2). It is not persisted, not in settings, not in `localStorage`. A reload
  re-seeds from B68.3 — which is a defensible order, not an arbitrary one.
- **B68.5** (auto) Reconciliation runs over the **unfiltered** thread set. Project
  scope (B64), `searchQuery` (B43) and child hiding (B10) are *presentation*; a thread
  hidden by a filter has not left its section and must not be re-sequenced. Getting
  this wrong makes clearing a filter reshuffle the list, which is the exact defect this
  replaces.
- **B68.6** (auto) A thread leaving the list entirely (archived, deleted, filtered out
  of the fed set) drops its entry. Returning is a new entrance.

## What this deletes

- `src/useFreeze.ts` and `src/useFreeze.test.tsx`.
- `applyFreeze` and every freeze-related type in `src/model/list-model.ts` and
  `src/model/types.ts`, plus their tests.
- The `FROZEN` / `COOLDOWN` / `LIVE` state machine, the 2s timer, the pointer-enter and
  pointer-leave handlers on the list, and the invalidator set.
- TECH.md §4 in its entirety, and its §7 B6 ruling.

**The lesson from the deleted code is retained and binds the replacement**: structure
comes from the live model, order comes from the sequence map, and the two never swap
roles. The blocker that shipped came from an overlay rebuilding sections out of a
row-only snapshot. `reconcileActiveSectionOrder` must never decide *which* section a
thread is in, only *where within it* — the section is the live model's answer, always.

## B69 — what did not change

- **B67**'s bands (NEEDS YOU, DONE) and **B1**'s precedence are unchanged. Entrance
  order decides position *within* a section; precedence still decides the section.
- **B53.4/B53.5** section counts stay roots-only and invariant under expand/collapse.
- **B9** child nesting is unchanged: a root subtree moves as one unit and descendants
  are never sequenced independently.
- **B43** search still flattens to one ranked section; ranking is by match, then
  entrance order.
- **B65.9** still applies — `host` and `status` are new section *keys*, and if they
  need special cases in the sequencing, the abstraction is wrong.
