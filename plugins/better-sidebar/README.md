# bb plugin — Better Sidebar

A replacement for bb's sidebar thread list, mounted through
`app.slots.experimental_threadList`. Rows carry a second metadata line, a
provider glyph, a status glyph, and a pull request chip, so a thread's project,
branch, and state read without opening it.

![The thread list, grouped by date, with metadata rows and a PR chip](docs/thread-list.png)

## What it adds

- **Grouped sections** — threads group by date, project, host, status, or not at
  all. Each section header carries its own thread count and collapses on click.
- **A second metadata row** — the project name, the git branch, and the host the
  thread runs on, under the title.
- **A provider glyph** — the real provider mark for each thread, withheld while
  the directory still loads rather than drawn as a placeholder.
- **Status glyphs** — five row states (needs you, working, planning, draft,
  idle) plus unread, each with one glyph. Extra signals — an error, a warning, a
  paused thread, a token budget ring — sit in the row's signal cluster.
- **A pull request chip** — the PR number for a thread whose branch has one,
  linking to the pull request.
- **A hover dossier** — hovering a row opens a card with the branch, model and
  effort, created and updated timestamps, context window used, and the token
  counts split into input, cached input, output, and reasoning.
- **Child thread collapse** — a thread that spawned subagents shows them
  indented, behind one collapse control and a count chip on the parent.

## Display menu

The slider button above the list sets grouping and a project filter. Grouping
persists per device, in `localStorage`, and overrides the `groupBy` setting from
the moment you pick one. The project filter is session state: it survives no
reload.

![The display menu, with the Group by submenu open on Date, Project, Host, Status, None](docs/display-menu.png)

## Install

```sh
bb plugin install git:https://github.com/Mokson/bb-plugins --subdirectory plugins/better-sidebar --yes
```

The list replaces bb's own as soon as the plugin loads. Uninstall it to get
bb's list back.

## Settings

Open **Settings → Extensions → Plugins → Better Sidebar**.

| Setting | Default | What it does |
| --- | --- | --- |
| `groupBy` | `date` | Default section grouping: `date`, `project`, `host`, `status`, `none`. A device that picked a grouping in the display menu ignores this. |
| `density` | `default` | Row height: `compact`, `default`, `detailed`. |
| `showPrChip` | on | Draws the pull request chip on rows whose branch has a PR. |
| `showProviderGlyph` | on | Draws the provider mark. |
| `showRelativeTime` | on | Shows `2h` instead of an absolute timestamp. |
| `showArchivedChildren` | on | Keeps archived child threads under their parent. |
| `showHeaderChip` | on | Shows the child thread count chip on a parent row. |

An unset setting, a value of the wrong type, or an unrecognised enum member
falls back to the default, so a settings key this version does not read cannot
break the list.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin install . --yes
bb plugin dev
```
