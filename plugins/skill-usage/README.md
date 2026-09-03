# skill-usage

Which skills a BB thread actually invoked, in the thread right panel, with
project-wide and global rollups.

![Thread scope](../../docs/skill-usage/skills-thread.png)

## What it shows

A segmented switcher over three scopes.

**Thread** lists every `Skill` tool call in the open thread, in invocation
order, with a status dot and the time. A row expands in place to show the
arguments, the terminal status, and the result string. Thread scope reads
thread events directly, so it is never a refresh behind, and it stays live
through a server-held wait: a skill appears as the agent invokes it.

**Project** and **All** list one row per skill with its total, its failure
count, and how long ago it was last used. Expanding a row names the threads
that used the skill; clicking a thread navigates there.

![Global rollup](../../docs/skill-usage/skills-all.png)

## What counts as a used skill

A `Skill` tool call in the thread event stream: `item_kind` `toolCall`,
`data.item.tool` `Skill`. The `item/started` and `item/completed` rows are
collapsed into one invocation, so the list shows invocations, not events.
Failures, such as `Unknown skill: qa`, are flagged rather than hidden.

Skills preloaded by a slash command or a hook are **not** listed. They leave
no event of their own — they appear only as an `<inline_skills>` tag in the
user message, which lists what was *available*, not what was used.

## The rollup index

The BB SDK has no cross-thread event query: `threads.events.list` takes one
`threadId`. A project or global rollup would therefore re-walk every thread on
every open, so this plugin keeps its own sqlite index at
`<dataDir>/plugins/skill-usage/data.db`.

- Rows hold facts only. Thread titles resolve live, so a rename never rewrites
  the index.
- Each thread carries an event-sequence cursor, so a pass only reads what is
  new.
- Refresh happens when you open a rollup scope. There is no cron and no
  background service.
- The first open backfills across every thread and reports progress as it
  goes; the list fills in rather than appearing whole at the end.
- Archived and hidden threads count. Threads that no longer exist are pruned
  on each pass, so totals only ever describe threads you can still open.
- **Rebuild index** drops the table and cursors and runs a full pass again.

## Known limits

You cannot jump from a listed invocation to its place in the transcript. The
Plugin SDK exposes no API to scroll, focus, highlight, or deep-link a
transcript event: `useBbNavigate` targets threads, projects, panels and files,
and `ThreadChat` documents its internal timeline rows as deliberately not
exposed. Rows therefore expand in place instead.

Global counts depend on an index that refreshes only when you open a rollup,
so a run you never follow with a rollup open is not counted until you do.

## Development

```sh
cd plugins/skill-usage
npm install
npm run check     # typecheck, tests, build
```

`better-sqlite3` needs its native binding for the index tests; it is approved
in `allowScripts`. Use `env -u BB_CLI bb plugin build .` inside a BB thread so
the build uses the plugin's pinned toolchain.
